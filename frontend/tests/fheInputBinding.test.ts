import assert from "node:assert/strict";
import test from "node:test";
import { depositInputBinding } from "../src/lib/fheInputBinding.ts";

test("binds confidential deposits to the wrapper and VeilPool vault", () => {
  const wrapperAddress = "0xfbC3096644cc41bAa6768897c0de286F79D1578a";
  const vaultAddress = "0x6E308F5F33abbdd800883e297906dF8de6B68Bd5";

  assert.deepEqual(depositInputBinding(wrapperAddress, vaultAddress), {
    contractAddress: wrapperAddress,
    userAddress: vaultAddress,
  });
});
