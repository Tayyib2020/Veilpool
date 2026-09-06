import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { EventFragment, TransactionReceipt } from "ethers";
import {
  MockUnderlyingToken,
  MockUnderlyingToken__factory,
  PrizeEngine,
  PrizeEngineDeterministicHarness,
  PrizeEngineDeterministicHarness__factory,
  PrizeEngine__factory,
  VeilPool,
  VeilPoolConfidentialToken,
  VeilPoolConfidentialToken__factory,
  VeilPool__factory,
} from "../types";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
};

type EngineLike = PrizeEngine;

type Fixture = {
  signers: Signers;
  underlying: MockUnderlyingToken;
  wrapper: VeilPoolConfidentialToken;
  vault: VeilPool;
  engine: EngineLike;
  deterministic?: PrizeEngineDeterministicHarness;
};

const TWO_PARTICIPANT_TOTAL = 128n;
const ALICE_PRINCIPAL = 80n;
const BOB_PRINCIPAL = 48n;
const PRIZE = 10n;
const MAX_UINT48 = (1n << 48n) - 1n;

function requireReceipt(receipt: TransactionReceipt | null): TransactionReceipt {
  if (receipt === null) throw new Error("transaction receipt was unexpectedly null");
  return receipt;
}

async function deployFixture(useDeterministicHarness = false): Promise<Fixture> {
  const [deployer, alice, bob, carol, outsider] = await ethers.getSigners();
  const signers: Signers = { deployer, alice, bob, carol, outsider };
  const underlying = await new MockUnderlyingToken__factory(deployer).deploy();
  const wrapper = await new VeilPoolConfidentialToken__factory(deployer).deploy(await underlying.getAddress());
  const vault = await new VeilPool__factory(deployer).deploy(await wrapper.getAddress(), 10n);

  const deterministic = useDeterministicHarness
    ? await new PrizeEngineDeterministicHarness__factory(deployer).deploy(
        await vault.getAddress(),
        await wrapper.getAddress(),
        deployer.address,
      )
    : undefined;
  const engine = deterministic
    ? (deterministic as unknown as EngineLike)
    : await new PrizeEngine__factory(deployer).deploy(
        await vault.getAddress(),
        await wrapper.getAddress(),
        deployer.address,
      );

  await (await vault.setPrizeEngine(await engine.getAddress())).wait();
  for (const user of [deployer, alice, bob, carol]) {
    await (await underlying.mint(user.address, 2_000n)).wait();
  }
  return { signers, underlying, wrapper, vault, engine, deterministic };
}

async function wrapFor(
  underlying: MockUnderlyingToken,
  wrapper: VeilPoolConfidentialToken,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  await (await underlying.connect(user).approve(await wrapper.getAddress(), amount)).wait();
  await (await wrapper.connect(user).wrap(user.address, amount)).wait();
}

async function authorizeVault(
  wrapper: VeilPoolConfidentialToken,
  user: HardhatEthersSigner,
  vault: VeilPool,
) {
  await (await wrapper.connect(user).setOperator(await vault.getAddress(), MAX_UINT48)).wait();
}

async function depositFor(
  wrapper: VeilPoolConfidentialToken,
  vault: VeilPool,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  const encrypted = await fhevm
    .createEncryptedInput(await wrapper.getAddress(), await vault.getAddress())
    .add64(amount)
    .encrypt();
  const tx = await vault.connect(user).deposit(encrypted.handles[0], encrypted.inputProof);
  return requireReceipt(await tx.wait());
}

async function withdrawFor(vault: VeilPool, user: HardhatEthersSigner, amount: bigint) {
  const encrypted = await fhevm
    .createEncryptedInput(await vault.getAddress(), user.address)
    .add64(amount)
    .encrypt();
  const tx = await vault.connect(user).withdraw(encrypted.handles[0], encrypted.inputProof);
  return requireReceipt(await tx.wait());
}

