import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { TransactionReceipt } from "ethers";
import {
  MockUnderlyingToken,
  MockUnderlyingToken__factory,
  VeilPool,
  VeilPool__factory,
  VeilPoolConfidentialToken,
  VeilPoolConfidentialToken__factory,
} from "../types";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
};

const MAX_PARTICIPANTS = 2n;
const ALICE_DEPOSIT = 100n;
const BOB_DEPOSIT = 70n;
const SECOND_ALICE_DEPOSIT = 50n;
const PARTIAL_WITHDRAWAL = 40n;
const EXCESS_WITHDRAWAL = 150n;

async function deployFixture() {
  const [deployer, alice, bob, carol, outsider] = await ethers.getSigners();
  const signers: Signers = { deployer, alice, bob, carol, outsider };

  const underlying = await new MockUnderlyingToken__factory(deployer).deploy();
  const wrapper = await new VeilPoolConfidentialToken__factory(deployer).deploy(await underlying.getAddress());
  const vault = await new VeilPool__factory(deployer).deploy(await wrapper.getAddress(), MAX_PARTICIPANTS);

  await (await underlying.mint(alice.address, 1_000n)).wait();
  await (await underlying.mint(bob.address, 1_000n)).wait();
  await (await underlying.mint(carol.address, 1_000n)).wait();

  return {
    signers,
    underlying,
    wrapper,
    vault,
    underlyingAddress: await underlying.getAddress(),
    wrapperAddress: await wrapper.getAddress(),
    vaultAddress: await vault.getAddress(),
  };
}

function requireReceipt(receipt: TransactionReceipt | null): TransactionReceipt {
  if (receipt === null) throw new Error("transaction receipt was unexpectedly null");
  return receipt;
}

function parsedEvents(contract: VeilPool, receipt: TransactionReceipt, eventName: string) {
  return receipt.logs.flatMap((log) => {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      return parsed?.name === eventName ? [parsed] : [];
    } catch {
      return [];
    }
  });
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

async function depositFor(
  wrapper: VeilPoolConfidentialToken,
  vault: VeilPool,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  // The vault is the immediate ERC-7984 operator caller, so the input proof is
  // bound to the token contract and the vault address per the current API.
  const encryptedAmount = await fhevm
    .createEncryptedInput(await wrapper.getAddress(), await vault.getAddress())
    .add64(amount)
    .encrypt();
  const tx = await vault.connect(user).deposit(encryptedAmount.handles[0], encryptedAmount.inputProof);
  return requireReceipt(await tx.wait());
}

async function withdrawFor(vault: VeilPool, user: HardhatEthersSigner, amount: bigint) {
  const encryptedAmount = await fhevm
    .createEncryptedInput(await vault.getAddress(), user.address)
    .add64(amount)
    .encrypt();
  const tx = await vault.connect(user).withdraw(encryptedAmount.handles[0], encryptedAmount.inputProof);
  return requireReceipt(await tx.wait());
}

async function authorizeOperator(wrapper: VeilPoolConfidentialToken, user: HardhatEthersSigner, vault: VeilPool) {
  const until = (1n << 48n) - 1n;
  await (await wrapper.connect(user).setOperator(await vault.getAddress(), until)).wait();
  expect(await wrapper.isOperator(user.address, await vault.getAddress())).to.equal(true);
}

async function decryptVaultValue(vault: VeilPool, user: HardhatEthersSigner, getter: string) {
  const handle = await (vault as any)[getter](user.address);
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, await vault.getAddress(), user);
}

async function expectUnauthorizedPositionDecrypt(
  vault: VeilPool,
  participant: HardhatEthersSigner,
  unauthorized: HardhatEthersSigner,
  getter: string,
) {
  const handle = await (vault as any)[getter](participant.address);
  let failed = false;
  try {
    await fhevm.userDecryptEuint(FhevmType.euint64, handle, await vault.getAddress(), unauthorized);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "unauthorized position decryption unexpectedly succeeded").to.equal(true);
}

