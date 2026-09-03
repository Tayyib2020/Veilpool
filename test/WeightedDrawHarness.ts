import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { TransactionReceipt } from "ethers";
import { WeightedDrawHarness, WeightedDrawHarness__factory } from "../types";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

const RANDOM_DOMAIN = 1_024n;

function requireReceipt(receipt: TransactionReceipt | null): TransactionReceipt {
  if (receipt === null) throw new Error("transaction receipt was unexpectedly null");
  return receipt;
}

async function deployHarness(deployer: HardhatEthersSigner, participants: string[], randomDomain = RANDOM_DOMAIN) {
  return new WeightedDrawHarness__factory(deployer).deploy(participants, randomDomain);
}

async function lockHarness(
  harness: WeightedDrawHarness,
  caller: HardhatEthersSigner,
  weights: bigint[],
) {
  const harnessAddress = await harness.getAddress();
  const input = fhevm.createEncryptedInput(harnessAddress, caller.address);
  for (const weight of weights) input.add64(weight);
  const encrypted = await input.encrypt();
  const tx = await harness.connect(caller).lock(encrypted.handles, encrypted.inputProof);
  return requireReceipt(await tx.wait());
}

async function drawHarness(harness: WeightedDrawHarness) {
  const tx = await harness.draw();
  return requireReceipt(await tx.wait());
}

async function settleHarness(harness: WeightedDrawHarness) {
  const tx = await harness.settle();
  return requireReceipt(await tx.wait());
}

async function expectUserDecryptFailure(handle: string, harness: WeightedDrawHarness, user: HardhatEthersSigner) {
  let failed = false;
  try {
    await fhevm.userDecryptEuint(FhevmType.euint64, handle, await harness.getAddress(), user);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "unauthorized user decryption unexpectedly succeeded").to.equal(true);
}

async function expectUserDecryptEboolFailure(handle: string, harness: WeightedDrawHarness, user: HardhatEthersSigner) {
  let failed = false;
  try {
    await fhevm.userDecryptEbool(handle, await harness.getAddress(), user);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "unauthorized ebool decryption unexpectedly succeeded").to.equal(true);
}

async function expectPublicDecryptFailure(handle: string) {
  let failed = false;
  try {
    await fhevm.publicDecryptEuint(FhevmType.euint64, handle);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/public|authoriz|decrypt|ACL/i);
  }
  expect(failed, "intermediate value unexpectedly became publicly decryptable").to.equal(true);
}

async function expectPublicDecryptEboolFailure(handle: string) {
  let failed = false;
  try {
    await fhevm.publicDecryptEbool(handle);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/public|authoriz|decrypt|ACL/i);
  }
  expect(failed, "intermediate ebool unexpectedly became publicly decryptable").to.equal(true);
}

async function reveal(harness: WeightedDrawHarness) {
  const totalWeight = await fhevm.publicDecryptEuint(FhevmType.euint64, await harness.totalWeight());
  const randomTarget = await fhevm.publicDecryptEuint(FhevmType.euint64, await harness.randomTarget());
  const selectedIndex = await fhevm.publicDecryptEuint(FhevmType.euint64, await harness.selectedIndex());
  const hasWinner = await fhevm.publicDecryptEbool(await harness.hasWinner());
  const targetInRange = await fhevm.publicDecryptEbool(await harness.targetInRange());
  return { totalWeight, randomTarget, selectedIndex, hasWinner, targetInRange };
}

function assertSelectedWithinCumulative(weights: bigint[], randomTarget: bigint, selectedIndex: bigint) {
  expect(selectedIndex).to.be.gte(0n);
  expect(selectedIndex).to.be.lt(BigInt(weights.length));

  let cumulative = 0n;
  for (let i = 0; i < weights.length; ++i) {
    const previous = cumulative;
    cumulative += weights[i];
    if (BigInt(i) === selectedIndex) {
      expect(weights[i]).to.be.gt(0n);
      expect(randomTarget).to.be.gte(previous);
      expect(randomTarget).to.be.lt(cumulative);
      return;
    }
  }
  throw new Error("selected index was not found");
}

