import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatEther, getAddress, keccak256, ZeroAddress, ZeroHash, type ContractTransactionResponse, type Signer } from "ethers";
import { artifacts, ethers, network } from "hardhat";
import {
  ERC4626YieldAdapter__factory, MockUnderlyingToken__factory, PrizeEngine__factory,
  SepoliaYieldVault__factory, VeilPoolConfidentialToken__factory, VeilPool__factory,
} from "../types";

const ROOT = resolve(__dirname, "..");
const HISTORY = resolve(ROOT, "deployments/sepolia.json");
const OUTPUT = resolve(ROOT, "deployments/sepolia-v2.json");
const OPERATOR = "0x51133dfa694940Fe4ebC785a5CE11B54f5C86048";
const EXPECTED = {
  underlyingToken: "0x60FAC1d70af4e4b6f7eF973787bddd37763508bc",
  confidentialToken: "0xfbC3096644cc41bAa6768897c0de286F79D1578a",
  veilPool: "0x6E308F5F33abbdd800883e297906dF8de6B68Bd5",
  sepoliaYieldVault: "0xecF8Abb70E79aF0E9428388b66F8498b474040b1",
  yieldAdapter: "0xef20dc27219531e8fbbfcb932EE8d8ad04eA3fe8",
  prizeEngine: "0xaA6899418e85a1D6302B7C92aD760A9165aB358E",
};
type ContractName = keyof typeof EXPECTED;
export type V1Deployment = {
  status: string; network: string; chainId: number; deployer: string; operator: string;
  contracts: Record<ContractName, { address: string }>;
};
export type V2Addresses = { veilPool: string; yieldAdapter: string; prizeEngine: string };
type TransactionEvidence = { hash?: string; nonce: number; block?: number; gasUsed?: string };
export type V2Record = {
  version: 2; status: "partial" | "complete"; network: string; chainId: number;
  operator: string; deployer: string; historicalRecord: string; historicalRecordHash?: string;
  yieldSource: string; testAssetsOnly: true; migration: "none";
  activeStep: string; contracts: Partial<Record<ContractName, { address: string; reused: boolean }>>;
  transactions: Record<string, TransactionEvidence>; verified: boolean; timestamp: string;
};

class DeploymentCheckError extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DeploymentCheckError(message);
}
function same(label: string, actual: string, expected: string): void {
  check(getAddress(actual) === getAddress(expected), `${label}: expected ${expected}, received ${actual}`);
}

export function validateSepoliaTarget(chainId: bigint, networkName: string, history: V1Deployment, signer: string, configuredOperator: string): void {
  check(networkName === "sepolia" && chainId === 11155111n, "V2 deployment requires Sepolia chain 11155111.");
  check(history.status === "complete" && history.network === "sepolia" && history.chainId === 11155111, "Invalid historical Sepolia deployment record.");
  same("signer/operator", signer, OPERATOR);
  same("configured operator", configuredOperator, OPERATOR);
  same("historical deployer", history.deployer, OPERATOR);
  same("historical operator", history.operator, OPERATOR);
  for (const name of Object.keys(EXPECTED) as ContractName[]) same(`historical ${name}`, history.contracts[name].address, EXPECTED[name]);
}

// Compare the reusable implementations to the installed, compiled source. Solidity
// immutable slots are masked; their asset/rate values are verified separately below.
async function verifyReusableCode(name: string, address: string, signer: Signer): Promise<void> {
  const artifact = await artifacts.readArtifact(name);
  const build = await artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
  check(build, `Missing build info for ${name}; compile first.`);
  const runtime = build.output.contracts[artifact.sourceName][name].evm.deployedBytecode;
  const actual = await signer.provider!.getCode(address);
  const mask = (code: string) => {
    const bytes = code.replace(/^0x/, "").toLowerCase().split("");
    for (const slots of Object.values(runtime.immutableReferences ?? {})) {
      for (const { start, length } of slots) bytes.fill("0", start * 2, (start + length) * 2);
    }
    return bytes.join("");
  };
  check(actual.length === runtime.object.length + 2 && mask(actual) === mask(runtime.object), `Reusable ${name} bytecode differs from compiled source; stop for review.`);
}

