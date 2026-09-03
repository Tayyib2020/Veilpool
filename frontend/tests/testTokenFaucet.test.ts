import assert from "node:assert/strict";
import test from "node:test";
import { canStartFaucetMint, faucetAvailability, mintTestTokens } from "../src/lib/testTokenFaucet.ts";

const connectedWallet = {
  status: "connected",
  address: "0xD406De42bf35bCEf0CB82Fda509C179846b22e6C",
  signer: {},
  ethereum: {},
};

test("requires a compatible wallet and Sepolia before minting", () => {
  assert.equal(faucetAvailability({ status: "disconnected" }), "wallet-required");
  assert.equal(faucetAvailability({ ...connectedWallet, status: "wrong-network" }), "wrong-network");
  assert.equal(faucetAvailability(connectedWallet), "idle");
});

test("uses the connected wallet as recipient and mints exactly 100 mUNDER", async () => {
  const calls: Array<{ recipient: string; amount: bigint }> = [];
  const token = {
    mint: async (recipient: string, amount: bigint) => {
      calls.push({ recipient, amount });
      return { hash: "0xmint", wait: async () => undefined };
    },
  };
  let refreshes = 0;
  const hash = await mintTestTokens(token, connectedWallet.address, async () => { refreshes += 1; });

  assert.deepEqual(calls, [{ recipient: connectedWallet.address, amount: 100_000_000n }]);
  assert.equal(refreshes, 1);
  assert.equal(hash, "0xmint");
});

test("prevents starting another mint while one is pending", () => {
  assert.equal(canStartFaucetMint("minting"), false);
  assert.equal(canStartFaucetMint("idle"), true);
  assert.equal(canStartFaucetMint("success"), true);
});

test("does not hide a failed balance refresh behind mint success", async () => {
  const token = { mint: async () => ({ hash: "0xmint", wait: async () => undefined }) };
  await assert.rejects(() => mintTestTokens(token, connectedWallet.address, async () => { throw new Error("RPC unavailable"); }), /RPC unavailable/);
});
