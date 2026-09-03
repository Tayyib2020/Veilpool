import assert from "node:assert/strict";
import test from "node:test";
import {
  FALLBACK_WALLET_ID,
  clearedWalletState,
  collectWalletOptions,
  disconnectedWalletState,
  parseChainId,
  selectWalletOption,
  walletStateForAccount,
  walletStatusWithoutProviders,
  type EIP6963ProviderDetail,
  type EthereumProvider,
} from "../src/walletLogic.ts";

function mockProvider(): EthereumProvider {
  return { request: async () => [] };
}

function announced(uuid: string, name: string, provider = mockProvider()): EIP6963ProviderDetail {
  return { info: { uuid, name, icon: `data:image/svg+xml,${uuid}`, rdns: `com.${uuid}` }, provider };
}

test("discovers one EIP-6963 provider and uses a generic injected fallback", () => {
  const provider = mockProvider();
  const [discovered] = collectWalletOptions([announced("one", "Wallet One", provider)]);
  assert.equal(discovered.id, "one");
  assert.equal(discovered.name, "Wallet One");

  const [fallback] = collectWalletOptions([], provider);
  assert.equal(fallback.id, FALLBACK_WALLET_ID);
  assert.equal(fallback.name, "Compatible EVM wallet");
});

test("discovers multiple providers without collapsing them into window.ethereum", () => {
  const first = mockProvider();
  const second = mockProvider();
  const options = collectWalletOptions([announced("first", "Wallet One", first), announced("second", "Wallet Two", second)], first);
  assert.deepEqual(options.map((option) => option.id), ["first", "second"]);
  assert.equal(options[0].provider, first);
  assert.equal(options[1].provider, second);
});

test("selects the intended announced provider", () => {
  const options = collectWalletOptions([announced("first", "Wallet One"), announced("second", "Wallet Two")]);
  assert.equal(selectWalletOption(options, "second")?.name, "Wallet Two");
  assert.equal(selectWalletOption(options, "missing"), undefined);
});

test("tracks account changes and preserves the selected provider", () => {
  const option = collectWalletOptions([announced("selected", "Selected Wallet")])[0];
  const connected = walletStateForAccount(option, "0x1111111111111111111111111111111111111111", 11155111);
  assert.equal(connected.status, "connected");
  assert.equal(connected.address, "0x1111111111111111111111111111111111111111");
  assert.equal(connected.walletId, "selected");
  assert.equal(walletStateForAccount(option, undefined, 11155111).status, "disconnected");
});

test("tracks chain changes and identifies non-Sepolia wallets", () => {
  const option = collectWalletOptions([announced("selected", "Selected Wallet")])[0];
  assert.equal(walletStateForAccount(option, "0x1111111111111111111111111111111111111111", 1).status, "wrong-network");
  assert.equal(parseChainId("0xaa36a7"), 11155111);
  assert.equal(parseChainId("11155111"), 11155111);
});

test("models no-wallet and provider-disconnect/reset states", () => {
  const option = collectWalletOptions([announced("selected", "Selected Wallet")])[0];
  assert.equal(walletStatusWithoutProviders([]), "unsupported");
  assert.equal(walletStatusWithoutProviders([option]), "disconnected");
  const disconnected = disconnectedWalletState(option, 11155111);
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.address, undefined);
  assert.equal(disconnected.walletId, "selected");
  assert.deepEqual(clearedWalletState([option]), { status: "disconnected" });
  assert.deepEqual(clearedWalletState([]), { status: "unsupported" });
});

test("preserves the existing EIP-1193-to-ethers connection contract", () => {
  const provider = mockProvider();
  const [option] = collectWalletOptions([], provider);
  const state = walletStateForAccount(option, "0x2222222222222222222222222222222222222222", 11155111);
  assert.equal(state.ethereum, provider);
  assert.equal(state.walletName, "Compatible EVM wallet");
  assert.equal(state.status, "connected");
});
