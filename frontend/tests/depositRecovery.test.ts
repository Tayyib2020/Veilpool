import assert from "node:assert/strict";
import test from "node:test";
import {
  canOfferRecovery,
  canOfferResume,
  canResumeWithBalance,
  checkpointAfterPrerequisites,
  hasConfidentialBalance,
  requiredWrapAmount,
  UNWRAP_PROGRESS_STEPS,
  unwrapProgressCopy,
  unwrapProgressStep,
  unwrapSuccessCopy,
  wrapperBalancePresentation,
  wrapperStateSessionKey,
} from "../src/lib/depositRecovery.ts";

test("detects an existing confidential wrapper balance without revealing it", () => {
  assert.equal(hasConfidentialBalance(`0x${"0".repeat(64)}`), false);
  assert.equal(hasConfidentialBalance(`0x${"1".padStart(64, "0")}`), true);
});

test("failed post-wrap deposit retries without submitting another wrap", () => {
  assert.equal(requiredWrapAmount(40n, 40n), 0n);
  assert.equal(canResumeWithBalance(40n, 40n), true);
});

test("wraps only the missing confidential amount when the balance is insufficient", () => {
  assert.equal(requiredWrapAmount(40n, 15n), 25n);
  assert.equal(canResumeWithBalance(40n, 40n), true);
});

test("reuses confirmed approval and operator authorization checkpoints", () => {
  assert.equal(checkpointAfterPrerequisites(40n, 0n, false), "approval");
  assert.equal(checkpointAfterPrerequisites(40n, 40n, false), "wrap");
  assert.equal(checkpointAfterPrerequisites(0n, 0n, false), "authorization");
  assert.equal(checkpointAfterPrerequisites(0n, 0n, true), "encryption");
});

test("keeps an unknown wrapper amount behind an authorized review", () => {
  assert.deepEqual(wrapperBalancePresentation("idle", undefined), {
    title: "A confidential wrapper balance is present.",
    detail: "The amount stays private until you authorize a view.",
  });
});

test("offers recovery only for a currently authorized positive wrapper balance", () => {
  assert.equal(canOfferResume("revealed", 40n, 40n), true);
  assert.equal(canOfferRecovery("revealed", 40n), true);
  assert.equal(canOfferResume("revealed", 40n, 0n), false);
  assert.equal(canOfferRecovery("revealed", 0n), false);
});

test("resolves an authorized zero wrapper balance without recovery actions", () => {
  assert.deepEqual(wrapperBalancePresentation("revealed", 0n), {
    title: "No unused confidential balance.",
    detail: "Your confidential wrapper currently holds 0 mUNDER.",
  });
  assert.match(wrapperBalancePresentation("revealed", 10n).detail, /Unwrap it to return public Sepolia mUNDER\./);
});

test("clears wrapper recovery capability when the revealed value is absent", () => {
  assert.equal(canOfferResume("idle", undefined, undefined), false);
  assert.equal(canOfferRecovery("idle", undefined), false);
  assert.equal(canOfferResume("failed", 40n, 40n), false);
});

test("clears revealed wrapper state when the connected wallet session changes", () => {
  const accountA = wrapperStateSessionKey("connected", "0x1111111111111111111111111111111111111111", "wallet-a");
  const accountB = wrapperStateSessionKey("connected", "0x2222222222222222222222222222222222222222", "wallet-a");
  const walletSwitch = wrapperStateSessionKey("connected", "0x1111111111111111111111111111111111111111", "wallet-b");
  const disconnected = wrapperStateSessionKey("disconnected", undefined, "wallet-a");
  assert.notEqual(accountA, accountB);
  assert.notEqual(accountA, walletSwitch);
  assert.notEqual(accountA, disconnected);
});

test("keeps the authorized zero wrapper state independent of round state", () => {
  assert.deepEqual(wrapperBalancePresentation("revealed", 0n), {
    title: "No unused confidential balance.",
    detail: "Your confidential wrapper currently holds 0 mUNDER.",
  });
  assert.equal(canOfferResume("revealed", 10n, 0n), false);
  assert.equal(canOfferRecovery("revealed", 0n), false);
});

test("models the unwrap progress stages in order", () => {
  assert.equal(UNWRAP_PROGRESS_STEPS.length, 7);
  assert.equal(unwrapProgressStep("preparing"), 0);
  assert.equal(unwrapProgressStep("requesting"), 1);
  assert.equal(unwrapProgressStep("confirming"), 2);
  assert.equal(unwrapProgressStep("decrypting"), 3);
  assert.equal(unwrapProgressStep("preparing-finalization"), 4);
  assert.equal(unwrapProgressStep("finalizing"), 5);
  assert.equal(unwrapProgressStep("finalizing-confirmation"), 6);
});

test("keeps wallet prompts and relayer progress explicit", () => {
  assert.match(unwrapProgressCopy("requesting").label, /Confirm the unwrap transaction in your wallet/);
  assert.match(unwrapProgressCopy("finalizing").label, /Confirm the finalization transaction in your wallet/);
  assert.equal(unwrapProgressCopy("decrypting").supporting, "Waiting for the Zama relayer to verify the unwrap amount.");
});

test("formats the completed unwrap success without implying a VeilPool return", () => {
  assert.deepEqual(unwrapSuccessCopy(15_000_000n), {
    title: "Unwrap successful",
    detail: "15 mUNDER has been converted from your confidential balance to public mUNDER in your connected wallet.",
  });
  assert.deepEqual(unwrapSuccessCopy(undefined), {
    title: "Unwrap successful",
    detail: "Your confidential balance has been converted to public mUNDER in your connected wallet.",
  });
});
