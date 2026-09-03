import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { TransactionReceipt } from "ethers";
import {
  ERC4626YieldAdapter,
  ERC4626YieldAdapter__factory,
  MockUnderlyingToken,
  MockUnderlyingToken__factory,
  MockYieldVault,
  MockYieldVault__factory,
  PrizeEngine,
  PrizeEngineDeterministicHarness,
  PrizeEngineDeterministicHarness__factory,
  PrizeEngine__factory,
  VeilPool,
  VeilPoolConfidentialToken,
  VeilPoolConfidentialToken__factory,
  VeilPool__factory,
} from "../types";

type Fixture = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
  underlying: MockUnderlyingToken;
  wrapper: VeilPoolConfidentialToken;
  vault: VeilPool;
  yieldVault: MockYieldVault;
  adapter: ERC4626YieldAdapter;
  engine: PrizeEngine;
  deterministic?: PrizeEngineDeterministicHarness;
};

// The total deliberately sits below the 1024 domain boundary so the
// deterministic retry harness can return candidate 1023 as out-of-range.
const ALICE_PRINCIPAL = 500n;
const BOB_PRINCIPAL = 500n;
const PRINCIPAL = 1000n;
const YIELD = 100n;
const MAX_UINT48 = (1n << 48n) - 1n;

function receipt(receipt_: TransactionReceipt | null): TransactionReceipt {
  if (!receipt_) throw new Error("missing transaction receipt");
  return receipt_;
}

async function deployFixture(useDeterministicHarness = false): Promise<Fixture> {
  const [deployer, alice, bob, outsider] = await ethers.getSigners();
  const underlying = await new MockUnderlyingToken__factory(deployer).deploy();
  const wrapper = await new VeilPoolConfidentialToken__factory(deployer).deploy(await underlying.getAddress());
  const vault = await new VeilPool__factory(deployer).deploy(await wrapper.getAddress(), 10n);
  const yieldVault = await new MockYieldVault__factory(deployer).deploy(await underlying.getAddress());
  const adapter = await new ERC4626YieldAdapter__factory(deployer).deploy(
    await underlying.getAddress(),
    await yieldVault.getAddress(),
  );
  const deterministic = useDeterministicHarness
    ? await new PrizeEngineDeterministicHarness__factory(deployer).deploy(
        await vault.getAddress(),
        await wrapper.getAddress(),
        deployer.address,
      )
    : undefined;
  const engine = deterministic
    ? (deterministic as unknown as PrizeEngine)
    : await new PrizeEngine__factory(deployer).deploy(
        await vault.getAddress(),
        await wrapper.getAddress(),
        deployer.address,
      );

  await (await vault.setPrizeEngine(await engine.getAddress())).wait();
  await (await adapter.setController(await engine.getAddress())).wait();
  await (await engine.setYieldAdapter(await adapter.getAddress())).wait();

  for (const user of [deployer, alice, bob]) {
    await (await underlying.mint(user.address, 2_000n)).wait();
  }
  return { deployer, alice, bob, outsider, underlying, wrapper, vault, yieldVault, adapter, engine, deterministic };
}

async function wrapFor(fixture: Fixture, user: HardhatEthersSigner, amount: bigint) {
  await (await fixture.underlying.connect(user).approve(await fixture.wrapper.getAddress(), amount)).wait();
  await (await fixture.wrapper.connect(user).wrap(user.address, amount)).wait();
}

async function depositFor(fixture: Fixture, user: HardhatEthersSigner, amount: bigint) {
  await (await fixture.wrapper.connect(user).setOperator(await fixture.vault.getAddress(), MAX_UINT48)).wait();
  const encrypted = await fhevm
    .createEncryptedInput(await fixture.wrapper.getAddress(), await fixture.vault.getAddress())
    .add64(amount)
    .encrypt();
  const tx = await fixture.vault.connect(user).deposit(encrypted.handles[0], encrypted.inputProof);
  await tx.wait();
}

async function depositTwoParticipants(fixture: Fixture) {
  await wrapFor(fixture, fixture.alice, ALICE_PRINCIPAL);
  await wrapFor(fixture, fixture.bob, BOB_PRINCIPAL);
  await depositFor(fixture, fixture.alice, ALICE_PRINCIPAL);
  await depositFor(fixture, fixture.bob, BOB_PRINCIPAL);
}

