import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { ethers, fhevm } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import historyOnDisk from "../deployments/sepolia.json";
import {
  deployV2, newV2Record, reserveV2Record, validateSepoliaTarget,
  verifyV1Reuse, verifyV2Relationships, type V1Deployment, type V2Record,
} from "../scripts/deploy-sepolia-v2";
import {
  ERC4626YieldAdapter__factory, MockUnderlyingToken__factory, PrizeEngine__factory,
  SepoliaYieldVault__factory, VeilPoolConfidentialToken__factory, VeilPool__factory,
} from "../types";

async function fixture() {
  const [operator, participant, other] = await ethers.getSigners();
  const underlying = await new MockUnderlyingToken__factory(operator).deploy();
  const wrapper = await new VeilPoolConfidentialToken__factory(operator).deploy(await underlying.getAddress());
  const vault = await new VeilPool__factory(operator).deploy(await wrapper.getAddress(), 10);
  const yieldVault = await new SepoliaYieldVault__factory(operator).deploy(await underlying.getAddress(), operator.address);
  const adapter = await new ERC4626YieldAdapter__factory(operator).deploy(await underlying.getAddress(), await yieldVault.getAddress());
  const engine = await new PrizeEngine__factory(operator).deploy(await vault.getAddress(), await wrapper.getAddress(), operator.address);
  await (await vault.setPrizeEngine(await engine.getAddress())).wait();
  await (await adapter.setController(await engine.getAddress())).wait();
  await (await engine.setYieldAdapter(await adapter.getAddress())).wait();
  const contracts = { underlyingToken: underlying, confidentialToken: wrapper, veilPool: vault, sepoliaYieldVault: yieldVault, yieldAdapter: adapter, prizeEngine: engine };
  const history: V1Deployment = {
    status: "complete", network: "hardhat", chainId: 31337, deployer: operator.address, operator: operator.address,
    contracts: Object.fromEntries(await Promise.all(Object.entries(contracts).map(async ([name, contract]) => [name, { address: await contract.getAddress() }]))) as V1Deployment["contracts"],
  };
  return { operator, participant, other, underlying, wrapper, vault, yieldVault, adapter, engine, history };
}

// Populate a real local legacy position and deploy its principal via the normal
// asynchronous FHE flow; V2 setup must not touch either the position or its shares.
async function fundedFixture() {
  const f = await fixture();
  await (await f.underlying.mint(f.participant.address, 100_000_000n)).wait();
  await (await f.underlying.connect(f.participant).approve(await f.wrapper.getAddress(), 100_000_000n)).wait();
  await (await f.wrapper.connect(f.participant).wrap(f.participant.address, 100_000_000n)).wait();
  await (await f.wrapper.connect(f.participant).setOperator(await f.vault.getAddress(), (1n << 48n) - 1n)).wait();
  const input = await fhevm.createEncryptedInput(await f.wrapper.getAddress(), await f.vault.getAddress()).add64(100_000_000n).encrypt();
  await (await f.vault.connect(f.participant).deposit(input.handles[0], input.inputProof)).wait();
  await (await f.engine.requestPrincipalDeployment()).wait();
  const principal = await fhevm.publicDecrypt([await f.engine.confidentialPendingPrincipalLiability()]);
  await (await f.engine.finalizePrincipalDeployment(100_000_000n, principal.decryptionProof)).wait();
  const request = await f.engine.pendingPrincipalUnwrapRequest();
  const unwrap = await fhevm.publicDecrypt([request]);
  await (await f.engine.finalizePrincipalUnwrap(request, 100_000_000n, unwrap.decryptionProof)).wait();
  return f;
}

