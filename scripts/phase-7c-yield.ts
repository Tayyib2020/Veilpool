import { readFileSync } from "node:fs";
import { Contract, Wallet, formatUnits, getAddress, JsonRpcProvider } from "ethers";
import { createInstance, SepoliaConfig } from "../frontend/node_modules/@zama-fhe/relayer-sdk/node.js";

const CHAIN_ID = 11155111;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const EXPECTED_PRINCIPAL = 120_000_000n;
const YIELD_AMOUNT = 12_000_000n;
const PARTICIPANT_A = getAddress("0x51133dfa694940Fe4ebC785a5CE11B54f5C86048");
const PARTICIPANT_B = getAddress("0xD406De42bf35bCEf0CB82Fda509C179846b22e6C");

const deployment = JSON.parse(readFileSync("deployments/sepolia.json", "utf8")) as {
  contracts: Record<string, { address: string }>;
  deployer: string;
  operator: string;
};

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

function isNonzeroHandle(value: string): boolean {
  return value.toLowerCase() !== ZERO_BYTES32;
}

async function wait(label: string, tx: { hash: string; wait(): Promise<unknown> }): Promise<void> {
  console.log(`${label}_TX=${tx.hash}`);
  const receipt = await tx.wait() as { blockNumber?: number } | null;
  if (!receipt || receipt.blockNumber === undefined) throw new Error(`${label} did not return a receipt`);
  console.log(`${label}_CONFIRMED_BLOCK=${receipt.blockNumber}`);
}

