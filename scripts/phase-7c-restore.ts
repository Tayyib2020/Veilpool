import { readFileSync } from "node:fs";
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress } from "ethers";

const CHAIN_ID = 11155111;
const PRINCIPAL = 120_000_000n;
const PRIZE = 11_999_999n;
const ZERO_HANDLE = `0x${"0".repeat(64)}`;
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

function deployed(name: string): string {
  const value = deployment.contracts[name]?.address;
  if (!value) throw new Error(`Missing ${name} in deployment artifact`);
  return getAddress(value);
}

function nonzeroHandle(value: string): boolean {
  return value.toLowerCase() !== ZERO_HANDLE;
}

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(requiredEnv("SEPOLIA_RPC_URL"), CHAIN_ID);
  const signer = new Wallet(requiredEnv("DEPLOYER_PRIVATE_KEY"), provider);
  const operator = getAddress(await signer.getAddress());
  if (operator !== getAddress(deployment.operator) || operator !== getAddress(deployment.deployer)) {
    throw new Error("Signer does not match deployed operator/deployer");
  }

  const engineAddress = deployed("prizeEngine");
  const adapterAddress = deployed("yieldAdapter");
  const vaultAddress = deployed("veilPool");
  const tokenAddress = deployed("confidentialToken");
  const underlyingAddress = deployed("underlyingToken");
  const yieldVaultAddress = deployed("sepoliaYieldVault");

  const engine = new Contract(engineAddress, [
    "function roundId() view returns(uint256)",
    "function roundState() view returns(uint8)",
    "function publicPrincipalLiability() view returns(uint64)",
    "function roundPrizeAmount() view returns(uint256)",
    "function prizeCommitted() view returns(bool)",
    "function unallocatedHarvestedYield() view returns(uint256)",
    "function principalUnwrapPending() view returns(bool)",
    "function restorePrincipalLiquidity()",
  ], signer);
  const adapter = new Contract(adapterAddress, [
    "function principalDeployed() view returns(uint256)",
    "function managedAssets() view returns(uint256)",
    "function generatedYield() view returns(uint256)",
  ], provider);
  const vault = new Contract(vaultAddress, [
    "function confidentialPrincipalLiability() view returns(bytes32)",
    "function confidentialWinningsOf(address) view returns(bytes32)",
  ], provider);
  const token = new Contract(tokenAddress, [
    "function confidentialBalanceOf(address) view returns(bytes32)",
  ], provider);
  const underlying = new Contract(underlyingAddress, [
    "function balanceOf(address) view returns(uint256)",
  ], provider);
  const yieldVault = new Contract(yieldVaultAddress, [
    "function totalAssets() view returns(uint256)",
    "function balanceOf(address) view returns(uint256)",
  ], provider);

  const before = await Promise.all([
    engine.roundId(), engine.roundState(), engine.publicPrincipalLiability(), engine.roundPrizeAmount(),
    engine.prizeCommitted(), engine.unallocatedHarvestedYield(), engine.principalUnwrapPending(),
    adapter.principalDeployed(), adapter.managedAssets(), adapter.generatedYield(),
    yieldVault.totalAssets(), yieldVault.balanceOf(adapterAddress), underlying.balanceOf(vaultAddress),
    vault.confidentialPrincipalLiability(), vault.confidentialWinningsOf(PARTICIPANT_A),
    vault.confidentialWinningsOf(PARTICIPANT_B), token.confidentialBalanceOf(vaultAddress),
  ]);
  if (before[0] !== 1n || before[1] !== 6n || before[2] !== PRINCIPAL || before[3] !== PRIZE || !before[4] || before[5] !== 0n || before[6] || before[7] !== PRINCIPAL) {
    throw new Error(`Pre-restoration invariant mismatch round=${before[0]} state=${before[1]} principal=${before[2]} prize=${before[3]} committed=${before[4]} unallocated=${before[5]} pending=${before[6]} deployed=${before[7]}`);
  }
  if (!nonzeroHandle(String(before[13])) || !nonzeroHandle(String(before[14])) || !nonzeroHandle(String(before[15])) || !nonzeroHandle(String(before[16]))) {
    throw new Error("Required confidential handles were unexpectedly zero before restoration");
  }
  console.log(`PRE_RESTORE_PASS round=1 state=SETTLED principal=${before[2].toString()} prize=${before[3].toString()} adapterPrincipal=${before[7].toString()} restored=false`);

  const tx = await engine.restorePrincipalLiquidity();
  console.log(`RESTORE_PRINCIPAL_LIQUIDITY_TX=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Restoration receipt missing");
  console.log(`RESTORE_PRINCIPAL_LIQUIDITY_CONFIRMED_BLOCK=${receipt.blockNumber}`);
  console.log(`RESTORE_PRINCIPAL_LIQUIDITY_GAS_USED=${receipt.gasUsed.toString()}`);

  const after = await Promise.all([
    engine.roundId(), engine.roundState(), engine.publicPrincipalLiability(), engine.roundPrizeAmount(),
    engine.prizeCommitted(), engine.unallocatedHarvestedYield(), engine.principalUnwrapPending(),
    adapter.principalDeployed(), adapter.managedAssets(), adapter.generatedYield(),
    yieldVault.totalAssets(), yieldVault.balanceOf(adapterAddress), underlying.balanceOf(vaultAddress),
    vault.confidentialPrincipalLiability(), vault.confidentialWinningsOf(PARTICIPANT_A),
    vault.confidentialWinningsOf(PARTICIPANT_B), token.confidentialBalanceOf(vaultAddress),
  ]);
  if (after[0] !== 1n || after[1] !== 6n || after[2] !== PRINCIPAL || after[3] !== PRIZE || !after[4] || after[5] !== 0n || after[6] || after[7] !== 0n || after[12] !== 0n || String(after[13]) !== String(before[13]) || String(after[14]) !== String(before[14]) || String(after[15]) !== String(before[15]) || !nonzeroHandle(String(after[16]))) {
    throw new Error(`Post-restoration invariant mismatch round=${after[0]} state=${after[1]} principal=${after[2]} prize=${after[3]} committed=${after[4]} unallocated=${after[5]} pending=${after[6]} adapterPrincipal=${after[7]} vaultUnderlying=${after[12]} yieldVaultAssets=${after[10]}`);
  }

  const erc20 = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
  let restoredUnderlying = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = erc20.parseLog(log);
      if (parsed?.name === "Transfer" && getAddress(String(parsed.args.from)) === yieldVaultAddress && getAddress(String(parsed.args.to)) === vaultAddress) {
        restoredUnderlying += BigInt(String(parsed.args.value));
      }
    } catch { /* unrelated protocol logs */ }
  }
  if (restoredUnderlying !== PRINCIPAL) throw new Error(`Underlying restoration transfer mismatch: ${restoredUnderlying}`);
  console.log(`POST_RESTORE_PASS restoredPrincipal=${restoredUnderlying.toString()} adapterPrincipal=${after[7].toString()} adapterManagedAssets=${after[8].toString()} yieldVaultAssets=${after[10].toString()} vaultUnderlying=${after[12].toString()} confidentialVaultLiquidityHandle=present prize=${after[3].toString()} principal=${after[2].toString()} round=SETTLED`);
  console.log("PRIZE_NOT_USED_FOR_RESTORATION_PASS");
  console.log("WINNINGS_HANDLES_UNCHANGED_PASS");
  console.log("MANUAL_WITHDRAWAL_REQUIRED");
  await provider.destroy();
}

main().catch((error: unknown) => {
  console.error(`PHASE_7C_RESTORE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
