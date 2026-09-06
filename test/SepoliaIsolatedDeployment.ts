import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { ethers, fhevm } from "hardhat";
import v1Record from "../deployments/sepolia.json";
import v2Record from "../deployments/sepolia-v2.json";
import {
  deployIsolated, historicalAccounting, newIsolatedRecord, reserveIsolatedRecord,
  validateIsolatedTarget, verifyHistoricalTopology, verifyIsolatedRelationships, type PriorDeployments,
} from "../scripts/deploy-sepolia-v2-isolated";
import type { V1Deployment } from "../scripts/deploy-sepolia-v2";
import {
  ERC4626YieldAdapter__factory, MockUnderlyingToken__factory, PrizeEngine__factory,
  SepoliaYieldVault__factory, VeilPoolConfidentialToken__factory, VeilPool__factory,
  type VeilPool, type PrizeEngine,
} from "../types";

// Fresh fixtures intentionally avoid EVM snapshot rewinds: the installed FHE mock
// can otherwise return an empty public-decryption value in a subsequent suite.
async function fixture() {
  const [operator, alice, bob, donor] = await ethers.getSigners();
  const token = await new MockUnderlyingToken__factory(operator).deploy();
  const wrapper = await new VeilPoolConfidentialToken__factory(operator).deploy(await token.getAddress());
  const shared = await new SepoliaYieldVault__factory(operator).deploy(await token.getAddress(), operator.address);
  async function pool() {
    const vault = await new VeilPool__factory(operator).deploy(await wrapper.getAddress(), 10);
    const adapter = await new ERC4626YieldAdapter__factory(operator).deploy(await token.getAddress(), await shared.getAddress());
    const engine = await new PrizeEngine__factory(operator).deploy(await vault.getAddress(), await wrapper.getAddress(), operator.address);
    await (await vault.setPrizeEngine(await engine.getAddress())).wait();
    await (await adapter.setController(await engine.getAddress())).wait();
    await (await engine.setYieldAdapter(await adapter.getAddress())).wait();
    const contracts = { underlyingToken: token, confidentialToken: wrapper, sepoliaYieldVault: shared, veilPool: vault, yieldAdapter: adapter, prizeEngine: engine };
    const history: V1Deployment = {
      status: "complete", network: "hardhat", chainId: 31337, deployer: operator.address, operator: operator.address,
      contracts: Object.fromEntries(await Promise.all(Object.entries(contracts).map(async ([key, value]) => [key, { address: await value.getAddress() }]))) as V1Deployment["contracts"],
    };
    return { vault, adapter, engine, history };
  }
  const v1 = await pool(), v2 = await pool();
  const prior: PriorDeployments = { v1: v1.history, v2: { ...v2.history, version: 2, verified: true } };
  return { operator, alice, bob, donor, token, wrapper, shared, v1, v2, prior };
}

async function fundedFixture() {
  const f = await fixture();
  // Reconstruct the last observed shared-vault exchange rate and V1 share count,
  // not V1's historical transaction sequence or private positions.
  await (await f.token.mint(f.operator.address, 275_000_002n)).wait();
  await (await f.token.approve(await f.shared.getAddress(), 275_000_002n)).wait();
  await (await f.shared.deposit(131_750_871n, await f.v1.adapter.getAddress())).wait();
  await (await f.shared.addTestYield(143_249_131n)).wait();
  await depositAndDeployPrincipal(f, f.v2);
  return f;
}

async function depositAndDeployPrincipal(f: Awaited<ReturnType<typeof fixture>>, pool: { vault: VeilPool; engine: PrizeEngine }) {
  for (const [participant, amount] of [[f.alice, 40_000_000n], [f.bob, 50_000_000n]] as const) {
    await (await f.token.mint(participant.address, amount)).wait();
    await (await f.token.connect(participant).approve(await f.wrapper.getAddress(), amount)).wait();
    await (await f.wrapper.connect(participant).wrap(participant.address, amount)).wait();
    await (await f.wrapper.connect(participant).setOperator(await pool.vault.getAddress(), (1n << 48n) - 1n)).wait();
    const input = await fhevm.createEncryptedInput(await f.wrapper.getAddress(), await pool.vault.getAddress()).add64(amount).encrypt();
    await (await pool.vault.connect(participant).deposit(input.handles[0], input.inputProof)).wait();
  }
  await (await pool.engine.requestPrincipalDeployment()).wait();
  const principal = await fhevm.publicDecrypt([await pool.engine.confidentialPendingPrincipalLiability()]);
  await (await pool.engine.finalizePrincipalDeployment(90_000_000n, principal.decryptionProof)).wait();
  const request = await pool.engine.pendingPrincipalUnwrapRequest();
  const unwrapped = await fhevm.publicDecrypt([request]);
  await (await pool.engine.finalizePrincipalUnwrap(request, 90_000_000n, unwrapped.decryptionProof)).wait();
}