describe("Phase 3 encrypted weighted-draw feasibility harness", function () {
  let signers: Signers;

  before(async function () {
    const [deployer, alice, bob] = await ethers.getSigners();
    signers = { deployer, alice, bob };
  });

  beforeEach(function () {
    if (!fhevm.isMock) this.skip();
  });

  it("runs a one-participant draw through OPEN, LOCKED, DRAWING, and SETTLED", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address]);
    expect(await harness.phase()).to.equal(0n);
    await lockHarness(harness, signers.deployer, [RANDOM_DOMAIN]);
    expect(await harness.phase()).to.equal(1n);
    await drawHarness(harness);
    expect(await harness.phase()).to.equal(2n);

    await expectPublicDecryptFailure(await harness.randomTarget());
    await expectPublicDecryptFailure(await harness.selectedIndex());
    await expectUserDecryptFailure(await harness.randomTarget(), harness, signers.alice);
    await expectUserDecryptFailure(await harness.selectedIndex(), harness, signers.alice);

    await settleHarness(harness);
    expect(await harness.phase()).to.equal(3n);
    const result = await reveal(harness);
    expect(result.totalWeight).to.equal(RANDOM_DOMAIN);
    expect(result.randomTarget).to.be.lt(RANDOM_DOMAIN);
    expect(result.selectedIndex).to.equal(0n);
    expect(result.hasWinner).to.equal(true);
    expect(result.targetInRange).to.equal(true);
  });

  it("selects within cumulative unequal weights for two participants", async function () {
    const weights = [256n, 768n];
    const harness = await deployHarness(signers.deployer, [signers.alice.address, signers.bob.address]);
    await lockHarness(harness, signers.deployer, weights);
    await drawHarness(harness);
    await settleHarness(harness);

    const result = await reveal(harness);
    expect(result.totalWeight).to.equal(RANDOM_DOMAIN);
    expect(result.hasWinner).to.equal(true);
    expect(result.targetInRange).to.equal(true);
    assertSelectedWithinCumulative(weights, result.randomTarget, result.selectedIndex);
  });

  it("selects within cumulative unequal weights for multiple participants", async function () {
    const weights = [1n, 2n, 3n, 4n, 1_014n];
    const participants = [signers.alice.address, signers.bob.address, signers.deployer.address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
    const harness = await deployHarness(signers.deployer, participants);
    await lockHarness(harness, signers.deployer, weights);
    await drawHarness(harness);
    await settleHarness(harness);

    const result = await reveal(harness);
    expect(result.hasWinner).to.equal(true);
    expect(result.targetInRange).to.equal(true);
    assertSelectedWithinCumulative(weights, result.randomTarget, result.selectedIndex);
  });

  it("never selects a zero-weight participant", async function () {
    const weights = [0n, RANDOM_DOMAIN, 0n];
    const participants = [signers.alice.address, signers.bob.address, signers.deployer.address];
    const harness = await deployHarness(signers.deployer, participants);
    await lockHarness(harness, signers.deployer, weights);
    await drawHarness(harness);
    await settleHarness(harness);

    const result = await reveal(harness);
    expect(result.hasWinner).to.equal(true);
    expect(result.selectedIndex).to.equal(1n);
  });

  it("selects the only positive-weight participant among zero-weight participants", async function () {
    const weights = [0n, 0n, RANDOM_DOMAIN, 0n, 0n];
    const participants = weights.map(() => ethers.Wallet.createRandom().address);
    const harness = await deployHarness(signers.deployer, participants);
    await lockHarness(harness, signers.deployer, weights);
    await drawHarness(harness);
    await settleHarness(harness);

    const result = await reveal(harness);
    expect(result.hasWinner).to.equal(true);
    expect(result.selectedIndex).to.equal(2n);
  });

  it("rejects an all-zero round confidentially instead of silently selecting index zero", async function () {
    const weights = [0n, 0n, 0n, 0n];
    const participants = weights.map(() => ethers.Wallet.createRandom().address);
    const harness = await deployHarness(signers.deployer, participants);
    await lockHarness(harness, signers.deployer, weights);
    await drawHarness(harness);

    await expectPublicDecryptEboolFailure(await harness.hasWinner());
    await settleHarness(harness);
    const result = await reveal(harness);
    expect(result.totalWeight).to.equal(0n);
    expect(result.targetInRange).to.equal(false);
    expect(result.hasWinner).to.equal(false);
  });

  it("freezes the eligibility snapshot before RNG generation", async function () {
    const participants = [signers.alice.address, signers.bob.address];
    const weights = [256n, 768n];
    const harness = await deployHarness(signers.deployer, participants);
    const lockedReceipt = await lockHarness(harness, signers.deployer, weights);
    const firstHandle = await harness.eligibilityAt(0);
    const secondHandle = await harness.eligibilityAt(1);
    expect(lockedReceipt.gasUsed).to.be.gt(0n);

    let failed = false;
    try {
      await lockHarness(harness, signers.deployer, weights);
    } catch (error) {
      failed = true;
      expect(String(error)).to.match(/InvalidPhase|revert|custom error/i);
    }
    expect(failed, "eligibility snapshot was mutable after LOCKED").to.equal(true);
    await drawHarness(harness);
    expect(await harness.eligibilityAt(0)).to.equal(firstHandle);
    expect(await harness.eligibilityAt(1)).to.equal(secondHandle);
  });

  it("keeps total weight, RNG, and selected index private until settlement", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address, signers.bob.address]);
    await lockHarness(harness, signers.deployer, [256n, 768n]);
    await drawHarness(harness);

    for (const handle of [await harness.totalWeight(), await harness.randomTarget(), await harness.selectedIndex()]) {
      await expectPublicDecryptFailure(handle);
      await expectUserDecryptFailure(handle, harness, signers.alice);
    }
    await expectUserDecryptEboolFailure(await harness.hasWinner(), harness, signers.alice);
    await expectUserDecryptEboolFailure(await harness.targetInRange(), harness, signers.alice);
  });

  it("benchmarks the linear scan across the requested participant sizes", async function () {
    const sizes = [1, 2, 5, 10, 20, 30, 50];
    const rows: Array<Record<string, string | number | boolean>> = [];

    for (const size of sizes) {
      const participants = Array.from({ length: size }, () => ethers.Wallet.createRandom().address);
      const weights = Array.from({ length: size }, () => 1n);
      weights[size - 1] = RANDOM_DOMAIN - BigInt(size - 1);
      const additions = 2 * size;
      const comparisons = size + 1;
      const selects = size;
      const booleans = 3 * size;
      const trivialEncrypts = size + 3;
      const totalFheOperations = 8 * size + 5;

      const harness = await deployHarness(signers.deployer, participants);
      await lockHarness(harness, signers.deployer, weights);
      const started = Date.now();
      try {
        const drawReceipt = await drawHarness(harness);
        const elapsedMs = Date.now() - started;
        await settleHarness(harness);
        const result = await reveal(harness);
        rows.push({
          participants: size,
          gasUsed: drawReceipt.gasUsed.toString(),
          additions,
          comparisons,
          selects,
          randomOperations: 1,
          booleanOperations: booleans,
          trivialEncrypts,
          approximateFheOperations: totalFheOperations,
          elapsedMs,
          pass: result.hasWinner && result.targetInRange && result.totalWeight === RANDOM_DOMAIN,
        });
      } catch (error) {
        rows.push({
          participants: size,
          gasUsed: "unavailable",
          additions,
          comparisons,
          selects,
          randomOperations: 1,
          booleanOperations: booleans,
          trivialEncrypts,
          approximateFheOperations: totalFheOperations,
          elapsedMs: Date.now() - started,
          pass: false,
          failure: String(error).match(/custom error '[^']+'/)?.[0] ?? String(error).split("\n")[0],
        });
        break;
      }
    }

    console.log("PHASE3_BENCHMARK_JSON", JSON.stringify(rows));
    expect(rows.slice(0, -1).every((row) => row.pass === true)).to.equal(true);
    expect(rows[rows.length - 1].participants).to.equal(30);
    expect(rows[rows.length - 1].pass).to.equal(false);
    expect(Number(rows[rows.length - 2].gasUsed)).to.be.gt(Number(rows[0].gasUsed));
  });
});