/** Read-only; used both by the Sepolia entry point and the local deployment tests. */
export async function verifyV1Reuse(history: V1Deployment, signer: Signer): Promise<void> {
  check(signer.provider, "Signer has no provider.");
  const c = history.contracts;
  for (const name of Object.keys(c) as ContractName[]) {
    check(await signer.provider.getCode(c[name].address) !== "0x", `No bytecode at historical ${name}.`);
  }
  await verifyReusableCode("MockUnderlyingToken", c.underlyingToken.address, signer);
  await verifyReusableCode("VeilPoolConfidentialToken", c.confidentialToken.address, signer);
  await verifyReusableCode("SepoliaYieldVault", c.sepoliaYieldVault.address, signer);
  const token = MockUnderlyingToken__factory.connect(c.underlyingToken.address, signer);
  const wrapper = VeilPoolConfidentialToken__factory.connect(c.confidentialToken.address, signer);
  const yieldVault = SepoliaYieldVault__factory.connect(c.sepoliaYieldVault.address, signer);
  const vault = VeilPool__factory.connect(c.veilPool.address, signer);
  const engine = PrizeEngine__factory.connect(c.prizeEngine.address, signer);
  const adapter = ERC4626YieldAdapter__factory.connect(c.yieldAdapter.address, signer);
  same("wrapper underlying", await wrapper.underlying(), c.underlyingToken.address);
  check(await token.decimals() === 6n && await wrapper.decimals() === 6n && await wrapper.rate() === 1n, "Expected six decimals and wrapper rate 1.");
  same("yield vault asset", await yieldVault.asset(), c.underlyingToken.address);
  same("yield vault owner", await yieldVault.owner(), history.operator);
  same("old vault token", await vault.confidentialToken(), c.confidentialToken.address);
  same("old vault engine", await vault.prizeEngine(), c.prizeEngine.address);
  same("old engine vault", await engine.vault(), c.veilPool.address);
  same("old engine token", await engine.confidentialToken(), c.confidentialToken.address);
  same("old engine operator", await engine.operator(), history.operator);
  same("old engine adapter", await engine.yieldAdapter(), c.yieldAdapter.address);
  same("old adapter controller", await adapter.controller(), c.prizeEngine.address);
  same("old adapter asset", await adapter.asset(), c.underlyingToken.address);
  same("old adapter yield vault", await adapter.yieldVault(), c.sepoliaYieldVault.address);
  check(await adapter.managedAssets() >= await adapter.principalDeployed(), "Historical adapter principal is undercollateralized; stop for review.");
}

export function newV2Record(history: V1Deployment): V2Record {
  return {
    version: 2, status: "partial", network: history.network, chainId: history.chainId,
    operator: history.operator, deployer: history.deployer, historicalRecord: "deployments/sepolia.json",
    yieldSource: "Controlled Sepolia simulation / Test assets only", testAssetsOnly: true, migration: "none",
    activeStep: "preflight", transactions: {}, verified: false, timestamp: new Date().toISOString(),
    contracts: Object.fromEntries((["underlyingToken", "confidentialToken", "sepoliaYieldVault"] as const)
      .map(name => [name, { address: history.contracts[name].address, reused: true }])),
  };
}

