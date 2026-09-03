import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import {
  ERC4626YieldAdapter,
  ERC4626YieldAdapter__factory,
  MockUnderlyingToken,
  MockUnderlyingToken__factory,
  SepoliaYieldVault,
  SepoliaYieldVault__factory,
  VeilPool,
  VeilPoolConfidentialToken,
  VeilPoolConfidentialToken__factory,
  VeilPool__factory,
} from "../types";

const MAX_UINT48 = (1n << 48n) - 1n;

type Fixture = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  underlying: MockUnderlyingToken;
  yieldVault: SepoliaYieldVault;
};

async function deployFixture(): Promise<Fixture> {
  const [deployer, alice, bob] = await ethers.getSigners();
  const underlying = await new MockUnderlyingToken__factory(deployer).deploy();
  const yieldVault = await new SepoliaYieldVault__factory(deployer).deploy(
    await underlying.getAddress(),
    deployer.address,
  );
  return { deployer, alice, bob, underlying, yieldVault };
}

async function deposit(
  fixture: Fixture,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  await (await fixture.underlying.mint(user.address, amount)).wait();
  await (await fixture.underlying.connect(user).approve(await fixture.yieldVault.getAddress(), amount)).wait();
  await (await fixture.yieldVault.connect(user).deposit(amount, user.address)).wait();
}

async function addTestYield(fixture: Fixture, amount: bigint) {
  await (await fixture.underlying.mint(fixture.deployer.address, amount)).wait();
  await (await fixture.underlying.approve(await fixture.yieldVault.getAddress(), amount)).wait();
  await (await fixture.yieldVault.addTestYield(amount)).wait();
}

