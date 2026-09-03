import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { TransactionReceipt } from "ethers";
import {
  MockUnderlyingToken,
  MockUnderlyingToken__factory,
  VeilPoolConfidentialToken,
  VeilPoolConfidentialToken__factory,
} from "../types";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
};

const WRAP_AMOUNT = 1_000n;
const TRANSFER_AMOUNT = 250n;

async function deployFixture() {
  const [deployer, alice, bob, outsider] = await ethers.getSigners();
  const signers: Signers = { deployer, alice, bob, outsider };

  const underlying = await new MockUnderlyingToken__factory(deployer).deploy();
  const wrapper = await new VeilPoolConfidentialToken__factory(deployer).deploy(await underlying.getAddress());

  await (await underlying.mint(alice.address, WRAP_AMOUNT)).wait();

  return {
    signers,
    underlying,
    wrapper,
    underlyingAddress: await underlying.getAddress(),
    wrapperAddress: await wrapper.getAddress(),
  };
}

function requireReceipt(receipt: TransactionReceipt | null): TransactionReceipt {
  if (receipt === null) {
    throw new Error("transaction receipt was unexpectedly null");
  }
  return receipt;
}

function parsedWrapperEvents(
  wrapper: VeilPoolConfidentialToken,
  receipt: TransactionReceipt,
  eventName: string,
) {
  return receipt.logs.flatMap((log) => {
    try {
      const parsed = wrapper.interface.parseLog({ topics: log.topics, data: log.data });
      return parsed?.name === eventName ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function wrapForAlice(
  underlying: MockUnderlyingToken,
  wrapper: VeilPoolConfidentialToken,
  alice: HardhatEthersSigner,
  amount = WRAP_AMOUNT,
) {
  await (await underlying.connect(alice).approve(await wrapper.getAddress(), amount)).wait();
  const tx = await wrapper.connect(alice).wrap(alice.address, amount);
  return { receipt: requireReceipt(await tx.wait()), handle: await wrapper.confidentialBalanceOf(alice.address) };
}

async function expectUserDecryptFailure(
  handle: string,
  wrapperAddress: string,
  user: HardhatEthersSigner,
) {
  let failed = false;
  try {
    await fhevm.userDecryptEuint(FhevmType.euint64, handle, wrapperAddress, user);
  } catch (error) {
    failed = true;
    expect(String(error)).to.match(/authoriz|decrypt|ACL/i);
  }
  expect(failed, "an unauthorized user decryption unexpectedly succeeded").to.equal(true);
}

describe("VeilPool Phase 1: ERC-7984 wrapper foundation", function () {
  beforeEach(function () {
    if (!fhevm.isMock) {
      this.skip();
    }
  });

  it("gives the user underlying ERC-20 tokens and wraps them into a confidential balance", async function () {
    const { signers, underlying, wrapper, wrapperAddress } = await deployFixture();

    expect(await underlying.balanceOf(signers.alice.address)).to.equal(WRAP_AMOUNT);
    expect(await wrapper.rate()).to.equal(1n);
    expect(await wrapper.decimals()).to.equal(6n);

    const { receipt, handle } = await wrapForAlice(underlying, wrapper, signers.alice);
    expect(await underlying.balanceOf(signers.alice.address)).to.equal(0n);
    expect(await underlying.balanceOf(wrapperAddress)).to.equal(WRAP_AMOUNT);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, handle, wrapperAddress, signers.alice)).to.equal(
      WRAP_AMOUNT,
    );

    const confidentialTransfers = parsedWrapperEvents(wrapper, receipt, "ConfidentialTransfer");
    expect(confidentialTransfers).to.have.length(1);
    expect(ethers.isHexString(confidentialTransfers[0].args.amount, 32)).to.equal(true);
    expect(confidentialTransfers[0].args.amount).to.not.equal(ethers.zeroPadValue(ethers.toBeHex(WRAP_AMOUNT), 32));
  });

  it("does not grant a second wallet permission to decrypt the first user's balance", async function () {
    const { signers, underlying, wrapper, wrapperAddress } = await deployFixture();
    const { handle } = await wrapForAlice(underlying, wrapper, signers.alice);

    await expectUserDecryptFailure(handle, wrapperAddress, signers.bob);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, handle, wrapperAddress, signers.alice)).to.equal(
      WRAP_AMOUNT,
    );
  });

  it("transfers confidential tokens and resolves sender and recipient balances after authorized decryption", async function () {
    const { signers, underlying, wrapper, wrapperAddress } = await deployFixture();
    await wrapForAlice(underlying, wrapper, signers.alice);

    const encryptedAmount = await fhevm
      .createEncryptedInput(wrapperAddress, signers.alice.address)
      .add64(TRANSFER_AMOUNT)
      .encrypt();
    const tx = await wrapper
      .connect(signers.alice)
      ["confidentialTransfer(address,bytes32,bytes)"](signers.bob.address, encryptedAmount.handles[0], encryptedAmount.inputProof);
    const receipt = requireReceipt(await tx.wait());

    const aliceHandle = await wrapper.confidentialBalanceOf(signers.alice.address);
    const bobHandle = await wrapper.confidentialBalanceOf(signers.bob.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, aliceHandle, wrapperAddress, signers.alice)).to.equal(
      WRAP_AMOUNT - TRANSFER_AMOUNT,
    );
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, bobHandle, wrapperAddress, signers.bob)).to.equal(
      TRANSFER_AMOUNT,
    );

    const confidentialTransfers = parsedWrapperEvents(wrapper, receipt, "ConfidentialTransfer");
    expect(confidentialTransfers).to.have.length(1);
    expect(ethers.isHexString(confidentialTransfers[0].args.amount, 32)).to.equal(true);
    expect(confidentialTransfers[0].args.amount).to.not.equal(
      ethers.zeroPadValue(ethers.toBeHex(TRANSFER_AMOUNT), 32),
    );
  });

  it("keeps ACL permissions aligned with changed balances", async function () {
    const { signers, underlying, wrapper, wrapperAddress } = await deployFixture();
    await wrapForAlice(underlying, wrapper, signers.alice);

    const encryptedAmount = await fhevm
      .createEncryptedInput(wrapperAddress, signers.alice.address)
      .add64(TRANSFER_AMOUNT)
      .encrypt();
    await (
      await wrapper
        .connect(signers.alice)
        ["confidentialTransfer(address,bytes32,bytes)"](signers.bob.address, encryptedAmount.handles[0], encryptedAmount.inputProof)
    ).wait();

    const aliceHandle = await wrapper.confidentialBalanceOf(signers.alice.address);
    const bobHandle = await wrapper.confidentialBalanceOf(signers.bob.address);
    await expectUserDecryptFailure(aliceHandle, wrapperAddress, signers.outsider);
    await expectUserDecryptFailure(bobHandle, wrapperAddress, signers.outsider);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, aliceHandle, wrapperAddress, signers.alice)).to.equal(
      WRAP_AMOUNT - TRANSFER_AMOUNT,
    );
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, bobHandle, wrapperAddress, signers.bob)).to.equal(
      TRANSFER_AMOUNT,
    );
  });

  it("creates an asynchronous unwrap request, verifies its public decryption, and returns underlying tokens", async function () {
    const { signers, underlying, wrapper, wrapperAddress } = await deployFixture();
    await wrapForAlice(underlying, wrapper, signers.alice);
    const balanceHandle = await wrapper.confidentialBalanceOf(signers.alice.address);

    const unwrapTx = await wrapper
      .connect(signers.alice)
      ["unwrap(address,address,bytes32)"](signers.alice.address, signers.alice.address, balanceHandle);
    const unwrapReceipt = requireReceipt(await unwrapTx.wait());
    const requests = parsedWrapperEvents(wrapper, unwrapReceipt, "UnwrapRequested");
    expect(requests).to.have.length(1);

    const requestId = requests[0].args.unwrapRequestId as `0x${string}`;
    const unwrapAmountHandle = requests[0].args.amount as `0x${string}`;
    expect(requestId).to.equal(unwrapAmountHandle);
    expect(ethers.isHexString(unwrapAmountHandle, 32)).to.equal(true);
    expect(await wrapper.unwrapRequester(requestId)).to.equal(signers.alice.address);
    expect(await fhevm.publicDecryptEuint(FhevmType.euint64, requestId)).to.equal(WRAP_AMOUNT);

    const publicDecryption = await fhevm.publicDecrypt([requestId]);
    const cleartextAmount = publicDecryption.clearValues[requestId];
    expect(cleartextAmount).to.equal(WRAP_AMOUNT);

    const finalizeTx = await (
      await wrapper
        .connect(signers.outsider)
        .finalizeUnwrap(requestId, cleartextAmount as bigint, publicDecryption.decryptionProof)
    );
    const finalizeReceipt = requireReceipt(await finalizeTx.wait());

    expect(await underlying.balanceOf(signers.alice.address)).to.equal(WRAP_AMOUNT);
    expect(await underlying.balanceOf(wrapperAddress)).to.equal(0n);
    expect(await wrapper.unwrapRequester(requestId)).to.equal(ethers.ZeroAddress);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, await wrapper.confidentialBalanceOf(signers.alice.address), wrapperAddress, signers.alice)).to.equal(0n);

    const finalized = parsedWrapperEvents(wrapper, finalizeReceipt, "UnwrapFinalized");
    expect(finalized).to.have.length(1);
    expect(ethers.isHexString(finalized[0].args.encryptedAmount, 32)).to.equal(true);
    // The official wrapper intentionally emits the publicly disclosed amount in this finalize event.
    expect(finalized[0].args.cleartextAmount).to.equal(WRAP_AMOUNT);
  });
});