describe("Isolated Sepolia deployment preparation (local only)", function () {
  beforeEach(function () { if (!fhevm.isMock) this.skip(); });

  it("pins both completed histories, operator, and Sepolia before any broadcast", function () {
    const prior = { v1: v1Record, v2: v2Record };
    expect(() => validateIsolatedTarget(prior, 11155111n, "sepolia", v1Record.operator, v1Record.operator)).not.to.throw();
    expect(() => validateIsolatedTarget(prior, 31337n, "hardhat", v1Record.operator, v1Record.operator)).to.throw("Sepolia");
    const wrong = structuredClone(prior);
    wrong.v2.contracts.yieldAdapter.address = ethers.ZeroAddress;
    expect(() => validateIsolatedTarget(wrong, 11155111n, "sepolia", v1Record.operator, v1Record.operator)).to.throw("historical V2 yieldAdapter");
    expect(() => validateIsolatedTarget(prior, 11155111n, "sepolia", ethers.ZeroAddress, v1Record.operator)).to.throw("signer/operator");
  });

  it("performs exactly seven ordered transactions, starts empty with winnings capability, and preserves both histories", async function () {
    const f = await fundedFixture();
    const record = newIsolatedRecord(f.prior);
    const before = await historicalAccounting(f.prior, f.operator);
    const position = await f.v2.vault.confidentialBalanceOf(f.alice.address);
    const nonce = await f.operator.getNonce();
    const addresses = await deployIsolated(f.prior, f.operator, record, () => {});
    expect(await f.operator.getNonce()).to.equal(nonce + 7);
    expect(Object.keys(record.transactions)).to.deep.equal(["sepoliaYieldVault", "veilPool", "yieldAdapter", "prizeEngine", "setPrizeEngine", "setAdapterController", "setYieldAdapter"]);
    expect(Object.values(record.contracts).filter(c => c.reused)).to.have.length(2);
    for (const tx of Object.values(record.transactions)) {
      expect(tx.hash).to.match(/^0x[0-9a-f]{64}$/);
      expect(tx.block).to.be.greaterThan(0);
      expect(BigInt(tx.gasUsed!)).to.be.greaterThan(0n);
    }
    expect(record.legacyBefore).to.deep.equal(before);
    expect(record.legacyAfter).to.deep.equal(before);
    expect(await f.v2.vault.confidentialBalanceOf(f.alice.address)).to.equal(position);
    expect(record.status).to.equal("complete");
    expect(record.verified).to.equal(true);
    const vault = VeilPool__factory.connect(addresses.veilPool, f.operator);
    expect(await vault.supportsWinningsWithdrawal()).to.equal(true);
    expect(await vault.isParticipant(f.alice.address)).to.equal(false);
    expect(await f.wrapper.isOperator(f.alice.address, addresses.veilPool)).to.equal(false);
    await verifyIsolatedRelationships(f.prior, addresses, f.operator);
  });

  it("keeps later local dedicated-vault yield out of both historical adapters", async function () {
    const f = await fundedFixture();
    const addresses = await deployIsolated(f.prior, f.operator, newIsolatedRecord(f.prior), () => {});
    const dedicated = SepoliaYieldVault__factory.connect(addresses.sepoliaYieldVault, f.operator);
    const adapter = ERC4626YieldAdapter__factory.connect(addresses.yieldAdapter, f.operator);
    const before = await historicalAccounting(f.prior, f.operator);
    // Local-only production principal flow and test donation; neither is in the script.
    await depositAndDeployPrincipal(f, { vault: VeilPool__factory.connect(addresses.veilPool, f.operator), engine: PrizeEngine__factory.connect(addresses.prizeEngine, f.operator) });
    await (await f.token.mint(f.operator.address, 12_000_000n)).wait();
    await (await f.token.approve(addresses.sepoliaYieldVault, 12_000_000n)).wait();
    const managedBefore = await adapter.managedAssets();
    await (await dedicated.addTestYield(12_000_000n)).wait();
    expect(await adapter.managedAssets()).to.be.greaterThan(managedBefore);
    expect(await adapter.principalDeployed()).to.equal(90_000_000n);
    expect(await adapter.generatedYield()).to.equal(11_999_999n);
    expect(await historicalAccounting(f.prior, f.operator)).to.deep.equal(before);
    expect(await dedicated.balanceOf(await f.v1.adapter.getAddress())).to.equal(0n);
    expect(await dedicated.balanceOf(await f.v2.adapter.getAddress())).to.equal(0n);
  });

  it("rejects a wrong signer or changed legacy wiring before deploying", async function () {
    const f = await fixture();
    const nonce = await f.operator.getNonce();
    await rejects(deployIsolated(f.prior, f.donor, newIsolatedRecord(f.prior), () => {}), /signer mismatch/);
    const wrong = structuredClone(f.prior);
    wrong.v2.contracts.prizeEngine.address = await f.v1.engine.getAddress();
    await rejects(deployIsolated(wrong, f.operator, newIsolatedRecord(wrong), () => {}), /v2 vault engine/);
    expect(await f.operator.getNonce()).to.equal(nonce);
  });

  it("rejects missing token bytecode and changed reusable assets or legacy owner", async function () {
    const f = await fixture();
    const wrong = structuredClone(f.prior);
    wrong.v1.contracts.underlyingToken.address = f.donor.address;
    await rejects(verifyHistoricalTopology(wrong, f.operator), /bytecode differs/);
    await (await f.shared.transferOwnership(f.donor.address)).wait();
    await rejects(verifyHistoricalTopology(f.prior, f.operator), /yield owner/);
  });

  it("rejects historical yield-vault reuse, incorrect new wiring, or funded initial state", async function () {
    const f = await fixture();
    const addresses = await deployIsolated(f.prior, f.operator, newIsolatedRecord(f.prior), () => {});
    await rejects(verifyIsolatedRelationships(f.prior, { ...addresses, sepoliaYieldVault: await f.shared.getAddress() }, f.operator), /must not reuse/);
    const otherYield = await new SepoliaYieldVault__factory(f.operator).deploy(await f.token.getAddress(), f.operator.address);
    await rejects(verifyIsolatedRelationships(f.prior, { ...addresses, sepoliaYieldVault: await otherYield.getAddress() }, f.operator), /adapter yield vault/);
    await (await f.token.mint(addresses.sepoliaYieldVault, 1n)).wait();
    await rejects(verifyIsolatedRelationships(f.prior, addresses, f.operator), /must be empty/);
  });

  it("journals intent before broadcast, retains partial evidence on failure, and refuses an automatic resume", async function () {
    const f = await fixture();
    const record = newIsolatedRecord(f.prior);
    const nonce = await f.operator.getNonce();
    let sawIntent = false;
    await rejects(deployIsolated(f.prior, f.operator, record, value => {
      const tx = value.transactions.sepoliaYieldVault;
      if (tx && !tx.hash) sawIntent = true;
      if (tx?.hash) throw new Error("Simulated disk failure");
    }), /Simulated disk failure/);
    expect(sawIntent).to.equal(true);
    expect(await f.operator.getNonce()).to.equal(nonce + 1);
    expect(record.status).to.equal("partial");
    expect(record.activeStep).to.equal("sepoliaYieldVault");
    expect(record.transactions.sepoliaYieldVault.hash).to.match(/^0x[0-9a-f]{64}$/);
    await rejects(deployIsolated(f.prior, f.operator, record, () => {}), /Refusing to resume/);
    expect(await f.operator.getNonce()).to.equal(nonce + 1);
  });

  it("protects both historical records and refuses an existing isolated journal", async function () {
    const f = await fixture();
    const record = newIsolatedRecord(f.prior);
    const paths = [resolve("deployments/sepolia.json"), resolve("deployments/sepolia-v2.json")];
    const texts = paths.map(path => readFileSync(path, "utf8"));
    for (const path of paths) expect(() => reserveIsolatedRecord(path, record)).to.throw("historical deployment record");
    mkdirSync(".hardhat-runtime", { recursive: true });
    const dir = mkdtempSync(resolve(".hardhat-runtime/isolated-record-test-"));
    const path = resolve(dir, "sepolia-v2-isolated.json");
    try {
      const save = reserveIsolatedRecord(path, record);
      expect(() => reserveIsolatedRecord(path, record)).to.throw();
      await deployIsolated(f.prior, f.operator, record, save);
      expect(JSON.parse(readFileSync(path, "utf8"))).to.deep.equal(record);
      expect(paths.map(p => readFileSync(p, "utf8"))).to.deep.equal(texts);
    } finally { unlinkSync(path); rmdirSync(dir); }
  });
});