async function publicUint(fhe: Awaited<ReturnType<typeof createInstance>>, handle: string): Promise<bigint> {
  const result = await fhe.publicDecrypt([handle]);
  const clear = Object.values(result.clearValues)[0];
  if (clear === undefined) throw new Error("public decryption returned no value");
  return BigInt(String(clear));
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnv("SEPOLIA_RPC_URL");
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID);
  const signer = new Wallet(requiredEnv("DEPLOYER_PRIVATE_KEY"), provider);
  const operator = getAddress(await signer.getAddress());
  if (operator !== getAddress(deployment.operator) || operator !== getAddress(deployment.deployer)) {
    throw new Error("Configured signer does not match the deployed operator/deployer");
  }

  const underlyingAddress = address("underlyingToken");
  const wrapperAddress = address("confidentialToken");
  const vaultAddress = address("veilPool");
  const yieldVaultAddress = address("sepoliaYieldVault");
  const adapterAddress = address("yieldAdapter");
  const engineAddress = address("prizeEngine");

  const underlying = new Contract(underlyingAddress, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function mint(address,uint256)",
  ], signer);
  const wrapper = new Contract(wrapperAddress, [
    "function isOperator(address,address) view returns (bool)",
  ], signer);
  const vault = new Contract(vaultAddress, [
    "function participantCount() view returns (uint256)",
    "function isParticipant(address) view returns (bool)",
    "function confidentialPrincipalLiability() view returns (bytes32)",
    "function preparePrincipalLiabilityReveal() returns (bytes32)",
  ], signer);
  const engine = new Contract(engineAddress, [
    "function requestPrincipalDeployment()",
    "function finalizePrincipalDeployment(uint64,bytes)",
    "function finalizePrincipalUnwrap(bytes32,uint64,bytes)",
    "function pendingPrincipalUnwrapRequest() view returns (bytes32)",
    "function principalLiabilityRevealRequested() view returns (bool)",
    "function principalUnwrapPending() view returns (bool)",
    "function confidentialPendingPrincipalLiability() view returns (bytes32)",
    "function publicPrincipalLiability() view returns (uint64)",
    "function unallocatedHarvestedYield() view returns (uint256)",
    "function roundPrizeAmount() view returns (uint256)",
    "function prizeCommitted() view returns (bool)",
    "function roundId() view returns (uint256)",
    "function roundState() view returns (uint8)",
    "function yieldAdapter() view returns (address)",
    "function harvestYield()",
  ], signer);
  const adapter = new Contract(adapterAddress, [
    "function principalDeployed() view returns (uint256)",
    "function managedAssets() view returns (uint256)",
    "function generatedYield() view returns (uint256)",
  ], signer);
  const yieldVault = new Contract(yieldVaultAddress, [
    "function totalAssets() view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function addTestYield(uint256)",
  ], signer);

  if ((await vault.participantCount()) !== 2n) throw new Error("Expected exactly two participants before yield stage");
  if (!(await vault.isParticipant(PARTICIPANT_A)) || !(await vault.isParticipant(PARTICIPANT_B))) {
    throw new Error("Expected both verified participants to remain registered");
  }
  if ((await engine.roundId()) !== 1n || (await engine.roundState()) !== 0n) {
    throw new Error("Expected round 1 OPEN before yield stage");
  }
  if (!(await wrapper.isOperator(PARTICIPANT_A, vaultAddress)) || !(await wrapper.isOperator(PARTICIPANT_B, vaultAddress))) {
    throw new Error("A participant-to-VeilPool ERC-7984 operator authorization is inactive");
  }
  console.log("PRESTATE_PASS participants=2 round=1 OPEN operator_authorizations=ACTIVE");

  const fhe = await createInstance({ ...SepoliaConfig, network: rpcUrl, chainId: CHAIN_ID });
  console.log("CREATE_INSTANCE_PASS");

  await wait("REQUEST_PRINCIPAL_DEPLOYMENT", await engine.requestPrincipalDeployment());
  if (!(await engine.principalLiabilityRevealRequested())) throw new Error("Principal reveal request flag was not set");
  const pendingLiabilityHandle = String(await engine.confidentialPendingPrincipalLiability());
  if (!isNonzeroHandle(pendingLiabilityHandle)) throw new Error("Pending principal liability handle is zero");
  const principal = await publicUint(fhe, pendingLiabilityHandle);
  console.log(`AGGREGATE_PRINCIPAL_REVEALED=${formatUnits(principal, 6)} mUNDER`);
  if (principal !== EXPECTED_PRINCIPAL) {
    throw new Error(`Aggregate principal mismatch: expected ${EXPECTED_PRINCIPAL}, observed ${principal}`);
  }

  await wait("FINALIZE_PRINCIPAL_DEPLOYMENT", await engine.finalizePrincipalDeployment(principal, (await fhe.publicDecrypt([pendingLiabilityHandle])).decryptionProof));
  const unwrapRequestId = String(await engine.pendingPrincipalUnwrapRequest());
  if (unwrapRequestId.toLowerCase() === ZERO_BYTES32) throw new Error("Expected asynchronous principal unwrap request");
  if (!(await engine.principalUnwrapPending())) throw new Error("Principal unwrap pending flag was not set");
  const unwrapAmount = await publicUint(fhe, unwrapRequestId);
  console.log(`ASYNC_UNWRAP_AMOUNT=${formatUnits(unwrapAmount, 6)} mUNDER`);
  if (unwrapAmount !== EXPECTED_PRINCIPAL) {
    throw new Error(`Unwrap amount mismatch: expected ${EXPECTED_PRINCIPAL}, observed ${unwrapAmount}`);
  }
  const unwrapProof = (await fhe.publicDecrypt([unwrapRequestId])).decryptionProof;
  await wait("FINALIZE_PRINCIPAL_UNWRAP", await engine.finalizePrincipalUnwrap(unwrapRequestId, unwrapAmount, unwrapProof));

  const deployed = await adapter.principalDeployed();
  const managedBeforeYield = await adapter.managedAssets();
  const generatedBeforeYield = await adapter.generatedYield();
  const vaultAssetsBeforeYield = await yieldVault.totalAssets();
  const vaultSharesBeforeYield = await yieldVault.totalSupply();
  if (deployed !== EXPECTED_PRINCIPAL || managedBeforeYield !== EXPECTED_PRINCIPAL || generatedBeforeYield !== 0n || vaultAssetsBeforeYield !== EXPECTED_PRINCIPAL || vaultSharesBeforeYield !== EXPECTED_PRINCIPAL) {
    throw new Error(`Principal checkpoint mismatch: deployed=${deployed} managed=${managedBeforeYield} generated=${generatedBeforeYield} vaultAssets=${vaultAssetsBeforeYield} vaultShares=${vaultSharesBeforeYield}`);
  }
  console.log(`PRINCIPAL_CHECKPOINT_PASS deployed=${formatUnits(deployed, 6)} mUNDER managed=${formatUnits(managedBeforeYield, 6)} mUNDER generated=0`);

  let operatorBalance = await underlying.balanceOf(operator);
  if (operatorBalance < YIELD_AMOUNT) {
    const missing = YIELD_AMOUNT - operatorBalance;
    await wait("TEST_ASSET_FUNDING", await underlying.mint(operator, missing));
    operatorBalance = await underlying.balanceOf(operator);
  }
  if (operatorBalance < YIELD_AMOUNT) throw new Error("Operator lacks 12 mUNDER for controlled yield injection");
  const allowance = await underlying.allowance(operator, yieldVaultAddress);
  if (allowance < YIELD_AMOUNT) {
    await wait("YIELD_VAULT_APPROVAL", await underlying.approve(yieldVaultAddress, YIELD_AMOUNT));
  }
  await wait("CONTROLLED_YIELD_INJECTION", await yieldVault.addTestYield(YIELD_AMOUNT));

  const managedAfterInjection = await adapter.managedAssets();
  const generatedAfterInjection = await adapter.generatedYield();
  const vaultAssetsAfterInjection = await yieldVault.totalAssets();
  if (managedAfterInjection !== EXPECTED_PRINCIPAL + YIELD_AMOUNT || generatedAfterInjection !== YIELD_AMOUNT || vaultAssetsAfterInjection !== EXPECTED_PRINCIPAL + YIELD_AMOUNT) {
    throw new Error(`Yield checkpoint mismatch: managed=${managedAfterInjection} generated=${generatedAfterInjection} vaultAssets=${vaultAssetsAfterInjection}`);
  }
  console.log(`YIELD_CHECKPOINT_PASS managed=${formatUnits(managedAfterInjection, 6)} mUNDER generated=${formatUnits(generatedAfterInjection, 6)} mUNDER`);

  await wait("HARVEST_YIELD", await engine.harvestYield());
  const finalPrincipal = await adapter.principalDeployed();
  const finalGenerated = await adapter.generatedYield();
  const harvested = await engine.unallocatedHarvestedYield();
  const roundPrize = await engine.roundPrizeAmount();
  const prizeCommitted = await engine.prizeCommitted();
  const roundState = await engine.roundState();
  if (finalPrincipal !== EXPECTED_PRINCIPAL || finalGenerated !== 0n || harvested !== YIELD_AMOUNT || roundPrize !== 0n || prizeCommitted || roundState !== 0n) {
    throw new Error(`Final accounting mismatch: principal=${finalPrincipal} generated=${finalGenerated} harvested=${harvested} roundPrize=${roundPrize} committed=${prizeCommitted} state=${roundState}`);
  }
  console.log(`FINAL_ACCOUNTING_PASS principal=${formatUnits(finalPrincipal, 6)} mUNDER generated=0 harvested=${formatUnits(harvested, 6)} mUNDER roundPrize=0 round=1 OPEN`);
  console.log("PRINCIPAL_NOT_PRIZE_PASS");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`PHASE_7C_YIELD_FAIL: ${message}`);
  process.exitCode = 1;
});
