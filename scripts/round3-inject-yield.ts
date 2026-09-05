import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, formatUnits, getAddress } from "ethers";

const CHAIN_ID = 11155111n;
const YIELD_AMOUNT = 12_000_000n;
const EXPECTED_PRINCIPAL = 275_000_000n;
const EXPECTED_OPERATOR = getAddress("0x51133dfa694940Fe4ebC785a5CE11B54f5C86048");
const EXPECTED_UNDERLYING = getAddress("0x60FAC1d70af4e4b6f7eF973787bddd37763508bc");
const EXPECTED_YIELD_VAULT = getAddress("0xecF8Abb70E79aF0E9428388b66F8498b474040b1");

const deployment = JSON.parse(readFileSync("deployments/sepolia.json", "utf8")) as {
  operator: string;
  contracts: Record<string, { address: string }>;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function deploymentAddress(name: string): string {
  const value = deployment.contracts[name]?.address;
  if (!value) throw new Error(`Missing ${name} in deployments/sepolia.json`);
  return getAddress(value);
}

function units(value: bigint): string {
  return `${formatUnits(value, 6)} mUNDER (${value.toString()} base units)`;
}

async function main(): Promise<void> {
  console.log("CONTROLLED SEPOLIA SIMULATION / TEST ASSETS ONLY");
  console.log("This one-off script approves and injects exactly 12.000000 mUNDER. It does not harvest or advance the round.");

  const provider = new JsonRpcProvider(requiredEnv("SEPOLIA_RPC_URL"), Number(CHAIN_ID));
  const signer = new Wallet(requiredEnv("DEPLOYER_PRIVATE_KEY"), provider);
  const signerAddress = getAddress(await signer.getAddress());
  const network = await provider.getNetwork();

  if (network.chainId !== CHAIN_ID) throw new Error(`Expected chain ID ${CHAIN_ID}, received ${network.chainId}`);
  if (signerAddress !== EXPECTED_OPERATOR) {
    throw new Error(`Operator mismatch: expected ${EXPECTED_OPERATOR}, received ${signerAddress}`);
  }
  if (getAddress(deployment.operator) !== EXPECTED_OPERATOR) {
    throw new Error("deployments/sepolia.json operator does not match the configured operator");
  }

  const underlyingAddress = deploymentAddress("underlyingToken");
  const yieldVaultAddress = deploymentAddress("sepoliaYieldVault");
  const adapterAddress = deploymentAddress("yieldAdapter");
  const engineAddress = deploymentAddress("prizeEngine");

  if (underlyingAddress !== EXPECTED_UNDERLYING) throw new Error("Underlying token address does not match the verified Sepolia deployment");
  if (yieldVaultAddress !== EXPECTED_YIELD_VAULT) throw new Error("Yield vault address does not match the verified Sepolia deployment");

  const underlying = new Contract(underlyingAddress, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], signer);
  const yieldVault = new Contract(yieldVaultAddress, [
    "function addTestYield(uint256)",
    "function totalAssets() view returns (uint256)",
    "function totalSupply() view returns (uint256)",
  ], signer);
  const adapter = new Contract(adapterAddress, [
    "function principalDeployed() view returns (uint256)",
    "function managedAssets() view returns (uint256)",
    "function generatedYield() view returns (uint256)",
  ], provider);
  const engine = new Contract(engineAddress, [
    "function roundId() view returns (uint256)",
    "function roundState() view returns (uint8)",
    "function publicPrincipalLiability() view returns (uint64)",
    "function unallocatedHarvestedYield() view returns (uint256)",
  ], provider);

  const [beforeBalance, beforeAllowance, beforeAssets, beforeSupply, beforePrincipal, beforeManaged, beforeGenerated, beforeRound, beforeState, beforeUnallocated] = await Promise.all([
    underlying.balanceOf(signerAddress),
    underlying.allowance(signerAddress, yieldVaultAddress),
    yieldVault.totalAssets(),
    yieldVault.totalSupply(),
    adapter.principalDeployed(),
    adapter.managedAssets(),
    adapter.generatedYield(),
    engine.roundId(),
    engine.roundState(),
    engine.unallocatedHarvestedYield(),
  ]) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

  console.log("BEFORE");
  console.log(`operator mUNDER: ${units(beforeBalance)}`);
  console.log(`allowance to yield vault: ${units(beforeAllowance)}`);
  console.log(`yield vault totalAssets: ${beforeAssets.toString()}`);
  console.log(`yield vault totalSupply: ${beforeSupply.toString()}`);

  if (beforeBalance < YIELD_AMOUNT) throw new Error(`Operator balance is below the required ${units(YIELD_AMOUNT)}`);
  if (beforePrincipal !== EXPECTED_PRINCIPAL) throw new Error(`Principal deployed mismatch: expected ${EXPECTED_PRINCIPAL}, received ${beforePrincipal}`);
  if (beforeRound !== 3n || beforeState !== 0n) throw new Error(`Expected Round #3 OPEN, received round=${beforeRound} state=${beforeState}`);
  if (beforeUnallocated !== 0n) throw new Error(`Expected zero unallocated harvested yield, received ${beforeUnallocated}`);

  if (beforeAllowance < YIELD_AMOUNT) {
    const approveTx = await underlying.approve(yieldVaultAddress, YIELD_AMOUNT);
    console.log(`APPROVE_TX=${approveTx.hash}`);
    await approveTx.wait();
    console.log("APPROVE_CONFIRMED");
  } else {
    console.log("APPROVAL_SKIPPED allowance_is_sufficient");
  }

  const injectionTx = await yieldVault.addTestYield(YIELD_AMOUNT);
  console.log(`ADD_TEST_YIELD_TX=${injectionTx.hash}`);
  await injectionTx.wait();
  console.log("ADD_TEST_YIELD_CONFIRMED");

  const [afterBalance, afterAllowance, afterAssets, afterSupply, afterPrincipal, afterManaged, afterGenerated, afterRound, afterState, afterUnallocated] = await Promise.all([
    underlying.balanceOf(signerAddress),
    underlying.allowance(signerAddress, yieldVaultAddress),
    yieldVault.totalAssets(),
    yieldVault.totalSupply(),
    adapter.principalDeployed(),
    adapter.managedAssets(),
    adapter.generatedYield(),
    engine.roundId(),
    engine.roundState(),
    engine.unallocatedHarvestedYield(),
  ]) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

  console.log("AFTER");
  console.log(`operator mUNDER: ${units(afterBalance)}`);
  console.log(`allowance to yield vault: ${units(afterAllowance)}`);
  console.log(`yield vault totalAssets: ${afterAssets.toString()}`);
  console.log(`yield vault totalSupply: ${afterSupply.toString()}`);
  console.log(`adapter principal deployed: ${afterPrincipal.toString()}`);
  console.log(`adapter managed assets: ${afterManaged.toString()}`);
  console.log(`adapter generated yield: ${afterGenerated.toString()}`);

  const generatedWithinOneUnit = afterGenerated >= YIELD_AMOUNT - 1n && afterGenerated <= YIELD_AMOUNT + 1n;
  const pass = afterBalance === beforeBalance - YIELD_AMOUNT
    && afterAssets === beforeAssets + YIELD_AMOUNT
    && afterSupply === beforeSupply
    && afterPrincipal === EXPECTED_PRINCIPAL
    && generatedWithinOneUnit
    && afterRound === 3n
    && afterState === 0n
    && afterUnallocated === 0n;

  if (!pass) {
    throw new Error(`ROUND3_INJECT_YIELD_FAIL balance=${afterBalance} assets=${afterAssets} supply=${afterSupply} principal=${afterPrincipal} generated=${afterGenerated} round=${afterRound} state=${afterState} unallocated=${afterUnallocated}`);
  }

  console.log("ROUND3_INJECT_YIELD_PASS");
  console.log("Controlled Sepolia test yield is injected. No harvest, lock, prize commit, or draw was performed by this script.");
}

main().catch((error: unknown) => {
  console.error(`ROUND3_INJECT_YIELD_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