describe("Phase 7 controlled Sepolia ERC-4626 yield vault", function () {
  beforeEach(function () {
    if (!fhevm.isMock) this.skip();
  });

  it("uses the supplied asset and supports standard deposit and redeem", async function () {
    const fixture = await deployFixture();
    const { alice, underlying, yieldVault } = fixture;
    const amount = 1_000n;

    await deposit(fixture, alice, amount);
    expect(await yieldVault.asset()).to.equal(await underlying.getAddress());
    expect(await yieldVault.balanceOf(alice.address)).to.equal(await yieldVault.convertToShares(amount));
    expect(await yieldVault.totalAssets()).to.equal(amount);

    const shares = await yieldVault.balanceOf(alice.address);
    const before = await underlying.balanceOf(alice.address);
    const withdrawn = 400n;
    const withdrawnShares = await yieldVault.previewWithdraw(withdrawn);
    await (await yieldVault.connect(alice).withdraw(withdrawn, alice.address, alice.address)).wait();
    expect(await underlying.balanceOf(alice.address)).to.equal(before + withdrawn);
    expect(await yieldVault.balanceOf(alice.address)).to.equal(shares - withdrawnShares);

    const remainingShares = await yieldVault.balanceOf(alice.address);
    await (await yieldVault.connect(alice).redeem(remainingShares, alice.address, alice.address)).wait();
    expect(await underlying.balanceOf(alice.address)).to.equal(before + amount);
    expect(await yieldVault.balanceOf(alice.address)).to.equal(0n);
  });

  it("accepts only authorized, asset-backed test-yield injection without minting shares", async function () {
    const fixture = await deployFixture();
    const { alice, bob, underlying, yieldVault } = fixture;
    const principal = 1_000n;
    const injected = 100n;

    await deposit(fixture, alice, principal);
    await expect(yieldVault.connect(bob).addTestYield(injected)).to.be.revertedWithCustomError(
      yieldVault,
      "OwnableUnauthorizedAccount",
    );

    const sharesBefore = await yieldVault.totalSupply();
    const assetsBefore = await yieldVault.totalAssets();
    await (await underlying.mint(fixture.deployer.address, injected)).wait();
    const ownerBalanceBefore = await underlying.balanceOf(fixture.deployer.address);
    await (await underlying.approve(await yieldVault.getAddress(), injected)).wait();
    await (await yieldVault.addTestYield(injected)).wait();

    expect(await underlying.balanceOf(fixture.deployer.address)).to.equal(ownerBalanceBefore - injected);
    expect(await yieldVault.totalAssets()).to.equal(assetsBefore + injected);
    expect(await yieldVault.totalSupply()).to.equal(sharesBefore);
    expect(await yieldVault.convertToAssets(sharesBefore)).to.be.greaterThan(assetsBefore);
    await expect(yieldVault.addTestYield(0n)).to.be.revertedWithCustomError(yieldVault, "InvalidYieldAmount");
  });

  it("raises share value and is recognized as generated yield by the adapter", async function () {
    const fixture = await deployFixture();
    const { deployer, alice, underlying, yieldVault } = fixture;
    const adapter = await new ERC4626YieldAdapter__factory(deployer).deploy(
      await underlying.getAddress(),
      await yieldVault.getAddress(),
    );
    const principal = 1_000n;
    const injected = 100n;

    await (await underlying.mint(deployer.address, principal + injected)).wait();
    await (await underlying.transfer(await adapter.getAddress(), principal)).wait();
    await (await adapter.setController(deployer.address)).wait();
    await (await adapter.deployPrincipal(principal)).wait();
    expect(await adapter.principalDeployed()).to.equal(principal);
    expect(await adapter.managedAssets()).to.equal(principal);

    await addTestYield(fixture, injected);
    expect(await yieldVault.totalSupply()).to.equal(principal);
    expect(await yieldVault.totalAssets()).to.equal(principal + injected);
    const managed = await adapter.managedAssets();
    expect(managed).to.be.greaterThan(principal);
    const generated = await adapter.generatedYield();
    expect(generated).to.be.greaterThan(0n);
    expect(generated).to.be.lessThanOrEqual(injected);
    expect(managed).to.equal(principal + generated);

    const before = await underlying.balanceOf(alice.address);
    await (await adapter.harvestYield(alice.address)).wait();
    expect(await underlying.balanceOf(alice.address)).to.equal(before + generated);
    expect(await adapter.principalDeployed()).to.equal(principal);
    expect(await adapter.managedAssets()).to.equal(principal);
    expect(await adapter.generatedYield()).to.equal(0n);
  });

  it("does not change confidential eligibility or ACL permissions", async function () {
    const fixture = await deployFixture();
    const { deployer, alice, bob, underlying, yieldVault } = fixture;
    const wrapper = await new VeilPoolConfidentialToken__factory(deployer).deploy(await underlying.getAddress());
    const vault: VeilPool = await new VeilPool__factory(deployer).deploy(await wrapper.getAddress(), 10n);
    const amount = 500n;

    await (await underlying.mint(alice.address, amount)).wait();
    await (await underlying.connect(alice).approve(await wrapper.getAddress(), amount)).wait();
    await (await wrapper.connect(alice).wrap(alice.address, amount)).wait();
    await (await wrapper.connect(alice).setOperator(await vault.getAddress(), MAX_UINT48)).wait();
    const encrypted = await fhevm
      .createEncryptedInput(await wrapper.getAddress(), await vault.getAddress())
      .add64(amount)
      .encrypt();
    await (await vault.connect(alice).deposit(encrypted.handles[0], encrypted.inputProof)).wait();

    const balanceHandle = await vault.confidentialBalanceOf(alice.address);
    const eligibilityHandle = await vault.confidentialEligibilityOf(alice.address);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, balanceHandle, await vault.getAddress(), alice),
    ).to.equal(amount);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, eligibilityHandle, await vault.getAddress(), alice),
    ).to.equal(amount);
    await addTestYield(fixture, 100n);

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, await vault.confidentialBalanceOf(alice.address), await vault.getAddress(), alice),
    ).to.equal(amount);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, await vault.confidentialEligibilityOf(alice.address), await vault.getAddress(), alice),
    ).to.equal(amount);
    let unauthorized = false;
    try {
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await vault.confidentialBalanceOf(alice.address),
        await vault.getAddress(),
        bob,
      );
    } catch {
      unauthorized = true;
    }
    expect(unauthorized, "unauthorized wallet decrypted Alice's balance").to.equal(true);
  });
});
