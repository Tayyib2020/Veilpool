import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatEther, getAddress, keccak256, ZeroAddress, type ContractTransactionResponse, type Signer } from "ethers";
import { artifacts, ethers, network } from "hardhat";
import {
  ERC4626YieldAdapter__factory, MockUnderlyingToken__factory, PrizeEngine__factory,
  SepoliaYieldVault__factory, VeilPoolConfidentialToken__factory, VeilPool__factory,
} from "../types";
import { validateSepoliaTarget, verifyV2Relationships, type V1Deployment } from "./deploy-sepolia-v2";

const ROOT = resolve(__dirname, "..");
const HISTORY_PATHS = [resolve(ROOT, "deployments/sepolia.json"), resolve(ROOT, "deployments/sepolia-v2.json")];
const OUTPUT = resolve(ROOT, "deployments/sepolia-v2-isolated.json");
const V2_ADDRESSES = {
  veilPool: "0xbA7a505DFd707e28eBb96c9Dc302710D3E85C281",
  prizeEngine: "0xf013348c35e0A14DFAce51e6D82B0b64679bdD6E",
  yieldAdapter: "0x94CeA363Ac57f93fc1FBBd04608A00e5557dF3f3",
};
export type PriorDeployments = { v1: V1Deployment; v2: V1Deployment & { version?: number; verified?: boolean } };
export type IsolatedAddresses = { sepoliaYieldVault: string; veilPool: string; yieldAdapter: string; prizeEngine: string };
type Accounting = Record<string, string>;
export type IsolatedRecord = {
  version: "2-isolated"; status: "partial" | "complete"; verified: boolean;
  network: string; chainId: number; operator: string; deployer: string;
  migration: "none"; yieldSource: string; testAssetsOnly: true; timestamp: string;
  historicalRecords: Record<string, string>; activeStep: string;
  contracts: Record<string, { address: string; reused: boolean }>;
  transactions: Record<string, { nonce: number; hash?: string; block?: number; gasUsed?: string }>;
  legacyBefore?: Accounting; legacyAfter?: Accounting;
};
class IsolationCheckError extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new IsolationCheckError(message);
}
function same(label: string, actual: string, expected: string) {
  check(getAddress(actual) === getAddress(expected), `${label} mismatch: expected ${expected}, received ${actual}`);
}

export function validateIsolatedTarget(prior: PriorDeployments, chainId: bigint, name: string, signer: string, operator: string) {
  validateSepoliaTarget(chainId, name, prior.v1, signer, operator);
  check(prior.v2.version === 2 && prior.v2.verified === true && prior.v2.status === "complete" && prior.v2.network === "sepolia" && prior.v2.chainId === 11155111, "Invalid completed V2 record.");
  same("V2 operator", prior.v2.operator, operator);
  same("V2 deployer", prior.v2.deployer, signer);
  for (const [key, value] of Object.entries(V2_ADDRESSES)) same(`historical V2 ${key}`, prior.v2.contracts[key as keyof typeof V2_ADDRESSES].address, value);
  for (const key of ["underlyingToken", "confidentialToken", "sepoliaYieldVault"] as const) same(`historical shared ${key}`, prior.v2.contracts[key].address, prior.v1.contracts[key].address);
}

async function verifyTokenCode(name: string, address: string, signer: Signer) {
  const artifact = await artifacts.readArtifact(name);
  const build = await artifacts.getBuildInfo(`${artifact.sourceName}:${name}`);
  check(build, `Missing build info for ${name}; compile first.`);
  const runtime = build.output.contracts[artifact.sourceName][name].evm.deployedBytecode;
  const code = await signer.provider!.getCode(address);
  const mask = (value: string) => {
    const chars = value.replace(/^0x/, "").toLowerCase().split("");
    for (const slots of Object.values(runtime.immutableReferences ?? {})) {
      for (const { start, length } of slots) chars.fill("0", start * 2, (start + length) * 2);
    }
    return chars.join("");
  };
  check(code.length === runtime.object.length + 2 && mask(code) === mask(runtime.object), `${name} bytecode differs from compiled source.`);
}

