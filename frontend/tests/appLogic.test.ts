import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canBeginOperation, classifyError, formatAddress, isSepoliaChain, nextTransactionState, operationButtonState, operationCopy, operationUiState, roundStateDescription, roundStateLabel, safeErrorDetails, settledWinningsMessage, shouldShowSettledWinningsMessage, validateAmount } from "../src/appLogic.ts";

test("formats wallet addresses without exposing the full value in compact UI", () => {
  assert.equal(formatAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x12345…5678");
});

test("detects Sepolia by chain id", () => {
  assert.equal(isSepoliaChain(11155111), true);
  assert.equal(isSepoliaChain("0x7a69"), false);
  assert.equal(isSepoliaChain(31337), false);
});

test("maps all protocol round states and preserves retry semantics", () => {
  assert.equal(roundStateLabel(0), "OPEN");
  assert.equal(roundStateLabel(5), "RETRY_REQUIRED");
  assert.equal(roundStateDescription("RETRY_REQUIRED"), "A fresh encrypted randomness batch is required.");
  assert.equal(roundStateLabel(99), "UNKNOWN");
});

test("validates confidential amount input against client-side UX limits", () => {
  assert.equal(validateAmount("", undefined), "Enter an amount.");
  assert.equal(validateAmount("0", undefined), "Amount must be greater than zero.");
  assert.equal(validateAmount("1.1234567", undefined), "Use no more than 6 decimal places.");
  assert.equal(validateAmount("2.50", 2_000_000n), "Amount is above the available balance.");
  assert.equal(validateAmount("1.25", 2_000_000n), undefined);
});

test("models wallet and confirmation transaction state transitions", () => {
  assert.equal(nextTransactionState("idle", "wallet"), "waiting_wallet");
  assert.equal(nextTransactionState("waiting_wallet", "submitted"), "waiting_confirmation");
  assert.equal(nextTransactionState("waiting_confirmation", "confirmed"), "complete");
  assert.equal(nextTransactionState("waiting_confirmation", "failed"), "failed");
});

test("keeps private action labels distinct across initial, pending, complete, and repeat states", () => {
  assert.equal(operationUiState(undefined), "initial");
  assert.equal(operationUiState({ label: "Submitting withdrawal" }), "pending");
  assert.equal(operationUiState({ label: "complete" }), "complete");
  assert.equal(operationUiState({ label: "failed", error: "rejected" }), "failed");
  assert.deepEqual(operationCopy("withdraw"), { initialAction: "Withdraw privately", preparingAction: "Preparing withdrawal…", successAction: "Withdraw again", successStatus: "Withdrawal complete" });
  assert.deepEqual(operationCopy("deposit"), { initialAction: "Deposit privately", preparingAction: "Preparing deposit…", successAction: "Deposit again", successStatus: "Deposit complete" });
  assert.deepEqual(operationButtonState("withdraw", { label: "Preparing withdrawal" }), { label: "Preparing withdrawal…", disabled: true, loading: true });
  assert.deepEqual(operationButtonState("deposit", { label: "Checking confidential balance" }), { label: "Preparing deposit…", disabled: true, loading: true });
  assert.deepEqual(operationButtonState("deposit", { label: "failed", error: "rejected" }), { label: "Deposit privately", disabled: false, loading: false });
  assert.equal(canBeginOperation(false), true);
  assert.equal(canBeginOperation(true), false);
  assert.equal(canBeginOperation(false, { label: "Submitting withdrawal" }), false);
});

test("keeps modal primary actions readable across hover, active, focus, and disabled states", () => {
  const css = readFileSync(new URL("../src/user-app.css", import.meta.url), "utf8");
  assert.match(css, /\.app-modal \.button--primary\s*\{[^}]*background: #624bd1;[^}]*color: #fff;/);
  assert.match(css, /\.app-modal \.button--primary:hover:not\(:disabled\)\s*\{[^}]*background: #8069e8;[^}]*color: #fff;/);
  assert.match(css, /\.app-modal \.button--primary:active:not\(:disabled\)\s*\{[^}]*background: #5039b7;[^}]*color: #fff;/);
  assert.match(css, /\.app-modal \.button--primary:focus-visible\s*\{[^}]*outline: 2px solid/);
  assert.match(css, /\.app-modal \.button--primary:disabled\s*\{[^}]*background: #534d72;[^}]*color: #fff;/);
});

test("distinguishes balance RPC failures, rate limits, and real contract reverts", () => {
  assert.equal(classifyError({ kind: "rpc" }), "Unable to refresh your test-asset balance.");
  assert.equal(classifyError({ kind: "rate-limit" }), "Balance service is temporarily busy. Retry shortly.");
  assert.equal(classifyError({ kind: "contract" }), "The contract rejected the balance request.");
});

test("preserves nested FHE causes while redacting endpoint URLs", () => {
  const details = safeErrorDetails({
    name: "TFHEError",
    message: "Impossible to fetch public key: wrong relayer url.",
    cause: {
      name: "TypeError",
      message: "Failed to fetch https://relayer.testnet.zama.org/v2/keyurl",
    },
  });
  assert.match(details, /TFHEError/);
  assert.match(details, /TypeError/);
  assert.match(details, /Failed to fetch \[redacted-url\]/);
  assert.doesNotMatch(details, /relayer\.testnet\.zama\.org/);
});

test("builds participant-only settled winnings messages without exposing another wallet", () => {
  assert.deepEqual(settledWinningsMessage(11_999_999n), {
    tone: "won",
    title: "You won this round!",
    body: "You received 11.999999 mUNDER from the generated yield. Your savings remain yours.",
  });
  assert.deepEqual(settledWinningsMessage(0n), {
    tone: "safe",
    title: "Not this round — your savings are safe.",
    body: "You didn't receive this round's prize, but your principal remains yours.",
  });
});

test("shows settled winnings feedback only after an authorized reveal", () => {
  assert.equal(shouldShowSettledWinningsMessage(6, "revealed", 11_999_999n), true);
  assert.equal(shouldShowSettledWinningsMessage(6, "revealed", 0n), true);
  assert.equal(shouldShowSettledWinningsMessage(6, "idle", undefined), false);
  assert.equal(shouldShowSettledWinningsMessage(6, "failed", 11_999_999n), false);
  assert.equal(shouldShowSettledWinningsMessage(3, "revealed", 11_999_999n), false);
});
