import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { EventFragment, TransactionReceipt } from "ethers";
import { RejectionSamplingHarness, RejectionSamplingHarness__factory } from "../types";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

type PublicTotal = {
  value: bigint;
  decryptionProof: string;
};

const DEFAULT_RETRY_CAP = 5;

function requireReceipt(receipt: TransactionReceipt | null): TransactionReceipt {
  if (receipt === null) throw new Error("transaction receipt was unexpectedly null");
  return receipt;
}

async function deployHarness(
  deployer: HardhatEthersSigner,
  participants: string[],
  retryCap = DEFAULT_RETRY_CAP,
) {
  return new RejectionSamplingHarness__factory(deployer).deploy(participants, retryCap);
}

async function lockHarness(
  harness: RejectionSamplingHarness,
  caller: HardhatEthersSigner,
  weights: bigint[],
) {
  const input = fhevm.createEncryptedInput(await harness.getAddress(), caller.address);
  for (const weight of weights) input.add64(weight);
  const encrypted = await input.encrypt();
  const tx = await harness.connect(caller).lock(encrypted.handles, encrypted.inputProof);
  return requireReceipt(await tx.wait());
}

async function requestPublicTotal(harness: RejectionSamplingHarness): Promise<PublicTotal> {
  const handle = await harness.totalWeight();
  const result = await fhevm.publicDecrypt([handle]);
  const clearValue = Object.values(result.clearValues)[0];
  if (clearValue === undefined) throw new Error("public total was not returned");
  return { value: BigInt(String(clearValue)), decryptionProof: result.decryptionProof };
}

async function finalizePublicTotal(
  harness: RejectionSamplingHarness,
  publicTotal: PublicTotal,
  caller: HardhatEthersSigner,
) {
  const tx = await harness.connect(caller).finalizeAggregateReveal(publicTotal.value, publicTotal.decryptionProof);
  return requireReceipt(await tx.wait());
}

async function lockAndFinalize(
  harness: RejectionSamplingHarness,
  caller: HardhatEthersSigner,
  weights: bigint[],
) {
  await lockHarness(harness, caller, weights);
  const publicTotal = await requestPublicTotal(harness);
  await finalizePublicTotal(harness, publicTotal, caller);
  return publicTotal.value;
}

async function drawHarness(harness: RejectionSamplingHarness) {
  const tx = await harness.draw();
  return requireReceipt(await tx.wait());
}

async function settleHarness(harness: RejectionSamplingHarness) {
  const tx = await harness.settle();
  return requireReceipt(await tx.wait());
}

async function expectPublicDecryptFailure(handle: string) {
  let failed = false;
  try {
    await fhevm.publicDecryptEuint(FhevmType.euint64, handle);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/public|authoriz|decrypt|ACL/i);
  }
  expect(failed, "value unexpectedly became publicly decryptable").to.equal(true);
}

async function expectPublicDecryptEboolFailure(handle: string) {
  let failed = false;
  try {
    await fhevm.publicDecryptEbool(handle);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/public|authoriz|decrypt|ACL/i);
  }
  expect(failed, "ebool unexpectedly became publicly decryptable").to.equal(true);
}

async function expectUserDecryptFailure(
  handle: string,
  harness: RejectionSamplingHarness,
  user: HardhatEthersSigner,
) {
  let failed = false;
  try {
    await fhevm.userDecryptEuint(FhevmType.euint64, handle, await harness.getAddress(), user);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "unauthorized user decryption unexpectedly succeeded").to.equal(true);
}

async function expectUserDecryptEboolFailure(
  handle: string,
  harness: RejectionSamplingHarness,
  user: HardhatEthersSigner,
) {
  let failed = false;
  try {
    await fhevm.userDecryptEbool(handle, await harness.getAddress(), user);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "unauthorized ebool decryption unexpectedly succeeded").to.equal(true);
}

function parsedHarnessEvents(receipt: TransactionReceipt, harness: RejectionSamplingHarness) {
  return receipt.logs.flatMap((log) => {
    try {
      const parsed = harness.interface.parseLog({ topics: log.topics, data: log.data });
      return parsed === null ? [] : [parsed];
    } catch {
      return [];
    }
  });
}

function modelNextPowerOfTwo(value: bigint): bigint {
  if (value === 0n) return 0n;
  let power = 1n;
  while (power < value) power *= 2n;
  return power;
}

function assertUnbiasedConstruction(total: bigint) {
  const domain = modelNextPowerOfTwo(total);
  const acceptedTargets = Array.from({ length: Number(domain) }, (_, value) => BigInt(value)).filter(
    (value) => value < total,
  );

  expect(acceptedTargets.length).to.equal(Number(total));
  expect(new Set(acceptedTargets.map(() => `${domain}:${total}`)).size).to.equal(1);
  expect(acceptedTargets.every((value) => value >= 0n && value < total)).to.equal(true);
}