/** Read-only. Legacy deficits are recorded, never repaired or silently reclassified. */
export async function verifyHistoricalTopology(prior: PriorDeployments, signer: Signer) {
  check(signer.provider, "Missing provider.");
  same("signer", await signer.getAddress(), prior.v1.operator);
  const c = prior.v1.contracts;
  await verifyTokenCode("MockUnderlyingToken", c.underlyingToken.address, signer);
  await verifyTokenCode("VeilPoolConfidentialToken", c.confidentialToken.address, signer);
  const token = MockUnderlyingToken__factory.connect(c.underlyingToken.address, signer);
  const wrapper = VeilPoolConfidentialToken__factory.connect(c.confidentialToken.address, signer);
  same("wrapper underlying", await wrapper.underlying(), c.underlyingToken.address);
  check(await token.decimals() === 6n && await wrapper.decimals() === 6n && await wrapper.rate() === 1n, "Expected six-decimal underlying/wrapper and rate 1.");
  for (const [label, history] of Object.entries(prior)) {
    const h = history.contracts;
    same(`${label} operator record`, history.operator, prior.v1.operator);
    for (const key of ["underlyingToken", "confidentialToken", "sepoliaYieldVault"] as const) same(`${label} shared ${key}`, h[key].address, c[key].address);
    for (const [key, value] of Object.entries(h)) check(await signer.provider.getCode(value.address) !== "0x", `${label} ${key} has no bytecode.`);
    const vault = VeilPool__factory.connect(h.veilPool.address, signer);
    const engine = PrizeEngine__factory.connect(h.prizeEngine.address, signer);
    const adapter = ERC4626YieldAdapter__factory.connect(h.yieldAdapter.address, signer);
    const yieldVault = SepoliaYieldVault__factory.connect(h.sepoliaYieldVault.address, signer);
    same(`${label} vault token`, await vault.confidentialToken(), c.confidentialToken.address);
    same(`${label} vault engine`, await vault.prizeEngine(), h.prizeEngine.address);
    same(`${label} engine vault`, await engine.vault(), h.veilPool.address);
    same(`${label} engine token`, await engine.confidentialToken(), c.confidentialToken.address);
    same(`${label} engine operator`, await engine.operator(), history.operator);
    same(`${label} engine adapter`, await engine.yieldAdapter(), h.yieldAdapter.address);
    same(`${label} adapter controller`, await adapter.controller(), h.prizeEngine.address);
    same(`${label} adapter asset`, await adapter.asset(), c.underlyingToken.address);
    same(`${label} adapter yield vault`, await adapter.yieldVault(), h.sepoliaYieldVault.address);
    same(`${label} yield asset`, await yieldVault.asset(), c.underlyingToken.address);
    same(`${label} yield owner`, await yieldVault.owner(), history.operator);
  }
}

export async function historicalAccounting(prior: PriorDeployments, signer: Signer): Promise<Accounting> {
  const blockTag = await signer.provider!.getBlockNumber();
  const at = { blockTag };
  const result: Accounting = {};
  for (const [label, history] of Object.entries(prior)) {
    const c = history.contracts;
    const vault = VeilPool__factory.connect(c.veilPool.address, signer);
    const engine = PrizeEngine__factory.connect(c.prizeEngine.address, signer);
    const adapter = ERC4626YieldAdapter__factory.connect(c.yieldAdapter.address, signer);
    const yieldVault = SepoliaYieldVault__factory.connect(c.sepoliaYieldVault.address, signer);
    for (const key of ["principalDeployed", "managedAssets", "generatedYield"] as const) result[`${label}.${key}`] = String(await adapter[key](at));
    for (const key of ["roundId", "roundState", "publicPrincipalLiability", "unallocatedHarvestedYield", "roundPrizeAmount", "prizeCommitted", "principalUnwrapPending", "principalLiabilityRevealRequested", "acceptanceDecryptionRequested"] as const) result[`${label}.${key}`] = String(await engine[key](at));
    result[`${label}.participantCount`] = String(await vault.participantCount(at));
    result[`${label}.shares`] = String(await yieldVault.balanceOf(c.yieldAdapter.address, at));
    result[`${label}.vaultAssets`] = String(await yieldVault.totalAssets(at));
    result[`${label}.vaultSupply`] = String(await yieldVault.totalSupply(at));
  }
  return result;
}

export function newIsolatedRecord(prior: PriorDeployments): IsolatedRecord {
  return {
    version: "2-isolated", status: "partial", verified: false,
    network: prior.v1.network, chainId: prior.v1.chainId, operator: prior.v1.operator, deployer: prior.v1.deployer,
    migration: "none", yieldSource: "Controlled Sepolia simulation / Test assets only — dedicated yield vault",
    testAssetsOnly: true, timestamp: new Date().toISOString(), historicalRecords: {}, activeStep: "preflight", transactions: {},
    contracts: Object.fromEntries((["underlyingToken", "confidentialToken"] as const).map(key => [key, { address: prior.v1.contracts[key].address, reused: true }])),
  };
}

