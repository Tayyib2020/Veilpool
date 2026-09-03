import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, getAddress, hexlify, parseUnits } from "ethers";
import { createInstance, SepoliaConfig } from "../frontend/node_modules/@zama-fhe/relayer-sdk/node.js";

const CHAIN_ID = 11155111;
const OPERATOR_EXPIRY_DAYS = 7;
const EXPECTED_WRAPPER = getAddress("0xfbC3096644cc41bAa6768897c0de286F79D1578a");
const EXPECTED_VAULT = getAddress("0x6E308F5F33abbdd800883e297906dF8de6B68Bd5");
const deployment = JSON.parse(readFileSync("deployments/sepolia.json", "utf8")) as {
  contracts: Record<string, { address: string }>;
  deployer: string;
  operator: string;
};

const wrapperAbi = [
  "function isOperator(address,address) view returns (bool)",
  "function setOperator(address,uint48)",
];
const vaultAbi = [
  "function deposit(bytes32,bytes)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function confidentialWinningsOf(address) view returns (bytes32)",
  "function participantCount() view returns (uint256)",
];
const underlyingAbi = ["function decimals() view returns (uint8)"];
const engineAbi = ["function roundState() view returns (uint8)"];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function address(name: string): string {
  const value = deployment.contracts[name]?.address;
  if (!value) throw new Error(`Missing ${name} in deployment artifact`);
  return getAddress(value);
}

function errorChain(error: unknown): string {
  const rows: string[] = [];
  let current = error as { name?: string; code?: string; message?: string; cause?: unknown } | undefined;
  for (let index = 0; current && index < 8; index += 1) {
    rows.push(`${current.name ?? "Error"}${current.code ? ` [${current.code}]` : ""}: ${String(current.message ?? current).split("\n")[0].replace(/https?:\/\/[^ ]+/g, "[redacted-url]")}`);
    current = current.cause as typeof current;
  }
  return rows.join(" <- ");
}

async function wait(label: string, tx: { hash: string; wait(): Promise<unknown> }): Promise<void> {
  console.log(`A_${label}_TX=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} did not return a receipt`);
}

async function main(): Promise<void> {
  let createInstanceSucceeded = false;
  let stage = "precondition";
  try {
    const rpcUrl = requiredEnv("SEPOLIA_RPC_URL");
    const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID);
    const signer = new Wallet(requiredEnv("DEPLOYER_PRIVATE_KEY"), provider);
    const participant = getAddress(await signer.getAddress());
    if (participant !== getAddress(deployment.deployer) || participant !== getAddress(deployment.operator)) {
      throw new Error("Configured signer does not match the deployed operator/Participant A");
    }

    const wrapperAddress = address("confidentialToken");
    const vaultAddress = address("veilPool");
    if (wrapperAddress !== EXPECTED_WRAPPER) throw new Error(`Unexpected wrapper address: ${wrapperAddress}`);
    if (vaultAddress !== EXPECTED_VAULT) throw new Error(`Unexpected vault address: ${vaultAddress}`);
    console.log(`A_WRAPPER_VERIFIED=${wrapperAddress}`);
    console.log(`A_VAULT_VERIFIED=${vaultAddress}`);
    const engineAddress = address("prizeEngine");
    const wrapper = new Contract(wrapperAddress, wrapperAbi, signer);
    const vault = new Contract(vaultAddress, vaultAbi, signer);
    const underlying = new Contract(address("underlyingToken"), underlyingAbi, signer);
    const engine = new Contract(engineAddress, engineAbi, signer);

    if (await engine.roundState() !== 0n) throw new Error("Round is not OPEN");
    if (await vault.participantCount() !== 0n) throw new Error("Participant count is not zero");

    stage = "operator authorization";
    if (!(await wrapper.isOperator(participant, vaultAddress))) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_DAYS * 24 * 60 * 60);
      await wait("AUTHORIZE_VAULT", await wrapper.setOperator(vaultAddress, expiry));
    } else {
      console.log("A_AUTHORIZE_VAULT=ALREADY_AUTHORIZED");
    }

    stage = "createInstance";
    const fhe = await createInstance({ ...SepoliaConfig, network: rpcUrl, chainId: CHAIN_ID });
    createInstanceSucceeded = true;
    console.log("CREATE_INSTANCE_PASS");

    const decimals = Number(await underlying.decimals());
    const depositAmount = parseUnits("40", decimals);
    // The vault is the immediate ERC-7984 operator caller. The proof must be
    // bound to the confidential token and the vault, matching the passing
    // local ERC-7984 operator flow.
    const input = fhe.createEncryptedInput(wrapperAddress, vaultAddress);
    input.add64(depositAmount);
    stage = "encryption and proof generation";
    const encrypted = await input.encrypt();
    console.log("ENCRYPTION_AND_PROOF_PASS");

    const handle = hexlify(encrypted.handles[0]);
    const inputProof = hexlify(encrypted.inputProof);
    stage = "deposit gas estimation";
    const estimatedGas = await vault.deposit.estimateGas(handle, inputProof);
    console.log(`A_DEPOSIT_ESTIMATE_PASS=${estimatedGas.toString()}`);

    stage = "deposit transaction submission";
    await wait("DEPOSIT", await vault.deposit(handle, inputProof));
    if (await vault.participantCount() !== 1n) throw new Error("Participant count did not become one after deposit");

    async function decryptOwn(handle: string): Promise<bigint> {
      const keypair = fhe.generateKeypair();
      const startTimestamp = Math.floor(Date.now() / 1000);
      const durationDays = 1;
      const eip712 = fhe.createEIP712(keypair.publicKey, [vaultAddress], startTimestamp, durationDays);
      const signature = await signer.signTypedData(
        eip712.domain,
        { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification as unknown as Array<{ name: string; type: string }> },
        eip712.message,
      );
      const values = await fhe.userDecrypt(
        [{ handle, contractAddress: vaultAddress }],
        keypair.privateKey,
        keypair.publicKey,
        signature,
        [vaultAddress],
        participant,
        startTimestamp,
        durationDays,
      );
      const result = (values as Record<string, bigint>)[handle] ?? (values as Record<string, bigint>)[handle.toLowerCase()];
      if (result === undefined) throw new Error("User decryption returned no value");
      return BigInt(String(result));
    }

    stage = "own savings decryption";
    const savings = await decryptOwn(String(await vault.confidentialBalanceOf(participant)));
    if (savings !== depositAmount) throw new Error("Own savings decryption did not match the deposited test amount");
    console.log("OWN_SAVINGS_REVEAL_PASS");

    stage = "own winnings decryption";
    const winnings = await decryptOwn(String(await vault.confidentialWinningsOf(participant)));
    if (winnings !== 0n) throw new Error("Own winnings were non-zero before settlement");
    console.log("OWN_WINNINGS_ZERO_PASS");
    console.log("PARTICIPANT_A_CONTINUE_PASS");
  } catch (error) {
    console.error(`PARTICIPANT_A_CONTINUE_FAIL stage=${stage} createInstance=${createInstanceSucceeded ? "PASS" : "NOT_CONFIRMED"}`);
    console.error(errorChain(error));
    process.exitCode = 1;
  }
}

main();