describe("Current V2 restoration shortfall — reconstructed public snapshot, local only", function () {
  beforeEach(function () { if (!fhevm.isMock) this.skip(); });

  it("reproduces exactly 43118466 shares, 89999998 managed assets, and the restoration revert", async function () {
    const f = await fundedFixture();
    expect(await f.shared.totalAssets()).to.equal(365_000_002n);
    expect(await f.shared.totalSupply()).to.equal(174_869_337n);
    expect(await f.shared.balanceOf(await f.v2.adapter.getAddress())).to.equal(43_118_466n);
    expect(await f.v2.adapter.principalDeployed()).to.equal(90_000_000n);
    expect(await f.v2.adapter.managedAssets()).to.equal(89_999_998n);
    expect(await f.v2.adapter.generatedYield()).to.equal(0n);
    await expect(f.v2.engine.restorePrincipalLiquidity.staticCall()).to.be.revertedWithCustomError(f.v2.adapter, "InsufficientManagedAssets");
  });

  it("proves a direct underlying top-up cannot repair a share-only managedAssets guard", async function () {
    const f = await fundedFixture();
    await (await f.token.mint(await f.v2.adapter.getAddress(), 2n)).wait();
    expect(await f.v2.adapter.managedAssets()).to.equal(89_999_998n);
    await expect(f.v2.engine.restorePrincipalLiquidity.staticCall()).to.be.revertedWithCustomError(f.v2.adapter, "InsufficientManagedAssets");
  });

  it("models the smallest one-share sponsor recovery and exposes its V1 rounding side effect", async function () {
    const f = await fundedFixture();
    const v1ManagedBefore = await f.v1.adapter.managedAssets();
    const v1SharesBefore = await f.shared.balanceOf(await f.v1.adapter.getAddress());
    expect(await f.shared.previewDeposit(1n)).to.equal(0n);
    expect(await f.shared.previewDeposit(2n)).to.equal(0n);
    expect(await f.shared.previewMint(1n)).to.equal(3n);
    await (await f.token.mint(f.donor.address, 3n)).wait();
    await (await f.token.connect(f.donor).approve(await f.shared.getAddress(), 3n)).wait();
    await (await f.shared.connect(f.donor).mint(1n, await f.v2.adapter.getAddress())).wait();
    expect(await f.v2.adapter.managedAssets()).to.equal(90_000_001n);
    expect(await f.v2.adapter.principalDeployed()).to.equal(90_000_000n);
    expect(await f.v1.adapter.managedAssets()).to.equal(v1ManagedBefore);
    await (await f.v2.engine.restorePrincipalLiquidity()).wait();
    expect(await f.v2.adapter.principalDeployed()).to.equal(0n);
    expect(await f.token.balanceOf(await f.wrapper.getAddress())).to.equal(90_000_000n);
    expect(await f.v2.engine.publicPrincipalLiability()).to.equal(90_000_000n);
    expect(await f.shared.balanceOf(await f.v1.adapter.getAddress())).to.equal(v1SharesBefore);
    // Full restoration burns rounded-up shares and increases V1's computed asset
    // value by one unit. Thus this is NOT a zero-V1-impact authorized recovery.
    expect(await f.v1.adapter.managedAssets()).to.equal(v1ManagedBefore + 1n);
  });
});
