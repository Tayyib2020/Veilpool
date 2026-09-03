import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, getAddress, hexlify, parseUnits } from "ethers";
import { createInstance, SepoliaConfig } from "../frontend/node_modules/@zama-fhe/relayer-sdk/node.js";

const CHAIN_ID = 11155111n;
const OPERATOR_EXPIRY_DAYS = 7;
const deployment = JSON.parse(readFileSync("deployments/sepolia.json", "utf8")) as {
  contracts: Record<string, { address: string }>;
  deployer: string;
  operator: string;
};

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
];
const wrapperAbi = [
  "function wrap(address,uint256) returns (bytes32)",
  "function isOperator(address,address) view returns (bool)",
  "function setOperator(address,uint48)",
];
const vaultAbi = [
  "function deposit(bytes32,bytes)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function confidentialWinningsOf(address) view returns (bytes32)",
  "function participantCount() view returns (uint256)",
];

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

async function wait(label: string, tx: { hash: string; wait(): Promise<unknown> }): Promise<void> {
  console.log(`A_${label}_TX=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} did not return a receipt`);
}

async function encryptUint64(instance: Awaited<ReturnType<typeof createInstance>>, contractAddress: string, userAddress: string, amount: bigint) {
  const input = instance.createEncryptedInput(contractAddress, userAddress);
  input.add64(amount);
  const encrypted = await input.encrypt();
  return { handle: hexlify(encrypted.handles[0]), inputProof: hexlify(encrypted.inputProof) };
}

async function decryptOwn(
  instance: Awaited<ReturnType<typeof createInstance>>,
  signer: Wallet,
  handle: string,
  contractAddress: string,
  userAddress: string,
): Promise<bigint> {
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const eip712 = instance.createEIP712(keypair.publicKey, [contractAddress], startTimestamp, durationDays);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification as unknown as Array<{ name: string; type: string }> },
    eip712.message,
  );
  const values = await instance.userDecrypt(
    [{ handle, contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    signature,
    [contractAddress],
    userAddress,
    startTimestamp,
    durationDays,
  );
  const value = (values as Record<string, bigint>)[handle] ?? (values as Record<string, bigint>)[handle.toLowerCase()];
  if (value === undefined) throw new Error("Participant A decryption returned no value");
  return BigInt(String(value));
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnv("SEPOLIA_RPC_URL");
  const signer = new Wallet(requiredEnv("DEPLOYER_PRIVATE_KEY"), new JsonRpcProvider(rpcUrl, Number(CHAIN_ID)));
  const participant = getAddress(await signer.getAddress());
  if (participant !== getAddress(deployment.deployer) || participant !== getAddress(deployment.operator)) {
    throw new Error("Configured deployer/operator does not match Participant A deployment signer");
  }

  const underlyingAddress = address("underlyingToken");
  const wrapperAddress = address("confidentialToken");
  const vaultAddress = address("veilPool");
  const engineAddress = address("prizeEngine");
  const underlying = new Contract(underlyingAddress, erc20Abi, signer);
  const wrapper = new Contract(wrapperAddress, wrapperAbi, signer);
  const vault = new Contract(vaultAddress, vaultAbi, signer);
  const engine = new Contract(engineAddress, ["function roundState() view returns (uint8)", "function participantCount() view returns (uint256)"], signer);

  if (await engine.roundState() !== 0n) throw new Error("Participant A precondition failed: round is not OPEN");
  if (await vault.participantCount() !== 0n) throw new Error("Participant A precondition failed: participant count is not zero");

  const decimals = Number(await underlying.decimals());
  const mintAmount = parseUnits("100", decimals);
  const wrapAmount = parseUnits("60", decimals);
  const depositAmount = parseUnits("40", decimals);
  await wait("MINT", await underlying.mint(participant, mintAmount));
  if ((await underlying.balanceOf(participant)) < mintAmount) throw new Error("Participant A mint balance check failed");
  await wait("APPROVE_WRAPPER", await underlying.approve(wrapperAddress, wrapAmount));
  await wait("WRAP", await wrapper.wrap(participant, wrapAmount));
  if (!(await wrapper.isOperator(participant, vaultAddress))) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_DAYS * 24 * 60 * 60);
    await wait("AUTHORIZE_VAULT", await wrapper.setOperator(vaultAddress, expiry));
  }

  const fhe = await createInstance({ ...SepoliaConfig, network: rpcUrl, chainId: Number(CHAIN_ID) });
  const encrypted = await encryptUint64(fhe, vaultAddress, participant, depositAmount);
  await wait("DEPOSIT", await vault.deposit(encrypted.handle, encrypted.inputProof));

  const balanceHandle = String(await vault.confidentialBalanceOf(participant));
  const winningsHandle = String(await vault.confidentialWinningsOf(participant));
  const balance = await decryptOwn(fhe, signer, balanceHandle, vaultAddress, participant);
  if (balance !== depositAmount) throw new Error("Participant A savings decryption did not match the deposited test amount");
  const winnings = await decryptOwn(fhe, signer, winningsHandle, vaultAddress, participant);
  if (winnings !== 0n) throw new Error("Participant A winnings were non-zero before settlement");

  console.log("PARTICIPANT_A_PASS");
  console.log("A_OWN_SAVINGS_DECRYPTION=PASS");
  console.log("A_OWN_WINNINGS_ZERO=PASS");
  console.log(`A_PARTICIPANT_COUNT=${await vault.participantCount()}`);
}

main().catch((error: unknown) => {
  console.error(`PARTICIPANT_A_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