async function fundPrize(
  fixture: Fixture,
  funder: HardhatEthersSigner,
  amount: bigint,
) {
  const { underlying, wrapper, engine } = fixture;
  await wrapFor(underlying, wrapper, funder, amount);
  await (await wrapper.connect(funder).setOperator(await engine.getAddress(), MAX_UINT48)).wait();
  const encrypted = await fhevm
    .createEncryptedInput(await wrapper.getAddress(), await engine.getAddress())
    .add64(amount)
    .encrypt();
  const tx = await engine.connect(funder).fundPrize(encrypted.handles[0], encrypted.inputProof);
  return requireReceipt(await tx.wait());
}

async function commitPrize(fixture: Fixture, amount: bigint) {
  const { engine, signers } = fixture;
  const encrypted = await fhevm
    .createEncryptedInput(await engine.getAddress(), signers.deployer.address)
    .add64(amount)
    .encrypt();
  const tx = await engine.connect(signers.deployer).commitRoundPrize(encrypted.handles[0], encrypted.inputProof);
  return requireReceipt(await tx.wait());
}

async function lockRound(fixture: Fixture) {
  const tx = await fixture.engine.connect(fixture.signers.deployer).lockRound();
  return requireReceipt(await tx.wait());
}

async function requestTotalDecryption(fixture: Fixture) {
  const tx = await fixture.engine.connect(fixture.signers.deployer).requestAggregateDecryption();
  return requireReceipt(await tx.wait());
}

async function decryptPublicUint(handle: string): Promise<{ value: bigint; proof: string }> {
  const result = await fhevm.publicDecrypt([handle]);
  const clearValue = Object.values(result.clearValues)[0];
  if (clearValue === undefined) throw new Error("public decryption returned no value");
  return { value: BigInt(String(clearValue)), proof: result.decryptionProof };
}

async function decryptPublicBool(handle: string): Promise<{ value: boolean; proof: string }> {
  const result = await fhevm.publicDecrypt([handle]);
  const clearValue = Object.values(result.clearValues)[0];
  if (typeof clearValue !== "boolean") throw new Error("public decryption did not return a boolean");
  return { value: clearValue, proof: result.decryptionProof };
}

async function finalizeTotal(fixture: Fixture) {
  const publicTotal = await decryptPublicUint(await fixture.engine.confidentialTotalWeight());
  const tx = await fixture.engine
    .connect(fixture.signers.outsider)
    .finalizeAggregateReveal(publicTotal.value, publicTotal.proof);
  return { publicTotal, receipt: requireReceipt(await tx.wait()) };
}

async function executeDraw(fixture: Fixture) {
  const tx = await fixture.engine.connect(fixture.signers.deployer).executeDraw();
  return requireReceipt(await tx.wait());
}

async function finalizeAcceptance(fixture: Fixture) {
  await (await fixture.engine.connect(fixture.signers.deployer).requestDrawAcceptance()).wait();
  const result = await decryptPublicBool(await fixture.engine.confidentialHasAccepted());
  const tx = await fixture.engine
    .connect(fixture.signers.outsider)
    .finalizeDrawAcceptance(result.value, result.proof);
  return { accepted: result.value, receipt: requireReceipt(await tx.wait()) };
}

async function prepareTwoParticipantRound(fixture: Fixture) {
  const { signers, underlying, wrapper, vault } = fixture;
  await wrapFor(underlying, wrapper, signers.alice, ALICE_PRINCIPAL);
  await wrapFor(underlying, wrapper, signers.bob, BOB_PRINCIPAL);
  await authorizeVault(wrapper, signers.alice, vault);
  await authorizeVault(wrapper, signers.bob, vault);
  await depositFor(wrapper, vault, signers.alice, ALICE_PRINCIPAL);
  await depositFor(wrapper, vault, signers.bob, BOB_PRINCIPAL);
  await lockRound(fixture);
  await requestTotalDecryption(fixture);
  const finalized = await finalizeTotal(fixture);
  await fundPrize(fixture, signers.deployer, PRIZE);
  await commitPrize(fixture, PRIZE);
  return finalized.publicTotal.value;
}