export function reserveIsolatedRecord(path: string, record: IsolatedRecord): (record: IsolatedRecord) => void {
  check(!HISTORY_PATHS.includes(resolve(path)), "Refusing to overwrite a historical deployment record.");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", flush: true });
  return value => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flush: true });
}

export async function verifyIsolatedRelationships(prior: PriorDeployments, addresses: IsolatedAddresses, signer: Signer) {
  const retired = Object.values(prior).flatMap(history => Object.values(history.contracts).map(value => getAddress(value.address)));
  check(new Set(Object.values(addresses).map(getAddress)).size === 4, "New contracts must have four distinct addresses.");
  for (const [name, address] of Object.entries(addresses)) check(!retired.includes(getAddress(address)), `${name} must not reuse ANY historical pool/yield contract.`);
  const c = prior.v1.contracts;
  const yieldVault = SepoliaYieldVault__factory.connect(addresses.sepoliaYieldVault, signer);
  same("dedicated yield asset", await yieldVault.asset(), c.underlyingToken.address);
  same("dedicated yield owner", await yieldVault.owner(), prior.v1.operator);
  check(await yieldVault.totalAssets() === 0n && await yieldVault.totalSupply() === 0n, "Dedicated yield vault must be empty.");
  for (const history of Object.values(prior)) check(await yieldVault.balanceOf(history.contracts.yieldAdapter.address) === 0n, "Historical adapter has shares in the dedicated vault.");
  // Reuse the existing read-only empty-pool/API checks, supplying the NEW yield
  // vault as the expected reference. This never invokes the V2 deployment path.
  const expected = { ...prior.v1, contracts: { ...c, sepoliaYieldVault: { address: addresses.sepoliaYieldVault } } };
  await verifyV2Relationships(expected, { veilPool: addresses.veilPool, prizeEngine: addresses.prizeEngine, yieldAdapter: addresses.yieldAdapter }, signer);
}

export async function deployIsolated(prior: PriorDeployments, signer: Signer, record: IsolatedRecord, save: (record: IsolatedRecord) => void): Promise<IsolatedAddresses> {
  check(record.status === "partial" && Object.keys(record.transactions).length === 0, "Refusing to resume an existing isolated attempt.");
  await verifyHistoricalTopology(prior, signer);
  record.legacyBefore = await historicalAccounting(prior, signer);
  save(record);
  const c = prior.v1.contracts;
  async function step<T>(name: string, send: () => Promise<T>, transaction: (value: T) => ContractTransactionResponse | null): Promise<T> {
    record.activeStep = name;
    save(record); // A failed nonce lookup must still identify the active step.
    record.transactions[name] = { nonce: await signer.getNonce("pending") };
    save(record);
    const value = await send();
    const tx = transaction(value);
    check(tx, `Missing ${name} transaction.`);
    record.transactions[name] = { nonce: tx.nonce, hash: tx.hash };
    save(record);
    const receipt = await tx.wait(1, 180_000);
    check(receipt?.status === 1, `${name} failed or confirmation unavailable; STOP.`);
    record.transactions[name].block = receipt.blockNumber;
    record.transactions[name].gasUsed = String(receipt.gasUsed);
    save(record);
    return value;
  }
  async function deployment<T extends { getAddress(): Promise<string>; deploymentTransaction(): ContractTransactionResponse | null }>(name: keyof IsolatedAddresses, send: () => Promise<T>): Promise<T> {
    const value = await step(name, send, contract => contract.deploymentTransaction());
    record.contracts[name] = { address: await value.getAddress(), reused: false };
    save(record);
    return value;
  }
  const yieldVault = await deployment("sepoliaYieldVault", () => new SepoliaYieldVault__factory(signer).deploy(c.underlyingToken.address, prior.v1.operator));
  const vault = await deployment("veilPool", () => new VeilPool__factory(signer).deploy(c.confidentialToken.address, 10n));
  const adapter = await deployment("yieldAdapter", async () => new ERC4626YieldAdapter__factory(signer).deploy(c.underlyingToken.address, await yieldVault.getAddress()));
  const engine = await deployment("prizeEngine", async () => new PrizeEngine__factory(signer).deploy(await vault.getAddress(), c.confidentialToken.address, prior.v1.operator));
  const addresses = { sepoliaYieldVault: await yieldVault.getAddress(), veilPool: await vault.getAddress(), yieldAdapter: await adapter.getAddress(), prizeEngine: await engine.getAddress() };
  same("initial vault engine", await vault.prizeEngine(), ZeroAddress);
  same("initial adapter controller", await adapter.controller(), ZeroAddress);
  same("initial engine adapter", await engine.yieldAdapter(), ZeroAddress);
  await step("setPrizeEngine", () => vault.setPrizeEngine(addresses.prizeEngine), tx => tx);
  same("wired vault engine", await vault.prizeEngine(), addresses.prizeEngine);
  await step("setAdapterController", () => adapter.setController(addresses.prizeEngine), tx => tx);
  same("wired adapter controller", await adapter.controller(), addresses.prizeEngine);
  await step("setYieldAdapter", () => engine.setYieldAdapter(addresses.yieldAdapter), tx => tx);
  record.activeStep = "verification";
  save(record);
  await verifyIsolatedRelationships(prior, addresses, signer);
  await verifyHistoricalTopology(prior, signer);
  record.legacyAfter = await historicalAccounting(prior, signer);
  save(record);
  check(JSON.stringify(record.legacyBefore) === JSON.stringify(record.legacyAfter), "Legacy accounting changed during deployment; STOP for read-only reconciliation.");
  record.status = "complete";
  record.verified = true;
  record.activeStep = "complete";
  save(record);
  return addresses;
}