describe("VeilPool Phase 2 confidential vault", function () {
  beforeEach(function () {
    if (!fhevm.isMock) this.skip();
  });

  it("deposits through ERC-7984 operator authorization and synchronizes balance and eligibility", async function () {
    const { signers, underlying, wrapper, vault, vaultAddress } = await deployFixture();
    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT);
    await authorizeOperator(wrapper, signers.alice, vault);

    const receipt = await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);
    expect(await vault.participantCount()).to.equal(1n);
    expect(await wrapper.confidentialBalanceOf(signers.alice.address)).to.not.equal(ethers.ZeroHash);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, await wrapper.confidentialBalanceOf(vaultAddress))).to.equal(
      ALICE_DEPOSIT,
    );
    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(ALICE_DEPOSIT);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialEligibilityOf")).to.equal(ALICE_DEPOSIT);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialWinningsOf")).to.equal(0n);
    expect(await wrapper.confidentialBalanceOf(signers.alice.address)).to.not.equal(ethers.ZeroHash);

    const events = parsedEvents(vault, receipt, "DepositRecorded");
    expect(events).to.have.length(1);
    expect(events[0].args.participant).to.equal(signers.alice.address);
    expect(await wrapper.confidentialBalanceOf(vaultAddress)).to.not.equal(ethers.ZeroHash);
    expect(await underlying.balanceOf(signers.alice.address)).to.equal(900n);
  });

  it("accumulates repeated deposits without duplicating the participant", async function () {
    const { signers, underlying, wrapper, vault } = await deployFixture();
    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT + SECOND_ALICE_DEPOSIT);
    await authorizeOperator(wrapper, signers.alice, vault);

    await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);
    await depositFor(wrapper, vault, signers.alice, SECOND_ALICE_DEPOSIT);

    expect(await vault.participantCount()).to.equal(1n);
    expect(await vault.participantAt(0)).to.equal(signers.alice.address);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(
      ALICE_DEPOSIT + SECOND_ALICE_DEPOSIT,
    );
    expect(await decryptVaultValue(vault, signers.alice, "confidentialEligibilityOf")).to.equal(
      ALICE_DEPOSIT + SECOND_ALICE_DEPOSIT,
    );
  });

  it("keeps multiple users' positions private while exposing only participant addresses", async function () {
    const { signers, underlying, wrapper, vault } = await deployFixture();
    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT);
    await wrapFor(underlying, wrapper, signers.bob, BOB_DEPOSIT);
    await authorizeOperator(wrapper, signers.alice, vault);
    await authorizeOperator(wrapper, signers.bob, vault);
    await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);
    await depositFor(wrapper, vault, signers.bob, BOB_DEPOSIT);

    expect(await vault.participantCount()).to.equal(2n);
    expect(await vault.participantAt(0)).to.equal(signers.alice.address);
    expect(await vault.participantAt(1)).to.equal(signers.bob.address);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(ALICE_DEPOSIT);
    expect(await decryptVaultValue(vault, signers.bob, "confidentialBalanceOf")).to.equal(BOB_DEPOSIT);
    await expectUnauthorizedPositionDecrypt(vault, signers.bob, signers.alice, "confidentialBalanceOf");
    await expectUnauthorizedPositionDecrypt(vault, signers.alice, signers.bob, "confidentialBalanceOf");
    expect(await vault.participantAt(0)).to.equal(signers.alice.address);
    expect(await vault.participantAt(1)).to.equal(signers.bob.address);
  });

  it("performs a partial confidential withdrawal without unwrapping", async function () {
    const { signers, underlying, wrapper, vault, wrapperAddress } = await deployFixture();
    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT);
    await authorizeOperator(wrapper, signers.alice, vault);
    await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);

    const receipt = await withdrawFor(vault, signers.alice, PARTIAL_WITHDRAWAL);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(
      ALICE_DEPOSIT - PARTIAL_WITHDRAWAL,
    );
    expect(await decryptVaultValue(vault, signers.alice, "confidentialEligibilityOf")).to.equal(
      ALICE_DEPOSIT - PARTIAL_WITHDRAWAL,
    );
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await wrapper.confidentialBalanceOf(signers.alice.address),
        wrapperAddress,
        signers.alice,
      ),
    ).to.equal(PARTIAL_WITHDRAWAL);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, await wrapper.confidentialBalanceOf(await vault.getAddress()))).to.equal(
      ALICE_DEPOSIT - PARTIAL_WITHDRAWAL,
    );

    const events = parsedEvents(vault, receipt, "WithdrawalRecorded");
    expect(events).to.have.length(1);
    expect(events[0].args.participant).to.equal(signers.alice.address);
  });

  it("clamps an excess withdrawal to owned principal and never underflows", async function () {
    const { signers, underlying, wrapper, vault, wrapperAddress } = await deployFixture();
    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT);
    await authorizeOperator(wrapper, signers.alice, vault);
    await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);

    await withdrawFor(vault, signers.alice, EXCESS_WITHDRAWAL);

    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(0n);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialEligibilityOf")).to.equal(0n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await wrapper.confidentialBalanceOf(signers.alice.address),
        wrapperAddress,
        signers.alice,
      ),
    ).to.equal(ALICE_DEPOSIT);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, await wrapper.confidentialBalanceOf(await vault.getAddress()))).to.equal(0n);
  });

  it("preserves owner ACL and vault computation permission after position changes", async function () {
    const { signers, underlying, wrapper, vault } = await deployFixture();
    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT + SECOND_ALICE_DEPOSIT);
    await authorizeOperator(wrapper, signers.alice, vault);
    await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);
    await depositFor(wrapper, vault, signers.alice, SECOND_ALICE_DEPOSIT);
    await withdrawFor(vault, signers.alice, PARTIAL_WITHDRAWAL);

    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(
      ALICE_DEPOSIT + SECOND_ALICE_DEPOSIT - PARTIAL_WITHDRAWAL,
    );
    await expectUnauthorizedPositionDecrypt(vault, signers.alice, signers.outsider, "confidentialBalanceOf");
    await expectUnauthorizedPositionDecrypt(vault, signers.alice, signers.outsider, "confidentialEligibilityOf");

    await depositFor(wrapper, vault, signers.alice, 1n);
    expect(await decryptVaultValue(vault, signers.alice, "confidentialBalanceOf")).to.equal(
      ALICE_DEPOSIT + SECOND_ALICE_DEPOSIT - PARTIAL_WITHDRAWAL + 1n,
    );
  });

  it("enforces the participant limit while repeated deposits do not consume slots", async function () {
    const { signers, underlying, wrapper, vault } = await deployFixture();
    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT + SECOND_ALICE_DEPOSIT);
    await wrapFor(underlying, wrapper, signers.bob, BOB_DEPOSIT);
    await wrapFor(underlying, wrapper, signers.carol, 1n);
    await authorizeOperator(wrapper, signers.alice, vault);
    await authorizeOperator(wrapper, signers.bob, vault);
    await authorizeOperator(wrapper, signers.carol, vault);
    await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);
    await depositFor(wrapper, vault, signers.alice, SECOND_ALICE_DEPOSIT);
    await depositFor(wrapper, vault, signers.bob, BOB_DEPOSIT);
    expect(await vault.participantCount()).to.equal(MAX_PARTICIPANTS);

    let failed = false;
    try {
      await depositFor(wrapper, vault, signers.carol, 1n);
    } catch (error) {
      failed = true;
      expect(String(error)).to.match(/MaxParticipantsReached|custom error|revert/i);
    }
    expect(failed, "a new participant exceeded maxParticipants").to.equal(true);
    expect(await vault.participantCount()).to.equal(MAX_PARTICIPANTS);
    expect(await vault.isParticipant(signers.carol.address)).to.equal(false);
  });

  it("emits only address metadata in VeilPool events, never confidential financial values", async function () {
    const { signers, underlying, wrapper, vault } = await deployFixture();
    const eventFragments = vault.interface.fragments.filter((fragment) => fragment.type === "event");
    for (const fragment of eventFragments) {
      if (fragment.type !== "event") continue;
      expect(fragment.inputs.some((input) => /amount|balance|eligibility|winnings/i.test(input.name ?? ""))).to.equal(
        false,
      );
    }

    await wrapFor(underlying, wrapper, signers.alice, ALICE_DEPOSIT);
    await authorizeOperator(wrapper, signers.alice, vault);
    const depositReceipt = await depositFor(wrapper, vault, signers.alice, ALICE_DEPOSIT);
    const withdrawalReceipt = await withdrawFor(vault, signers.alice, PARTIAL_WITHDRAWAL);
    for (const receipt of [depositReceipt, withdrawalReceipt]) {
      for (const log of receipt.logs) {
        try {
          const parsed = vault.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed === null) continue;
          expect(parsed.args.length).to.equal(1);
          expect(parsed.args[0]).to.equal(signers.alice.address);
        } catch {
          // Logs emitted by the confidential token are outside VeilPool's custom event surface.
        }
      }
    }
  });
});
