import assert from "node:assert/strict";
import test from "node:test";
import { balanceStatusText, formatUnderlyingBalance, readUnderlyingBalance, UnderlyingBalanceReadError } from "../src/lib/underlyingBalance.ts";

const account = "0xD406De42bf35bCEf0CB82Fda509C179846b22e6C";

test("formats six-decimal mUNDER without losing precision", () => {
  assert.equal(formatUnderlyingBalance(100_000_001n, 6), "100.000001");
  assert.equal(formatUnderlyingBalance(100_000_000n, 6), "100");
  assert.equal(balanceStatusText("loaded", 100_000_000n, 6), "100 mUNDER");
});

test("reads the connected account from the shared underlying source", async () => {
  const calls: string[] = [];
  const result = await readUnderlyingBalance({
    balanceOf: async (address) => { calls.push(`balance:${address}`); return 300_000_000n; },
    decimals: async () => 6,
  }, account);
  assert.deepEqual(result, { value: 300_000_000n, decimals: 6 });
  assert.deepEqual(calls, [`balance:${account}`]);
});

test("propagates balance read failures instead of translating them to zero", async () => {
  await assert.rejects(() => readUnderlyingBalance({
    balanceOf: async () => { throw new Error("RPC unavailable"); },
    decimals: async () => 6,
  }, account), (error: unknown) => error instanceof UnderlyingBalanceReadError && error.kind === "rpc" && error.cause instanceof Error && error.cause.message === "RPC unavailable");
  assert.equal(balanceStatusText("error"), "Balance unavailable");
});

test("caches immutable token decimals while refreshing account balance", async () => {
  let decimalReads = 0;
  const reader = {
    balanceOf: async () => 300_000_000n,
    decimals: async () => { decimalReads += 1; return 6; },
  };
  await readUnderlyingBalance(reader, account, "test-token-cache");
  await readUnderlyingBalance(reader, account, "test-token-cache");
  assert.equal(decimalReads, 1);
});