/** Exclusive reservation prevents accidental reruns, including after a failed setup. */
export function reserveV2Record(path: string, record: V2Record): (record: V2Record) => void {
  check(resolve(path) !== HISTORY, "Refusing to overwrite the historical deployment record.");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return value => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function verifyV2Relationships(history: V1Deployment, addresses: V2Addresses, signer: Signer): Promise<void> {
  const c = history.contracts;
  for (const [name, address] of Object.entries(addresses)) {
    check(!Object.values(c).some(old => getAddress(old.address) === getAddress(address)), `${name} must be a NEW contract.`);
    check(await signer.provider!.getCode(address) !== "0x", `No V2 bytecode: ${name}.`);
  }
  const vault = VeilPool__factory.connect(addresses.veilPool, signer);
  const engine = PrizeEngine__factory.connect(addresses.prizeEngine, signer);
  const adapter = ERC4626YieldAdapter__factory.connect(addresses.yieldAdapter, signer);
  const wrapper = VeilPoolConfidentialToken__factory.connect(c.confidentialToken.address, signer);
  const yieldVault = SepoliaYieldVault__factory.connect(c.sepoliaYieldVault.address, signer);
  same("V2 vault token", await vault.confidentialToken(), c.confidentialToken.address);
  same("V2 vault engine", await vault.prizeEngine(), addresses.prizeEngine);
  same("V2 engine vault", await engine.vault(), addresses.veilPool);
  same("V2 engine token", await engine.confidentialToken(), c.confidentialToken.address);
  same("V2 engine operator", await engine.operator(), history.operator);
  same("V2 engine adapter", await engine.yieldAdapter(), addresses.yieldAdapter);
  same("V2 adapter controller", await adapter.controller(), addresses.prizeEngine);
  same("V2 adapter asset", await adapter.asset(), c.underlyingToken.address);
  same("V2 adapter yield vault", await adapter.yieldVault(), c.sepoliaYieldVault.address);
  check(await vault.maxParticipants() === 10n && await vault.participantCount() === 0n, "V2 participant registry must be empty with cap 10.");
  check(await engine.roundId() === 1n && await engine.roundState() === 0n, "V2 must start at Round 1 OPEN.");
  check(await engine.publicPrincipalLiability() === 0n && await engine.roundPrizeAmount() === 0n && await engine.unallocatedHarvestedYield() === 0n, "V2 public accounting must be zero.");
  check(!await engine.prizeCommitted() && !await engine.acceptanceDecryptionRequested() && !await engine.principalLiabilityRevealRequested() && !await engine.principalUnwrapPending(), "Unexpected V2 pending/prize flags.");
  check(await engine.pendingPrincipalUnwrapRequest() === ZeroHash && await engine.publicTotalWeight() === 0n, "Unexpected V2 pending request/weight.");
  check(await adapter.principalDeployed() === 0n && await adapter.managedAssets() === 0n && await adapter.generatedYield() === 0n && await yieldVault.balanceOf(addresses.yieldAdapter) === 0n, "V2 adapter must start unfunded.");
  check(await vault.confidentialPrincipalLiability() === ZeroHash && await engine.confidentialPrizeReserve() === ZeroHash, "V2 confidential accounting must be uninitialized.");
  for (const address of Object.values(addresses)) {
    check(await wrapper.confidentialBalanceOf(address) === ZeroHash, "Unexpected V2 confidential funding.");
    check(await MockUnderlyingToken__factory.connect(c.underlyingToken.address, signer).balanceOf(address) === 0n, "Unexpected V2 public funding.");
  }
  check(await vault.supportsWinningsWithdrawal(), "V2 winnings capability marker is missing.");
  // This eth_call must dispatch the real API and hit its first guard. No proof,
  // signature or transaction is produced; the new registry is empty.
  let dispatchVerified = false;
  try {
    await vault.withdrawWinnings.staticCall(ZeroHash, "0x");
  } catch (error) {
    dispatchVerified = (error as { data?: string }).data === vault.interface.getError("NotParticipant")!.selector;
  }
  check(dispatchVerified, "withdrawWinnings(bytes32,bytes) dispatch did not return NotParticipant; stop for review.");
}

/** The only six writes in V2 preparation. Tests execute this same path locally. */
export async function deployV2(history: V1Deployment, signer: Signer, record: V2Record, save: (record: V2Record) => void): Promise<V2Addresses> {
  same("V2 signer", await signer.getAddress(), history.operator);
  await verifyV1Reuse(history, signer);
  check(Object.keys(record.transactions).length === 0 && record.status === "partial", "Refusing to resume/redeploy an existing V2 attempt.");
  const c = history.contracts;
  async function step<T>(name: string, send: () => Promise<T>, transaction: (result: T) => ContractTransactionResponse | null): Promise<T> {
    record.activeStep = name;
    record.transactions[name] = { nonce: await signer.getNonce("pending") };
    save(record); // Record intent BEFORE a broadcast, including uncertain RPC failures.
    const result = await send();
    const tx = transaction(result);
    check(tx, `Missing transaction for ${name}.`);
    record.transactions[name] = { hash: tx.hash, nonce: tx.nonce };
    save(record); // Persist hash before awaiting confirmation.
    const receipt = await tx.wait(1, 180_000);
    check(receipt?.status === 1, `${name} failed or confirmation is unavailable. Do not rerun.`);
    record.transactions[name].block = receipt.blockNumber;
    record.transactions[name].gasUsed = receipt.gasUsed.toString();
    save(record);
    return result;
  }
  async function deployment<T extends { getAddress(): Promise<string>; deploymentTransaction(): ContractTransactionResponse | null }>(name: keyof V2Addresses, send: () => Promise<T>): Promise<T> {
    const contract = await step(name, send, value => value.deploymentTransaction());
    record.contracts[name] = { address: await contract.getAddress(), reused: false };
    save(record);
    return contract;
  }
  const vault = await deployment("veilPool", () => new VeilPool__factory(signer).deploy(c.confidentialToken.address, 10n));
  const adapter = await deployment("yieldAdapter", () => new ERC4626YieldAdapter__factory(signer).deploy(c.underlyingToken.address, c.sepoliaYieldVault.address));
  const engine = await deployment("prizeEngine", async () => new PrizeEngine__factory(signer).deploy(await vault.getAddress(), c.confidentialToken.address, history.operator));
  const addresses = { veilPool: await vault.getAddress(), yieldAdapter: await adapter.getAddress(), prizeEngine: await engine.getAddress() };
  same("unset V2 vault engine", await vault.prizeEngine(), ZeroAddress);
  same("unset V2 adapter controller", await adapter.controller(), ZeroAddress);
  same("unset V2 engine adapter", await engine.yieldAdapter(), ZeroAddress);
  await step("setPrizeEngine", () => vault.setPrizeEngine(addresses.prizeEngine), tx => tx);
  same("configured V2 vault engine", await vault.prizeEngine(), addresses.prizeEngine);
  await step("setAdapterController", () => adapter.setController(addresses.prizeEngine), tx => tx);
  same("configured V2 adapter controller", await adapter.controller(), addresses.prizeEngine);
  await step("setYieldAdapter", () => engine.setYieldAdapter(addresses.yieldAdapter), tx => tx);
  record.activeStep = "verify";
  save(record);
  await verifyV2Relationships(history, addresses, signer);
  await verifyV1Reuse(history, signer); // Old wiring and reusable permissions remain intact.
  record.verified = true;
  record.status = "complete";
  record.activeStep = "complete";
  save(record);
  return addresses;
}

async function main(): Promise<void> {
  // Hardhat config needs env BEFORE loading: use Node's -r dotenv/config command.
  for (const name of ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY", "OPERATOR_ADDRESS"]) {
    check(process.env[name]?.trim(), `Missing ${name}; preload the existing root .env (see V2 runbook).`);
  }
  const historyText = readFileSync(HISTORY, "utf8");
  const history: V1Deployment = JSON.parse(historyText);
  const [signer] = await ethers.getSigners();
  check(signer, "No configured deployer signer.");
  const chainId = (await ethers.provider.getNetwork()).chainId;
  validateSepoliaTarget(chainId, network.name, history, await signer.getAddress(), process.env.OPERATOR_ADDRESS!.trim());
  check(!existsSync(OUTPUT), "deployments/sepolia-v2.json already exists. STOP: inspect it and chain receipts; do not blindly redeploy.");
  await verifyV1Reuse(history, signer);
  const balance = await ethers.provider.getBalance(signer.address);
  check(balance > 0n, "Deployer has no Sepolia ETH.");
  console.log(`Operator/deployer: ${signer.address}; Sepolia chain ${chainId}; ETH ${formatEther(balance)}`);
  console.log("Controlled Sepolia simulation / Test assets only. Shared yield-vault exchange rate; no migration.");
  if (process.env.DEPLOYMENT_PREFLIGHT_ONLY === "1") {
    console.log("V2 preflight PASS. No record written and no transactions sent.");
    return;
  }
  const record = newV2Record(history);
  record.historicalRecordHash = keccak256(Buffer.from(historyText));
  const save = reserveV2Record(OUTPUT, record);
  const addresses = await deployV2(history, signer, record, save);
  console.log(JSON.stringify({ status: "V2 DEPLOYED AND VERIFIED", contracts: addresses, record: OUTPUT, transactions: record.transactions }, null, 2));
  console.log("STOP. Production frontend unchanged. No mint, wrap, deposit, yield, draw or migration performed.");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Do not dump SDK/provider errors: they can embed RPC credentials or requests.
    const code = (error as { code?: unknown })?.code;
    const detail = error instanceof DeploymentCheckError ? error.message
      : typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "Unexpected failure (details suppressed to protect credentials)";
    console.error(`V2 deployment STOPPED: ${detail}. Inspect the V2 record's activeStep, nonce and hash. Do not rerun automatically.`);
    process.exitCode = 1;
  });
}
