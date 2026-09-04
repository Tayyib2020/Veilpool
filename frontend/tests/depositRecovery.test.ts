import assert from "node:assert/strict";
import test from "node:test";
import {
  canOfferRecovery,
  canOfferResume,
  canResumeWithBalance,
  checkpointAfterPrerequisites,
  createWalletSessionGuard,
  hasConfidentialBalance,
  requiredWrapAmount,
  sameWalletSession,
  UNWRAP_PROGRESS_STEPS,
  unwrapProgressCopy,
  unwrapProgressStep,
  unwrapSuccessCopy,
  wrapperBalancePresentation,
  wrapperStateSessionKey,
} from "../src/lib/depositRecovery.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

test("ignores a stale Wallet A wrapper reveal after switching to Wallet B", async () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const pending = deferred<bigint>();
  const walletASession = guard.capture();
  let revealed: bigint | undefined;
  const applyReveal = pending.promise.then((value) => {
    if (guard.isCurrent(walletASession)) revealed = value;
  });

  guard.update("connected:wallet-b:0xbbb");
  pending.resolve(40n);
  await applyReveal;

  assert.equal(revealed, undefined);
});

test("ignores a stale Wallet A reveal error after switching sessions", async () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const pending = deferred<bigint>();
  const walletASession = guard.capture();
  let error: unknown;
  const applyError = pending.promise.catch((reason) => {
    if (guard.isCurrent(walletASession)) error = reason;
  });

  guard.update("connected:wallet-b:0xbbb");
  pending.reject(new Error("Wallet A relayer failure"));
  await applyError;

  assert.equal(error, undefined);
});

test("a refresh promise from Wallet A is not current for Wallet B", () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const walletASession = guard.capture();
  guard.update("connected:wallet-b:0xbbb");
  const walletBSession = guard.capture();

  assert.equal(guard.isCurrent(walletASession), false);
  assert.equal(guard.isCurrent(walletBSession), true);
  assert.notEqual(walletASession.generation, walletBSession.generation);
  assert.equal(sameWalletSession(walletASession, walletBSession), false);
});

test("a stale wrapped handle cannot be restored after a wallet switch", async () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const pending = deferred<string>();
  const walletASession = guard.capture();
  let wrappedHandle: string | undefined;
  const applyHandle = pending.promise.then((handle) => {
    if (guard.isCurrent(walletASession)) wrappedHandle = handle;
  });

  guard.update("connected:wallet-b:0xbbb");
  pending.resolve(`0x${"1".padStart(64, "0")}`);
  await applyHandle;

  assert.equal(wrappedHandle, undefined);
});

test("disconnect invalidates pending wallet-scoped async results", () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const walletASession = guard.capture();
  guard.update("disconnected:wallet-a");
  assert.equal(guard.isCurrent(walletASession), false);
});

test("provider reselection invalidates pending wallet-scoped async results", () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const walletASession = guard.capture();
  guard.update("connected:wallet-b:0xaaa");
  assert.equal(guard.isCurrent(walletASession), false);
});

test("a reconnect cannot make an older token current again", () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const firstConnection = guard.capture();
  guard.update("disconnected:wallet-a");
  guard.update("connected:wallet-a:0xaaa");

  assert.equal(guard.isCurrent(firstConnection), false);
});

test("stale completion cannot replace an authorized zero wrapper state", async () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const pending = deferred<bigint>();
  const walletASession = guard.capture();
  let wrapperValue = 0n;
  const applyReveal = pending.promise.then((value) => {
    if (guard.isCurrent(walletASession)) wrapperValue = value;
  });

  guard.update("connected:wallet-b:0xbbb");
  pending.resolve(15n);
  await applyReveal;

  assert.equal(wrapperValue, 0n);
  assert.deepEqual(wrapperBalancePresentation("revealed", wrapperValue), {
    title: "No unused confidential balance.",
    detail: "Your confidential wrapper currently holds 0 mUNDER.",
  });
});

test("current-session async results still update normally", async () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const pending = deferred<bigint>();
  const session = guard.capture();
  let revealed: bigint | undefined;
  const applyReveal = pending.promise.then((value) => {
    if (guard.isCurrent(session)) revealed = value;
  });

  pending.resolve(25n);
  await applyReveal;

  assert.equal(revealed, 25n);
});

test("unwrap and recovery results are invalidated by a session change", () => {
  const guard = createWalletSessionGuard("connected:wallet-a:0xaaa");
  const unwrapSession = guard.capture();
  guard.update("connected:wallet-b:0xbbb");
  assert.equal(guard.isCurrent(unwrapSession), false);
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
