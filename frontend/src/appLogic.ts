import { formatUnits } from "ethers";

export const ROUND_STATES = [
  "OPEN",
  "LOCKED",
  "AWAITING_TOTAL_DECRYPTION",
  "DRAW_READY",
  "DRAWING",
  "RETRY_REQUIRED",
  "SETTLED",
  "CANCELLED",
] as const;

export type RoundState = (typeof ROUND_STATES)[number];

export type SettledWinningsMessage = {
  tone: "won" | "safe";
  title: string;
  body: string;
};

export const prizeWithdrawalComingSoonNotice = {
  title: "Prize withdrawal coming soon",
  body: "Direct withdrawal of private winnings is planned for an upcoming VeilPool release in the next few weeks. Your winnings remain recorded privately onchain.",
} as const;

export type PrivateOperationKind = "deposit" | "withdraw";

export function operationCopy(kind: PrivateOperationKind): { initialAction: string; preparingAction: string; successAction: string; successStatus: string } {
  if (kind === "deposit") {
    return { initialAction: "Deposit privately", preparingAction: "Preparing deposit…", successAction: "Deposit again", successStatus: "Deposit complete" };
  }
  return { initialAction: "Withdraw privately", preparingAction: "Preparing withdrawal…", successAction: "Withdraw again", successStatus: "Withdrawal complete" };
}

export function operationUiState(state?: { label: string; error?: string }): "initial" | "pending" | "complete" | "failed" {
  if (!state) return "initial";
  if (state.label === "complete") return "complete";
  if (state.error) return "failed";
  return "pending";
}

export function operationButtonState(kind: PrivateOperationKind, state?: { label: string; error?: string }): { label: string; disabled: boolean; loading: boolean } {
  const pending = operationUiState(state) === "pending";
  const copy = operationCopy(kind);
  return { label: pending ? copy.preparingAction : copy.initialAction, disabled: pending, loading: pending };
}

export function canBeginOperation(inFlight: boolean, state?: { label: string; error?: string }): boolean {
  return !inFlight && operationUiState(state) !== "pending";
}

export function shouldShowSettledWinningsMessage(roundState: bigint | number | string | undefined, revealStatus: string, value: bigint | undefined): boolean {
  return Number(roundState) === 6 && revealStatus === "revealed" && value !== undefined;
}

export function settledWinningsMessage(value: bigint, decimals = 6): SettledWinningsMessage {
  if (value === 0n) {
    return {
      tone: "safe",
      title: "Not this round — your savings are safe.",
      body: "You didn't receive this round's prize, but your principal remains yours.",
    };
  }
  const formatted = formatUnits(value, decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return {
    tone: "won",
    title: "You won this round!",
    body: `You received ${formatted} mUNDER from the generated yield. Your savings remain yours.`,
  };
}

export function isSepoliaChain(value: bigint | number | string): boolean {
  return Number(value) === 11155111;
}

export function formatAddress(address: string, leading = 5, trailing = 4): string {
  if (!address || address.length < leading + trailing + 3) return address;
  return `${address.slice(0, leading + 2)}…${address.slice(-trailing)}`;
}

export function roundStateLabel(value: bigint | number | string): RoundState | "UNKNOWN" {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < ROUND_STATES.length ? ROUND_STATES[index] : "UNKNOWN";
}

export function roundStateDescription(state: RoundState | "UNKNOWN"): string {
  const descriptions: Record<RoundState | "UNKNOWN", string> = {
    OPEN: "Saving is open.",
    LOCKED: "Entries for this round are locked.",
    AWAITING_TOTAL_DECRYPTION: "Preparing the public round total.",
    DRAW_READY: "Round is ready for encrypted draw.",
    DRAWING: "Encrypted winner selection is in progress.",
    RETRY_REQUIRED: "A fresh encrypted randomness batch is required.",
    SETTLED: "Round settled.",
    CANCELLED: "Round closed without a prize.",
    UNKNOWN: "Round state is unavailable.",
  };
  return descriptions[state];
}

export function validateAmount(value: string, available?: bigint, decimals = 6): string | undefined {
  const normalized = value.trim();
  if (!normalized) return "Enter an amount.";
  if (!/^\d+(\.\d+)?$/.test(normalized)) return "Enter a valid positive amount.";
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) return `Use no more than ${decimals} decimal places.`;
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (units === 0n) return "Amount must be greater than zero.";
  if (available !== undefined && units > available) return "Amount is above the available balance.";
  return undefined;
}

export function classifyError(error: unknown): string {
  const value = error as { code?: string | number; kind?: string; status?: number; shortMessage?: string; message?: string; error?: { code?: string | number; message?: string } } | undefined;
  const message = `${value?.shortMessage || value?.message || error || "Unknown error"}`.toLowerCase();
  if (value?.kind === "rate-limit") return "Balance service is temporarily busy. Retry shortly.";
  if (value?.kind === "contract") return "The contract rejected the balance request.";
  if (value?.kind === "rpc") return "Unable to refresh your test-asset balance.";
  if (value?.status === 429 || value?.code === 429 || value?.code === -32005 || value?.error?.code === 429 || message.includes("rate limit") || message.includes("too many requests")) return "Balance service is temporarily busy. Retry shortly.";
  if (value?.code === 4001 || message.includes("user rejected") || message.includes("user denied")) return "Wallet request was rejected.";
  if (message.includes("chain") || message.includes("network") || message.includes("wrong network")) return "VeilPool runs on Sepolia. Switch networks and try again.";
  if (message.includes("insufficient funds")) return "The wallet needs more Sepolia ETH for gas.";
  if (message.includes("decrypt") || message.includes("authorization") || message.includes("acl")) return "Authorized decryption failed. Your encrypted state was not exposed.";
  if (message.includes("encrypt") || message.includes("relayer") || message.includes("proof")) return "Confidential encryption could not be completed.";
  if (message.includes("missing revert data") || message.includes("execution reverted") || message.includes("revert")) return "The contract rejected this action.";
  if (message.includes("fetch") || message.includes("rpc") || message.includes("timeout")) return "The network request failed. Check your connection and try again.";
  return "Something went wrong. The transaction was not reported as successful.";
}

export function safeErrorDetails(error: unknown): string {
  type ErrorLike = {
    name?: string;
    code?: string | number;
    shortMessage?: string;
    message?: string;
    data?: unknown;
    transaction?: { hash?: string };
    cause?: unknown;
  };
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    const value = current as ErrorLike;
    const detail = value.shortMessage || value.message || "Unknown error";
    const fields = [value.name, value.code !== undefined ? String(value.code) : undefined, detail.split("\n")[0]];
    if (typeof value.data === "string" && /^0x[0-9a-f]{8,}$/i.test(value.data)) fields.push(`selector ${value.data.slice(0, 10)}`);
    if (value.transaction?.hash) fields.push(`tx ${value.transaction.hash}`);
    parts.push(fields.filter(Boolean).join(" · "));
    current = value.cause;
  }
  return parts.join(" → ").replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 360);
}

export function operationError(operation: string, error: unknown): string {
  return `${operation} failed: ${classifyError(error)}`;
}

export function nextTransactionState(current: string, event: "wallet" | "submitted" | "confirmed" | "failed"): string {
  if (event === "failed") return "failed";
  if (event === "wallet") return "waiting_wallet";
  if (event === "submitted") return "waiting_confirmation";
  if (current === "waiting_confirmation" || current === "waiting_wallet") return "complete";
  return current;
}