async function decryptPublicUint(handle: string): Promise<{ value: bigint; proof: string }> {
  const result = await fhevm.publicDecrypt([handle]);
  const clear = Object.values(result.clearValues)[0];
  if (clear === undefined) throw new Error("public decryption returned no value");
  return { value: BigInt(String(clear)), proof: result.decryptionProof };
}

async function decryptPublicBool(handle: string): Promise<{ value: boolean; proof: string }> {
  const result = await fhevm.publicDecrypt([handle]);
  const clear = Object.values(result.clearValues)[0];
  if (typeof clear !== "boolean") throw new Error("public decryption returned a non-boolean");
  return { value: clear, proof: result.decryptionProof };
}

async function deployPrincipal(fixture: Fixture) {
  await (await fixture.engine.requestPrincipalDeployment()).wait();
  const liability = await decryptPublicUint(await fixture.engine.confidentialPendingPrincipalLiability());
  const deploymentTx = await (
    await fixture.engine
      .connect(fixture.outsider)
      .finalizePrincipalDeployment(liability.value, liability.proof)
  );
  const deploymentReceipt = receipt(await deploymentTx.wait());

  const requestId = await fixture.engine.pendingPrincipalUnwrapRequest();
  const unwrapped = await decryptPublicUint(requestId);
  const unwrapTx = await (
    await fixture.engine
      .connect(fixture.outsider)
      .finalizePrincipalUnwrap(requestId, unwrapped.value, unwrapped.proof)
  );
  const unwrapReceipt = receipt(await unwrapTx.wait());
  return { deploymentReceipt, unwrapReceipt, requestId };
}

async function snapshotRound(fixture: Fixture) {
  await (await fixture.engine.lockRound()).wait();
  await (await fixture.engine.requestAggregateDecryption()).wait();
  const total = await decryptPublicUint(await fixture.engine.confidentialTotalWeight());
  await (
    await fixture.engine
      .connect(fixture.outsider)
      .finalizeAggregateReveal(total.value, total.proof)
  ).wait();
}

async function settleRound(fixture: Fixture) {
  await (await fixture.engine.executeDraw()).wait();
  await (await fixture.engine.requestDrawAcceptance()).wait();
    const accepted = await decryptPublicBool(await fixture.engine.confidentialHasAccepted());
  await (
    await fixture.engine
      .connect(fixture.outsider)
      .finalizeDrawAcceptance(accepted.value, accepted.proof)
  ).wait();
}