describe("Confidential winnings withdrawals after settlement", function () {
  for (const requests of [[4n], [10n], [99n], [4n, 99n, 99n]]) {
    it(`clamps winnings claims ${requests.join(',')} while preserving principal, eligibility and ACL`, async function () {
      const f = await deployFixture();
      await prepareTwoParticipantRound(f);
      await executeDraw(f);
      expect((await finalizeAcceptance(f)).accepted).to.equal(true);
      const winner = (await decryptVaultValue(f.vault, f.signers.alice, "confidentialWinningsOf")) === PRIZE ? f.signers.alice : f.signers.bob;
      const loser = winner === f.signers.alice ? f.signers.bob : f.signers.alice;
      const balance = await f.vault.confidentialBalanceOf(winner.address);
      const eligibility = await f.vault.confidentialEligibilityOf(winner.address);
      const liability = await f.vault.confidentialPrincipalLiability();
      let claimed = 0n;
      for (const amount of requests) {
        const input = await fhevm.createEncryptedInput(await f.vault.getAddress(), winner.address).add64(amount).encrypt();
        const receipt = await (await f.vault.connect(winner).withdrawWinnings(input.handles[0], input.inputProof)).wait();
        claimed += amount < PRIZE - claimed ? amount : PRIZE - claimed;
        expect(await decryptVaultValue(f.vault, winner, "confidentialWinningsOf")).to.equal(PRIZE - claimed);
        expect(await fhevm.userDecryptEuint(FhevmType.euint64, await f.wrapper.confidentialBalanceOf(winner.address), await f.wrapper.getAddress(), winner)).to.equal(claimed);
        expect(await f.vault.confidentialBalanceOf(winner.address)).to.equal(balance);
        expect(await f.vault.confidentialEligibilityOf(winner.address)).to.equal(eligibility);
        expect(await f.vault.confidentialPrincipalLiability()).to.equal(liability);
        await expectPublicDecryptFailure(await f.vault.confidentialWinningsOf(winner.address));
        let denied = false;
        try { await fhevm.userDecryptEuint(FhevmType.euint64, await f.vault.confidentialWinningsOf(winner.address), await f.vault.getAddress(), loser); } catch { denied = true; }
        expect(denied).to.equal(true);
        const logs = receipt!.logs.filter(log => log.address.toLowerCase() === (f.vault.target as string).toLowerCase());
        expect(logs.length).to.equal(1);
        expect(f.vault.interface.parseLog(logs[0])!.name).to.equal("WithdrawalRecorded");
      }
      // A losing participant can submit the same action, but cannot take the winner's funds.
      const zeroClaim = await fhevm.createEncryptedInput(await f.vault.getAddress(), loser.address).add64(99n).encrypt();
      await (await f.vault.connect(loser).withdrawWinnings(zeroClaim.handles[0], zeroClaim.inputProof)).wait();
      expect(await decryptVaultValue(f.vault, loser, "confidentialWinningsOf")).to.equal(0n);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, await f.wrapper.confidentialBalanceOf(loser.address), await f.wrapper.getAddress(), loser)).to.equal(0n);
      expect(await decryptVaultValue(f.vault, winner, "confidentialWinningsOf")).to.equal(PRIZE - claimed);
      // Savings withdrawal remains independent of prize claiming.
      await withdrawFor(f.vault, winner, 1n);
      expect(await decryptVaultValue(f.vault, winner, "confidentialWinningsOf")).to.equal(PRIZE - claimed);
    });
  }
});

async function decryptVaultValue(vault: VeilPool, user: HardhatEthersSigner, getter: string) {
  const handle = await (vault as any)[getter](user.address);
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, await vault.getAddress(), user);
}

async function expectPublicDecryptFailure(handle: string) {
  let failed = false;
  try {
    await fhevm.publicDecryptEuint(FhevmType.euint64, handle);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/public|authoriz|decrypt|ACL/i);
  }
  expect(failed, "confidential value unexpectedly became public").to.equal(true);
}

async function expectUserDecryptFailure(
  handle: string,
  contractAddress: string,
  user: HardhatEthersSigner,
) {
  let failed = false;
  try {
    await fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddress, user);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "unauthorized user decryption unexpectedly succeeded").to.equal(true);
}