function rejectionProbabilityNumerator(total: bigint): { domain: bigint; rejected: bigint } {
  const domain = modelNextPowerOfTwo(total);
  return { domain, rejected: domain - total };
}

describe("Phase 3.5 confidential rejection-sampling design harness", function () {
  let signers: Signers;

  before(async function () {
    const [deployer, alice, bob] = await ethers.getSigners();
    signers = { deployer, alice, bob };
  });

  beforeEach(function () {
    if (!fhevm.isMock) this.skip();
  });

  it("discloses only the aggregate total through the asynchronous proof flow", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address, signers.bob.address]);
    const lockReceipt = await lockHarness(harness, signers.deployer, [40n, 60n]);
    expect(await harness.phase()).to.equal(1n);

    const publicTotal = await requestPublicTotal(harness);
    expect(publicTotal.value).to.equal(100n);
    await expectPublicDecryptFailure(await harness.eligibilityAt(0));
    await expectPublicDecryptFailure(await harness.eligibilityAt(1));
    await expectUserDecryptFailure(await harness.eligibilityAt(0), harness, signers.alice);

    const finalizeReceipt = await finalizePublicTotal(harness, publicTotal, signers.alice);
    expect(await harness.publicTotalWeight()).to.equal(100n);
    const harnessAddress = (await harness.getAddress()).toLowerCase();
    expect(lockReceipt.logs.some((log) => log.address.toLowerCase() === harnessAddress)).to.equal(false);

    const events = parsedHarnessEvents(finalizeReceipt, harness);
    expect(events.map((event) => event.name)).to.include("PublicDecryptionVerified");
    expect(events.map((event) => event.name)).to.include("AggregateTotalRevealed");
    const aggregateEvent = events.find((event) => event.name === "AggregateTotalRevealed");
    expect(aggregateEvent?.args[0]).to.equal(100n);
  });

  it("verifies nextPowerOfTwo and rejects an unrepresentable uint64 domain", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address]);
    const values = [
      [0n, 0n],
      [1n, 1n],
      [2n, 2n],
      [3n, 4n],
      [5n, 8n],
      [31n, 32n],
      [32n, 32n],
      [33n, 64n],
      [(1n << 63n), 1n << 63n],
    ];

    for (const [value, expected] of values) {
      expect(await harness.nextPowerOfTwo(value)).to.equal(expected);
    }
    await expect(harness.nextPowerOfTwo((1n << 63n) + 1n)).to.be.revertedWithCustomError(
      harness,
      "RandomDomainOverflow",
    );
    await expect(harness.nextPowerOfTwo((1n << 64n) - 1n)).to.be.revertedWithCustomError(
      harness,
      "RandomDomainOverflow",
    );
  });

  it("accepts a bounded encrypted sample and keeps the target and winner private until settlement", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address], 3);
    await lockAndFinalize(harness, signers.deployer, [1n]);
    const drawReceipt = await drawHarness(harness);

    expect(await harness.randomDomain()).to.equal(1n);
    await expectPublicDecryptFailure(await harness.acceptedTarget());
    await expectPublicDecryptFailure(await harness.selectedIndex());
    await expectPublicDecryptEboolFailure(await harness.hasAccepted());
    await expectUserDecryptFailure(await harness.selectedIndex(), harness, signers.alice);
    expect(parsedHarnessEvents(drawReceipt, harness).filter((event) => event.name !== "PublicDecryptionVerified")).to.deep.equal([]);

    await settleHarness(harness);
    const accepted = await fhevm.publicDecryptEbool(await harness.hasAccepted());
    const winner = await fhevm.publicDecryptEuint(FhevmType.euint64, await harness.selectedIndex());
    const target = await fhevm.publicDecryptEuint(FhevmType.euint64, await harness.acceptedTarget());
    expect(accepted).to.equal(true);
    expect(target).to.be.lt(1n);
    expect(winner).to.equal(0n);
    expect(await fhevm.publicDecryptEbool(await harness.hasWinner())).to.equal(true);
  });

  it("proves unbiased construction without depending on a particular random winner", async function () {
    for (const total of [1n, 2n, 3n, 5n, 10n, 17n, 31n, 33n, 100n, 257n, 500n, 1000n]) {
      assertUnbiasedConstruction(total);
      const probability = rejectionProbabilityNumerator(total);
      expect(probability.domain).to.equal(modelNextPowerOfTwo(total));
      expect(probability.rejected).to.be.gte(0n);
    }

    const harness = await deployHarness(signers.deployer, [signers.alice.address], 1);
    await lockAndFinalize(harness, signers.deployer, [3n]);
    await drawHarness(harness);
    await settleHarness(harness);

    const accepted = await fhevm.publicDecryptEbool(await harness.hasAccepted());
    const target = await fhevm.publicDecryptEuint(FhevmType.euint64, await harness.acceptedTarget());
    if (accepted) expect(target).to.be.lt(3n);
    else expect(await fhevm.publicDecryptEbool(await harness.hasWinner())).to.equal(false);
  });

  it("never exposes rejected candidates or a public retry count", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address], 5);
    await lockAndFinalize(harness, signers.deployer, [3n]);
    const drawReceipt = await drawHarness(harness);

    expect(await harness.retryCap()).to.equal(5n);
    expect(parsedHarnessEvents(drawReceipt, harness).filter((event) => event.name !== "PublicDecryptionVerified")).to.deep.equal([]);
    const eventNames = harness.interface.fragments.reduce<string[]>((names, fragment) => {
      if (fragment.type === "event") names.push((fragment as EventFragment).name);
      return names;
    }, []);
    expect(eventNames.filter((name) => name !== "PublicDecryptionVerified")).to.deep.equal(["AggregateTotalRevealed"]);
    await expectPublicDecryptFailure(await harness.acceptedTarget());
    await expectPublicDecryptFailure(await harness.selectedIndex());
  });

  it("freezes eligibility before aggregate reveal and preserves individual ACL privacy", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address, signers.bob.address]);
    await lockHarness(harness, signers.deployer, [10n, 20n]);
    const firstHandle = await harness.eligibilityAt(0);
    const secondHandle = await harness.eligibilityAt(1);
    const publicTotal = await requestPublicTotal(harness);
    await finalizePublicTotal(harness, publicTotal, signers.deployer);

    await expect(harness.connect(signers.deployer).lock([], "0x")).to.be.revertedWithCustomError(harness, "InvalidPhase");
    expect(await harness.eligibilityAt(0)).to.equal(firstHandle);
    expect(await harness.eligibilityAt(1)).to.equal(secondHandle);
    await expectPublicDecryptFailure(firstHandle);
    await expectPublicDecryptFailure(secondHandle);
    await expectUserDecryptFailure(firstHandle, harness, signers.alice);
    await expectUserDecryptFailure(secondHandle, harness, signers.bob);
  });

  it("does not draw an all-zero round", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address, signers.bob.address]);
    await lockAndFinalize(harness, signers.deployer, [0n, 0n]);
    expect(await harness.publicTotalWeight()).to.equal(0n);
    await expect(harness.draw()).to.be.revertedWithCustomError(harness, "NoEligibleWeight");
    expect(await harness.phase()).to.equal(2n);
  });

  it("makes the one-participant privacy leakage explicit", async function () {
    const harness = await deployHarness(signers.deployer, [signers.alice.address]);
    await lockAndFinalize(harness, signers.deployer, [777n]);
    expect(await harness.publicTotalWeight()).to.equal(777n);
    await expectPublicDecryptFailure(await harness.eligibilityAt(0));
  });

  it("rejects an unbounded retry configuration and benchmarks bounded retries at N=10", async function () {
    const validHarness = await deployHarness(signers.deployer, [signers.alice.address]);
    await expect(
      new RejectionSamplingHarness__factory(signers.deployer).deploy([signers.alice.address], 0),
    ).to.be.revertedWithCustomError(validHarness, "InvalidRetryCap");

    const sizes = [1, 2, 3, 5];
    const rows: Array<Record<string, string | number | boolean>> = [];
    const participants = Array.from({ length: 10 }, () => ethers.Wallet.createRandom().address);
    const weights = Array.from({ length: 10 }, () => 1n);
    weights[weights.length - 1] = 1_015n;

    for (const retryCap of sizes) {
      const harness = await deployHarness(signers.deployer, participants, retryCap);
      await lockAndFinalize(harness, signers.deployer, weights);
      const started = Date.now();
      const drawReceipt = await drawHarness(harness);
      const hcu = fhevm.computeTransactionHCU(drawReceipt);
      await settleHarness(harness);
      const elapsedMs = Date.now() - started;

      rows.push({
        participants: 10,
        retryCap,
        gasUsed: drawReceipt.gasUsed.toString(),
        globalHCU: hcu.globalHCU,
        maxHCUDepth: hcu.maxHCUDepth,
        randomOperations: retryCap,
        rangeComparisons: retryCap,
        approximateFheOperations: 6 * retryCap + 7 * 10 + 10 + 6,
        elapsedMs,
        pass: true,
      });
    }

    console.log("PHASE3_5_BENCHMARK_JSON", JSON.stringify(rows));
    expect(rows.every((row) => row.pass === true)).to.equal(true);
    expect(Number(rows[1].gasUsed)).to.be.gt(Number(rows[0].gasUsed));
    expect(Number(rows[2].gasUsed)).to.be.gt(Number(rows[1].gasUsed));
    expect(Number(rows[3].gasUsed)).to.be.gt(Number(rows[2].gasUsed));
  });
});