async function encryptedWithdraw(fixture: Fixture, user: HardhatEthersSigner, amount: bigint) {
  const encrypted = await fhevm
    .createEncryptedInput(await fixture.vault.getAddress(), user.address)
    .add64(amount)
    .encrypt();
  await (await fixture.vault.connect(user).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();
}

describe("Phase 5 yield layer", function () {
  beforeEach(function () {
    if (!fhevm.isMock) this.skip();
  });

  it("synchronizes aggregate principal through ERC-7984 unwrap into ERC-4626", async function () {
    const fixture = await deployFixture();
    await depositTwoParticipants(fixture);
    expect(await fixture.vault.participantCount()).to.equal(2n);

    const syncReceipts = await deployPrincipal(fixture);

    expect(await fixture.engine.publicPrincipalLiability()).to.equal(PRINCIPAL);
    expect(await fixture.adapter.principalDeployed()).to.equal(PRINCIPAL);
    expect(await fixture.adapter.managedAssets()).to.equal(PRINCIPAL);
    expect(await fixture.vault.confidentialToken()).to.equal(await fixture.wrapper.getAddress());
    expect(await fixture.wrapper.confidentialBalanceOf(await fixture.vault.getAddress())).to.not.equal(ethers.ZeroHash);

    const unwrapRequested = syncReceipts.deploymentReceipt.logs.flatMap((log) => {
      try {
        const parsed = fixture.wrapper.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "UnwrapRequested" ? [parsed] : [];
      } catch {
        return [];
      }
    });
    expect(unwrapRequested).to.have.length(1);
    expect(unwrapRequested[0].args.unwrapRequestId).to.equal(syncReceipts.requestId);
    expect(unwrapRequested[0].args.amount).to.equal(syncReceipts.requestId);
    expect(syncReceipts.requestId.length).to.equal(66);

    for (const receipt_ of [syncReceipts.deploymentReceipt, syncReceipts.unwrapReceipt]) {
      for (const log of receipt_.logs) {
        for (const contract of [fixture.engine, fixture.vault]) {
          try {
            const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
            if (parsed) {
              expect(parsed.args).to.not.have.property("amount");
              expect(parsed.args).to.not.have.property("balance");
            }
          } catch {
            // The log belongs to another contract (including the official wrapper).
          }
        }
      }
    }

    const aliceBalance = await fixture.vault.confidentialBalanceOf(fixture.alice.address);
    let publicFailed = false;
    try {
      await fhevm.publicDecryptEuint(FhevmType.euint64, aliceBalance);
    } catch {
      publicFailed = true;
    }
    expect(publicFailed, "participant balance became public").to.equal(true);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, aliceBalance, await fixture.vault.getAddress(), fixture.alice),
    ).to.equal(ALICE_PRINCIPAL);
    let bobFailed = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, aliceBalance, await fixture.vault.getAddress(), fixture.bob);
    } catch {
      bobFailed = true;
    }
    expect(bobFailed, "second participant decrypted Alice's balance").to.equal(true);
  });

  it("harvests only surplus yield and keeps principal deployed", async function () {
    const fixture = await deployFixture();
    await depositTwoParticipants(fixture);
    await deployPrincipal(fixture);

    await (await fixture.yieldVault.accrueYield(YIELD)).wait();
    const generated = await fixture.adapter.generatedYield();
    expect(await fixture.adapter.managedAssets()).to.be.greaterThan(PRINCIPAL);
    expect(generated).to.be.greaterThan(0n);

    const before = await fixture.engine.unallocatedHarvestedYield();
    const tx = await fixture.engine.harvestYield();
    const harvestedReceipt = receipt(await tx.wait());
    expect(await fixture.adapter.principalDeployed()).to.equal(PRINCIPAL);
    expect(await fixture.adapter.managedAssets()).to.equal(PRINCIPAL);
    expect(await fixture.adapter.generatedYield()).to.equal(0n);
    expect(await fixture.engine.unallocatedHarvestedYield()).to.equal(before + generated);

    const engineEvents = harvestedReceipt.logs.flatMap((log) => {
      try {
        const parsed = fixture.engine.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
    expect(engineEvents.some((event) => event.name === "YieldHarvested")).to.equal(true);
    for (const event of engineEvents) {
      expect(event.name).to.not.match(/Amount|Balance|Deposit|Transfer/i);
    }
  });

  it("snapshots a round prize after harvest and preserves reserve solvency", async function () {
    const fixture = await deployFixture();
    await depositTwoParticipants(fixture);
    await deployPrincipal(fixture);
    await (await fixture.yieldVault.accrueYield(YIELD)).wait();
    const generated = await fixture.adapter.generatedYield();
    await (await fixture.engine.harvestYield()).wait();

    await snapshotRound(fixture);
    await (await fixture.engine.commitHarvestedYield(generated)).wait();
    expect(await fixture.engine.roundPrizeAmount()).to.equal(generated);
    expect(await fixture.engine.unallocatedHarvestedYield()).to.equal(0n);
    await settleRound(fixture);

    expect(await fixture.engine.roundState()).to.equal(6n);
    expect(await fixture.engine.roundPrizeAmount()).to.equal(generated);
    expect(await fixture.adapter.principalDeployed()).to.equal(PRINCIPAL);
  });

  it("does not change a committed round when later yield is harvested for the next round", async function () {
    const fixture = await deployFixture();
    await depositTwoParticipants(fixture);
    await deployPrincipal(fixture);
    await (await fixture.yieldVault.accrueYield(YIELD)).wait();
    const firstGenerated = await fixture.adapter.generatedYield();
    await (await fixture.engine.harvestYield()).wait();

    await snapshotRound(fixture);
    await (await fixture.engine.commitHarvestedYield(firstGenerated)).wait();
    await settleRound(fixture);
    await (await fixture.engine.startNextRound()).wait();

    await (await fixture.yieldVault.accrueYield(50n)).wait();
    const secondGenerated = await fixture.adapter.generatedYield();
    await (await fixture.engine.harvestYield()).wait();
    expect(await fixture.engine.roundPrizeAmount()).to.equal(0n);
    expect(await fixture.engine.unallocatedHarvestedYield()).to.equal(secondGenerated);
    expect(await fixture.adapter.principalDeployed()).to.equal(PRINCIPAL);
  });

  it("restores principal liquidity before confidential withdrawals", async function () {
    const fixture = await deployFixture();
    await depositTwoParticipants(fixture);
    await deployPrincipal(fixture);
    await (await fixture.yieldVault.accrueYield(YIELD)).wait();
    await (await fixture.engine.harvestYield()).wait();

    const reserveBefore = await fixture.engine.unallocatedHarvestedYield();
    await (await fixture.engine.restorePrincipalLiquidity()).wait();
    expect(await fixture.adapter.principalDeployed()).to.equal(0n);
    expect(await fixture.adapter.managedAssets()).to.equal(0n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, await fixture.vault.confidentialPrincipalLiability())).to.equal(
      PRINCIPAL,
    );

    await encryptedWithdraw(fixture, fixture.alice, ALICE_PRINCIPAL);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await fixture.vault.confidentialBalanceOf(fixture.alice.address),
        await fixture.vault.getAddress(),
        fixture.alice,
      ),
    ).to.equal(0n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await fixture.wrapper.confidentialBalanceOf(fixture.alice.address),
        await fixture.wrapper.getAddress(),
        fixture.alice,
      ),
    ).to.equal(ALICE_PRINCIPAL);
    expect(await fixture.engine.unallocatedHarvestedYield()).to.equal(reserveBefore);
  });

  it("cancels a no-yield round without creating a fictional prize", async function () {
    const fixture = await deployFixture();
    await depositTwoParticipants(fixture);
    await deployPrincipal(fixture);
    await (await fixture.engine.harvestYield()).wait();
    await snapshotRound(fixture);

    await expect(fixture.engine.commitHarvestedYield(0n)).to.be.revertedWithCustomError(
      fixture.engine,
      "NoYieldAvailable",
    );
    await expect(fixture.engine.commitHarvestedYield(1n)).to.be.revertedWithCustomError(
      fixture.engine,
      "InsufficientHarvestedYield",
    );
    await (await fixture.engine.cancelNoYieldRound()).wait();
    expect(await fixture.engine.roundState()).to.equal(7n);
    expect(await fixture.engine.prizeCommitted()).to.equal(false);
  });

  it("rejects unauthorized adapter control and duplicate configuration", async function () {
    const fixture = await deployFixture();
    await expect(fixture.adapter.connect(fixture.alice).deployPrincipal(1n)).to.be.revertedWithCustomError(
      fixture.adapter,
      "UnauthorizedController",
    );
    await expect(fixture.engine.setYieldAdapter(await fixture.adapter.getAddress())).to.be.revertedWithCustomError(
      fixture.engine,
      "YieldAdapterAlreadySet",
    );
    expect(await fixture.adapter.controller()).to.equal(await fixture.engine.getAddress());
  });

  it("preserves the exact harvested reserve across a deterministic retry", async function () {
    const fixture = await deployFixture(true);
    await depositTwoParticipants(fixture);
    await deployPrincipal(fixture);
    await (await fixture.yieldVault.accrueYield(YIELD)).wait();
    const generated = await fixture.adapter.generatedYield();
    await (await fixture.engine.harvestYield()).wait();
    await snapshotRound(fixture);
    await (await fixture.engine.commitHarvestedYield(generated)).wait();

    await (await fixture.deterministic!.setForceReject(true)).wait();
    await (await fixture.engine.executeDraw()).wait();
    await (await fixture.engine.requestDrawAcceptance()).wait();
    const rejected = await decryptPublicBool(await fixture.engine.confidentialHasAccepted());
    expect(rejected.value).to.equal(false);
    await (
      await fixture.engine
        .connect(fixture.outsider)
        .finalizeDrawAcceptance(rejected.value, rejected.proof)
    ).wait();

    expect(await fixture.engine.roundState()).to.equal(5n);
    expect(await fixture.engine.unallocatedHarvestedYield()).to.equal(0n);
    expect(await fixture.engine.roundPrizeAmount()).to.equal(generated);

    await (await fixture.deterministic!.setForceReject(false)).wait();
    await settleRound(fixture);
    expect(await fixture.engine.roundState()).to.equal(6n);
    expect(await fixture.engine.roundPrizeAmount()).to.equal(generated);
    expect(await fixture.adapter.principalDeployed()).to.equal(PRINCIPAL);
  });
});