async function expectUserDecryptEboolFailure(
  handle: string,
  contractAddress: string,
  user: HardhatEthersSigner,
) {
  let failed = false;
  try {
    await fhevm.userDecryptEbool(handle, contractAddress, user);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "unauthorized ebool decryption unexpectedly succeeded").to.equal(true);
}

function parsedEvents(receipt: TransactionReceipt, engine: PrizeEngine) {
  return receipt.logs.flatMap((log) => {
    try {
      const parsed = engine.interface.parseLog({ topics: log.topics, data: log.data });
      return parsed === null ? [] : [parsed];
    } catch {
      return [];
    }
  });
}

describe("Phase 4 production PrizeEngine", function () {
  beforeEach(function () {
    if (!fhevm.isMock) this.skip();
  });

  it("starts OPEN, snapshots two participants, and finalizes only the aggregate total", async function () {
    const fixture = await deployFixture();
    expect(await fixture.engine.roundState()).to.equal(0n);

    const total = await prepareTwoParticipantRound(fixture);
    expect(total).to.equal(TWO_PARTICIPANT_TOTAL);
    expect(await fixture.engine.roundState()).to.equal(3n);
    expect(await fixture.engine.publicTotalWeight()).to.equal(TWO_PARTICIPANT_TOTAL);
    expect(await fixture.engine.roundParticipantCount(1n)).to.equal(2n);

    await expectPublicDecryptFailure(await fixture.engine.confidentialFrozenEligibilityAt(1n, 0n));
    await expectPublicDecryptFailure(await fixture.engine.confidentialFrozenEligibilityAt(1n, 1n));
    await expectUserDecryptFailure(
      await fixture.engine.confidentialFrozenEligibilityAt(1n, 0n),
      await fixture.engine.getAddress(),
      fixture.signers.alice,
    );
  });

  it("freezes round weights while later deposits and withdrawals change only live positions", async function () {
    const fixture = await deployFixture();
    const { signers, underlying, wrapper, vault, engine } = fixture;
    await wrapFor(underlying, wrapper, signers.alice, 100n);
    await wrapFor(underlying, wrapper, signers.bob, 100n);
    await authorizeVault(wrapper, signers.alice, vault);
    await authorizeVault(wrapper, signers.bob, vault);
    await depositFor(wrapper, vault, signers.alice, 80n);
    await depositFor(wrapper, vault, signers.bob, 48n);
    await lockRound(fixture);
    const firstHandle = await engine.confidentialFrozenEligibilityAt(1n, 0n);
    await depositFor(wrapper, vault, signers.alice, 10n);
    await withdrawFor(vault, signers.alice, 10n);
    expect(await engine.confidentialFrozenEligibilityAt(1n, 0n)).to.equal(firstHandle);
    await requestTotalDecryption(fixture);
    const finalized = await finalizeTotal(fixture);
    expect(finalized.publicTotal.value).to.equal(TWO_PARTICIPANT_TOTAL);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(80n);
  });

  it("requires two registered participants and documents the zero-eligibility limitation", async function () {
    const one = await deployFixture();
    await wrapFor(one.underlying, one.wrapper, one.signers.alice, 10n);
    await authorizeVault(one.wrapper, one.signers.alice, one.vault);
    await depositFor(one.wrapper, one.vault, one.signers.alice, 10n);
    await expect(one.engine.lockRound()).to.be.revertedWithCustomError(one.engine, "InvalidParticipantCount");

    const two = await deployFixture();
    await wrapFor(two.underlying, two.wrapper, two.signers.alice, 10n);
    await wrapFor(two.underlying, two.wrapper, two.signers.bob, 10n);
    await authorizeVault(two.wrapper, two.signers.alice, two.vault);
    await authorizeVault(two.wrapper, two.signers.bob, two.vault);
    await depositFor(two.wrapper, two.vault, two.signers.alice, 10n);
    await depositFor(two.wrapper, two.vault, two.signers.bob, 0n);
    await lockRound(two);
    expect(await two.engine.roundParticipantCount(1n)).to.equal(2n);
  });

  it("rejects fake aggregate totals and requires a valid Zama proof", async function () {
    const fixture = await deployFixture();
    const { signers } = fixture;
    await wrapFor(fixture.underlying, fixture.wrapper, signers.alice, ALICE_PRINCIPAL);
    await wrapFor(fixture.underlying, fixture.wrapper, signers.bob, BOB_PRINCIPAL);
    await authorizeVault(fixture.wrapper, signers.alice, fixture.vault);
    await authorizeVault(fixture.wrapper, signers.bob, fixture.vault);
    await depositFor(fixture.wrapper, fixture.vault, signers.alice, ALICE_PRINCIPAL);
    await depositFor(fixture.wrapper, fixture.vault, signers.bob, BOB_PRINCIPAL);
    await lockRound(fixture);
    await requestTotalDecryption(fixture);

    const publicTotal = await decryptPublicUint(await fixture.engine.confidentialTotalWeight());
    await expect(
      fixture.engine.finalizeAggregateReveal(publicTotal.value + 1n, publicTotal.proof),
    ).to.be.reverted;
    await expect(fixture.engine.finalizeAggregateReveal(publicTotal.value, "0x")).to.be.reverted;
    expect(await fixture.engine.roundState()).to.equal(2n);
    await finalizeTotal(fixture);
    expect(await fixture.engine.roundState()).to.equal(3n);
  });

  it("does not execute before aggregate finalization, zero totals, or unsafe RNG domains", async function () {
    const fixture = await deployFixture();
    await expect(fixture.engine.executeDraw()).to.be.revertedWithCustomError(fixture.engine, "InvalidRoundState");
    expect(await fixture.engine.nextPowerOfTwo(0n)).to.equal(0n);
    expect(await fixture.engine.nextPowerOfTwo(1n << 63n)).to.equal(1n << 63n);
    await expect(fixture.engine.nextPowerOfTwo((1n << 63n) + 1n)).to.be.revertedWithCustomError(
      fixture.engine,
      "RandomDomainOverflow",
    );
    await expect(fixture.engine.nextPowerOfTwo((1n << 64n) - 1n)).to.be.revertedWithCustomError(
      fixture.engine,
      "RandomDomainOverflow",
    );

    const zero = await deployFixture();
    await wrapFor(zero.underlying, zero.wrapper, zero.signers.alice, 10n);
    await wrapFor(zero.underlying, zero.wrapper, zero.signers.bob, 10n);
    await authorizeVault(zero.wrapper, zero.signers.alice, zero.vault);
    await authorizeVault(zero.wrapper, zero.signers.bob, zero.vault);
    await depositFor(zero.wrapper, zero.vault, zero.signers.alice, 0n);
    await depositFor(zero.wrapper, zero.vault, zero.signers.bob, 0n);
    await lockRound(zero);
    await requestTotalDecryption(zero);
    await finalizeTotal(zero);
    await expect(zero.engine.executeDraw()).to.be.revertedWithCustomError(zero.engine, "NoEligibleWeight");
    await (await zero.engine.closeEmptyRound()).wait();
    expect(await zero.engine.roundState()).to.equal(7n);
    await (await zero.engine.startNextRound()).wait();
    expect(await zero.engine.roundId()).to.equal(2n);
  });

  it("performs an unbiased confidential weighted draw and credits prize separately from principal", async function () {
    const fixture = await deployFixture();
    const total = await prepareTwoParticipantRound(fixture);
    expect(total).to.equal(TWO_PARTICIPANT_TOTAL);
    await executeDraw(fixture);

    const winnerIndexHandle = await fixture.engine.confidentialWinnerIndex();
    await expectPublicDecryptFailure(winnerIndexHandle);
    await expectUserDecryptFailure(winnerIndexHandle, await fixture.engine.getAddress(), fixture.signers.alice);
    const acceptance = await finalizeAcceptance(fixture);
    expect(acceptance.accepted).to.equal(true);
    expect(await fixture.engine.roundState()).to.equal(6n);

    const aliceWinnings = await decryptVaultValue(fixture.vault, fixture.signers.alice, "confidentialWinningsOf");
    const bobWinnings = await decryptVaultValue(fixture.vault, fixture.signers.bob, "confidentialWinningsOf");
    expect(aliceWinnings + bobWinnings).to.equal(PRIZE);
    expect([aliceWinnings, bobWinnings].filter((value) => value === PRIZE)).to.have.length(1);
    expect(await decryptVaultValue(fixture.vault, fixture.signers.alice, "confidentialBalanceOf")).to.equal(
      ALICE_PRINCIPAL,
    );
    expect(await decryptVaultValue(fixture.vault, fixture.signers.bob, "confidentialBalanceOf")).to.equal(
      BOB_PRINCIPAL,
    );
  });

  it("never credits a zero-weight participant", async function () {
    const fixture = await deployFixture();
    const { signers, underlying, wrapper, vault } = fixture;
    await wrapFor(underlying, wrapper, signers.alice, 128n);
    await wrapFor(underlying, wrapper, signers.bob, 1n);
    await authorizeVault(wrapper, signers.alice, vault);
    await authorizeVault(wrapper, signers.bob, vault);
    await depositFor(wrapper, vault, signers.alice, 128n);
    await depositFor(wrapper, vault, signers.bob, 0n);
    await lockRound(fixture);
    await requestTotalDecryption(fixture);
    await finalizeTotal(fixture);
    await fundPrize(fixture, signers.deployer, PRIZE);
    await commitPrize(fixture, PRIZE);
    await executeDraw(fixture);
    await finalizeAcceptance(fixture);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialWinningsOf")).to.equal(PRIZE);
    expect(await decryptVaultValue(vault, signers.bob, "confidentialWinningsOf")).to.equal(0n);
  });

  it("leaves an all-rejected batch retryable and settles on a later fresh batch", async function () {
    const fixture = await deployFixture(true);
    const deterministic = fixture.deterministic;
    if (deterministic === undefined) throw new Error("deterministic fixture was not deployed");
    const { signers, underlying, wrapper, vault } = fixture;
    await wrapFor(underlying, wrapper, signers.alice, 3n);
    await wrapFor(underlying, wrapper, signers.bob, 1n);
    await authorizeVault(wrapper, signers.alice, vault);
    await authorizeVault(wrapper, signers.bob, vault);
    await depositFor(wrapper, vault, signers.alice, 3n);
    await depositFor(wrapper, vault, signers.bob, 0n);
    await lockRound(fixture);
    await requestTotalDecryption(fixture);
    await finalizeTotal(fixture);
    await fundPrize(fixture, signers.deployer, PRIZE);
    await commitPrize(fixture, PRIZE);

    await (await deterministic.setForceReject(true)).wait();
    await executeDraw(fixture);
    const rejected = await finalizeAcceptance(fixture);
    expect(rejected.accepted).to.equal(false);
    expect(await fixture.engine.roundState()).to.equal(5n);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialWinningsOf")).to.equal(0n);

    await (await deterministic.setForceReject(false)).wait();
    await executeDraw(fixture);
    const accepted = await finalizeAcceptance(fixture);
    expect(accepted.accepted).to.equal(true);
    expect(await fixture.engine.roundState()).to.equal(6n);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialWinningsOf")).to.equal(PRIZE);
  });

  it("authorizes lifecycle actions without giving the operator winner control", async function () {
    const fixture = await deployFixture();
    await expect(fixture.engine.connect(fixture.signers.outsider).lockRound()).to.be.revertedWithCustomError(
      fixture.engine,
      "UnauthorizedOperator",
    );
    await expect(fixture.engine.connect(fixture.signers.outsider).executeDraw()).to.be.revertedWithCustomError(
      fixture.engine,
      "UnauthorizedOperator",
    );
    const executeFragment = fixture.engine.interface.getFunction("executeDraw");
    expect(executeFragment?.inputs.length).to.equal(0);
    expect(fixture.engine.interface.getFunction("executeDraw")?.stateMutability).to.equal("nonpayable");
  });

  it("keeps winner state private and protects updated winnings with ACL", async function () {
    const fixture = await deployFixture();
    await prepareTwoParticipantRound(fixture);
    await executeDraw(fixture);
    const acceptedHandle = await fixture.engine.confidentialHasAccepted();
    const winnerHandle = await fixture.engine.confidentialWinnerIndex();
    await expectPublicDecryptFailure(winnerHandle);
    await expectUserDecryptEboolFailure(acceptedHandle, await fixture.engine.getAddress(), fixture.signers.alice);
    await finalizeAcceptance(fixture);

    const aliceWinningsHandle = await fixture.vault.confidentialWinningsOf(fixture.signers.alice.address);
    const bobWinningsHandle = await fixture.vault.confidentialWinningsOf(fixture.signers.bob.address);
    await expectUserDecryptFailure(aliceWinningsHandle, await fixture.vault.getAddress(), fixture.signers.bob);
    await expectUserDecryptFailure(bobWinningsHandle, await fixture.vault.getAddress(), fixture.signers.alice);
  });

  it("settles once, preserves historical snapshots, and opens the next round", async function () {
    const fixture = await deployFixture();
    await prepareTwoParticipantRound(fixture);
    await executeDraw(fixture);
    await finalizeAcceptance(fixture);
    await expect(fixture.engine.finalizeDrawAcceptance(true, "0x")).to.be.revertedWithCustomError(
      fixture.engine,
      "InvalidRoundState",
    );

    const oldHandle = await fixture.engine.confidentialFrozenEligibilityAt(1n, 0n);
    await (await fixture.engine.connect(fixture.signers.deployer).startNextRound()).wait();
    expect(await fixture.engine.roundId()).to.equal(2n);
    expect(await fixture.engine.roundState()).to.equal(0n);
    expect(await fixture.engine.roundParticipantAt(1n, 0n)).to.equal(fixture.signers.alice.address);
    expect(await fixture.engine.confidentialFrozenEligibilityAt(1n, 0n)).to.equal(oldHandle);
    expect(await fixture.engine.roundParticipantCount(2n)).to.equal(0n);

    await lockRound(fixture);
    expect(await fixture.engine.roundParticipantCount(2n)).to.equal(2n);
    expect(await fixture.engine.roundParticipantAt(2n, 0n)).to.equal(fixture.signers.alice.address);
  });

  it("enforces the production participant ceiling and emits no winner or prize data", async function () {
    const setup = await deployFixture();
    await expect(
      new VeilPool__factory(setup.signers.deployer).deploy(await setup.wrapper.getAddress(), 11n),
    ).to.be.revertedWithCustomError(setup.vault, "InvalidMaxParticipants");

    const eventFragments = setup.engine.interface.fragments.filter((fragment) => fragment.type === "event");
    for (const fragment of eventFragments) {
      if (fragment.type !== "event") continue;
      const eventName = (fragment as EventFragment).name;
      if (eventName === "AggregateTotalRevealed") {
        expect(fragment.inputs.map((input) => input.name)).to.deep.equal(["roundId", "totalWeight"]);
      } else {
        expect(fragment.inputs.some((input) => /winner|prize|amount|eligibility|balance|winnings/i.test(input.name ?? ""))).to.equal(
          false,
        );
      }
    }

    const total = await prepareTwoParticipantRound(setup);
    expect(total).to.equal(TWO_PARTICIPANT_TOTAL);
    const drawReceipt = await executeDraw(setup);
    const drawEvents = parsedEvents(drawReceipt, setup.engine);
    expect(drawEvents.filter((event) => event.name !== "PublicDecryptionVerified")).to.deep.equal([]);
    const settlement = await finalizeAcceptance(setup);
    const settlementEvents = parsedEvents(settlement.receipt, setup.engine);
    const customNames = settlementEvents
      .map((event) => event.name)
      .filter((name) => name !== "PublicDecryptionVerified");
    expect(customNames).to.deep.equal(["RoundSettled"]);
    expect(settlementEvents.find((event) => event.name === "RoundSettled")?.args[0]).to.equal(1n);
  });
});