let phase = "environment";
async function main() {
  for (const key of ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY", "OPERATOR_ADDRESS"]) check(process.env[key]?.trim(), `Missing ${key}; preload the existing root .env.`);
  check(!existsSync(OUTPUT), "Isolated journal already exists. Inspect it; do not reset or rerun.");
  const texts = HISTORY_PATHS.map(path => readFileSync(path, "utf8"));
  const prior: PriorDeployments = { v1: JSON.parse(texts[0]), v2: JSON.parse(texts[1]) };
  phase = "network and target preflight";
  const [signer] = await ethers.getSigners();
  check(signer, "No deployer signer.");
  validateIsolatedTarget(prior, (await ethers.provider.getNetwork()).chainId, network.name, signer.address, process.env.OPERATOR_ADDRESS!.trim());
  phase = "historical relationships preflight";
  await verifyHistoricalTopology(prior, signer);
  const accounting = await historicalAccounting(prior, signer);
  const balance = await ethers.provider.getBalance(signer.address);
  check(balance > 0n, "No deployer Sepolia ETH.");
  console.log(`Operator ${signer.address}; chain 11155111; ETH ${formatEther(balance)}`);
  console.log("Controlled Sepolia simulation / Test assets only. Seven setup transactions; no migration or compensation.");
  console.log(JSON.stringify({ legacyAccounting: accounting }, null, 2));
  if (process.env.DEPLOYMENT_PREFLIGHT_ONLY === "1") {
    console.log("ISOLATED PREFLIGHT PASS — no journal or transactions created.");
    return;
  }
  const record = newIsolatedRecord(prior);
  record.historicalRecords = Object.fromEntries(HISTORY_PATHS.map((path, i) => [path.slice(ROOT.length + 1).replace(/\\/g, "/"), keccak256(Buffer.from(texts[i]))]));
  phase = "journal creation";
  const save = reserveIsolatedRecord(OUTPUT, record);
  phase = "journaled deployment/setup";
  const addresses = await deployIsolated(prior, signer, record, save);
  console.log(JSON.stringify({ status: "ISOLATED DEPLOYMENT VERIFIED", addresses, record: OUTPUT, transactions: record.transactions }, null, 2));
  console.log("STOP — no frontend switch, deposits, principal sync, yield injection, harvest or draw performed.");
}

if (require.main === module) main().catch((error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  const isCheckError = error instanceof IsolationCheckError || (error instanceof Error && error.constructor.name === "DeploymentCheckError");
  const detail = isCheckError ? (error as Error).message : typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "Unexpected error; provider details suppressed to protect credentials";
  console.error(`ISOLATED DEPLOYMENT STOPPED during ${phase}: ${detail}`);
  console.error(existsSync(OUTPUT) ? "Journal exists: inspect activeStep/nonce/hash read-only. Do not rerun automatically." : "No isolated journal exists: this entry point has not reached a broadcast.");
  process.exitCode = 1;
});