describe("Sepolia V2 deployment preparation (local only)", function () {
  beforeEach(function () { if (!fhevm.isMock) this.skip(); });

  it("pins Sepolia, all six historical addresses, and the operator before deployment", function () {
    const operator = historyOnDisk.operator;
    expect(() => validateSepoliaTarget(11155111n, "sepolia", historyOnDisk, operator, operator)).not.to.throw();
    expect(() => validateSepoliaTarget(31337n, "hardhat", historyOnDisk, operator, operator)).to.throw("requires Sepolia");
    expect(() => validateSepoliaTarget(11155111n, "sepolia", historyOnDisk, ethers.ZeroAddress, operator)).to.throw("signer/operator");
    expect(() => validateSepoliaTarget(11155111n, "sepolia", historyOnDisk, operator, ethers.ZeroAddress)).to.throw("configured operator");
    const wrongHistory = structuredClone(historyOnDisk);
    wrongHistory.contracts.confidentialToken.address = ethers.ZeroAddress;
    expect(() => validateSepoliaTarget(11155111n, "sepolia", wrongHistory, operator, operator)).to.throw("historical confidentialToken");
  });

  it("deploys only three contracts and wires them with three calls, retaining legacy positions and assets", async function () {
    const f = await loadFixture(fundedFixture);
    const snapshot = async () => ({
      position: await f.vault.confidentialBalanceOf(f.participant.address),
      winnings: await f.vault.confidentialWinningsOf(f.participant.address),
      eligibility: await f.vault.confidentialEligibilityOf(f.participant.address),
      principal: await f.adapter.principalDeployed(), shares: await f.yieldVault.balanceOf(await f.adapter.getAddress()),
      assets: await f.yieldVault.totalAssets(), supply: await f.yieldVault.totalSupply(),
      tokenSupply: await f.underlying.totalSupply(), round: await f.engine.roundId(), state: await f.engine.roundState(),
      allowance: await f.underlying.allowance(f.participant.address, await f.wrapper.getAddress()),
      participantWrapper: await f.wrapper.confidentialBalanceOf(f.participant.address),
    });
    const before = await snapshot();
    const nonce = await f.operator.getNonce();
    const record = newV2Record(f.history);
    const saved: V2Record[] = [];
    const addresses = await deployV2(f.history, f.operator, record, value => saved.push(structuredClone(value)));
    expect(await f.operator.getNonce()).to.equal(nonce + 6);
    expect(Object.keys(record.transactions)).to.deep.equal(["veilPool", "yieldAdapter", "prizeEngine", "setPrizeEngine", "setAdapterController", "setYieldAdapter"]);
    expect(Object.values(record.contracts).filter(value => value!.reused)).to.have.length(3);
    for (const tx of Object.values(record.transactions)) {
      expect(tx.hash).to.match(/^0x[0-9a-f]{64}$/);
      expect(tx.block).to.be.greaterThan(0);
      expect(BigInt(tx.gasUsed!)).to.be.greaterThan(0n);
    }
    expect(record.status).to.equal("complete");
    expect(record.verified).to.equal(true);
    expect(saved.some(value => value.transactions.veilPool?.hash && !value.transactions.veilPool.block)).to.equal(true);
    expect(await snapshot()).to.deep.equal(before);
    const newVault = VeilPool__factory.connect(addresses.veilPool, f.operator);
    expect(await newVault.supportsWinningsWithdrawal()).to.equal(true);
    expect(await newVault.isParticipant(f.participant.address)).to.equal(false);
    expect(await newVault.confidentialWinningsOf(f.participant.address)).to.equal(ethers.ZeroHash);
    expect(await f.wrapper.isOperator(f.participant.address, addresses.veilPool)).to.equal(false);
    await expect(newVault.connect(f.participant).withdrawWinnings(ethers.ZeroHash, "0x")).to.be.revertedWithCustomError(newVault, "NotParticipant");
    await verifyV2Relationships(f.history, addresses, f.operator);
  });

  it("demonstrates the old one-time engine and controller wiring cannot be repointed", async function () {
    const f = await loadFixture(fixture);
    await expect(f.vault.setPrizeEngine(f.other.address)).to.be.revertedWithCustomError(f.vault, "PrizeEngineAlreadySet");
    await expect(f.adapter.setController(f.other.address)).to.be.revertedWithCustomError(f.adapter, "ControllerAlreadySet");
    await expect(f.engine.setYieldAdapter(await f.adapter.getAddress())).to.be.revertedWithCustomError(f.engine, "YieldAdapterAlreadySet");
  });

  it("rejects an incorrect signer without sending a deployment transaction", async function () {
    const f = await loadFixture(fixture);
    const nonce = await f.other.getNonce();
    await rejects(deployV2(f.history, f.other, newV2Record(f.history), () => {}), /V2 signer/);
    expect(await f.other.getNonce()).to.equal(nonce);
  });

  it("rejects changed yield ownership before deployment", async function () {
    const f = await loadFixture(fixture);
    await (await f.yieldVault.transferOwnership(f.other.address)).wait();
    const nonce = await f.operator.getNonce();
    await rejects(deployV2(f.history, f.operator, newV2Record(f.history), () => {}), /yield vault owner/);
    expect(await f.operator.getNonce()).to.equal(nonce);
  });

  it("rejects a wrong wrapper underlying even when the implementation bytecode matches", async function () {
    const f = await loadFixture(fixture);
    const otherToken = await new MockUnderlyingToken__factory(f.operator).deploy();
    const otherWrapper = await new VeilPoolConfidentialToken__factory(f.operator).deploy(await otherToken.getAddress());
    const wrong = structuredClone(f.history);
    wrong.contracts.confidentialToken.address = await otherWrapper.getAddress();
    await rejects(verifyV1Reuse(wrong, f.operator), /wrapper underlying/);
  });

  it("rejects missing or mismatched reusable bytecode and incorrect historical relationships", async function () {
    const f = await loadFixture(fixture);
    const wrong = structuredClone(f.history);
    wrong.contracts.sepoliaYieldVault.address = f.other.address;
    await rejects(verifyV1Reuse(wrong, f.operator), /No bytecode/);
    wrong.contracts.sepoliaYieldVault.address = await f.adapter.getAddress();
    await rejects(verifyV1Reuse(wrong, f.operator), /bytecode differs/);
    wrong.contracts.sepoliaYieldVault.address = await f.yieldVault.getAddress();
    const otherEngine = await new PrizeEngine__factory(f.operator).deploy(await f.vault.getAddress(), await f.wrapper.getAddress(), f.operator.address);
    wrong.contracts.prizeEngine.address = await otherEngine.getAddress();
    await rejects(verifyV1Reuse(wrong, f.operator), /old vault engine/);
  });

  it("fails post-setup verification when an expected relationship is incorrect", async function () {
    const f = await loadFixture(fixture);
    const addresses = await deployV2(f.history, f.operator, newV2Record(f.history), () => {});
    const otherEngine = await new PrizeEngine__factory(f.operator).deploy(addresses.veilPool, await f.wrapper.getAddress(), f.operator.address);
    await rejects(verifyV2Relationships(f.history, { ...addresses, prizeEngine: await otherEngine.getAddress() }, f.operator), /V2 vault engine/);
  });

  it("stops after a failed journal write and refuses to automatically redeploy the partial attempt", async function () {
    const f = await loadFixture(fixture);
    const record = newV2Record(f.history);
    const nonce = await f.operator.getNonce();
    await rejects(deployV2(f.history, f.operator, record, value => {
      if (value.transactions.veilPool?.hash) throw new Error("Simulated journal failure");
    }), /Simulated journal failure/);
    expect(await f.operator.getNonce()).to.equal(nonce + 1);
    expect(record.status).to.equal("partial");
    expect(record.activeStep).to.equal("veilPool");
    expect(record.transactions.veilPool.hash).to.match(/^0x[0-9a-f]{64}$/);
    await rejects(deployV2(f.history, f.operator, record, () => {}), /Refusing to resume/);
    expect(await f.operator.getNonce()).to.equal(nonce + 1);
  });

  it("writes a separate journal, refuses overwrites, and never changes the historical record", async function () {
    const f = await loadFixture(fixture);
    const historicalPath = resolve("deployments/sepolia.json");
    const before = readFileSync(historicalPath, "utf8");
    mkdirSync(".hardhat-runtime", { recursive: true });
    const dir = mkdtempSync(resolve(".hardhat-runtime/v2-record-test-"));
    const path = resolve(dir, "sepolia-v2.json");
    try {
      const record = newV2Record(f.history);
      expect(() => reserveV2Record(historicalPath, record)).to.throw("historical deployment");
      const save = reserveV2Record(path, record);
      expect(() => reserveV2Record(path, record)).to.throw();
      await deployV2(f.history, f.operator, record, save);
      expect(JSON.parse(readFileSync(path, "utf8"))).to.deep.equal(record);
      expect(readFileSync(historicalPath, "utf8")).to.equal(before);
    } finally {
      unlinkSync(path);
      rmdirSync(dir);
    }
  });
});
