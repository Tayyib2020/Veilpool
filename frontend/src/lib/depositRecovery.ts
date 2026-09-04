import { formatUnits } from "ethers";

export const ZERO_CONFIDENTIAL_HANDLE = `0x${"0".repeat(64)}`;

export function hasConfidentialHandle(handle?: string): boolean {
  if (!handle) return false;
  try {
    return BigInt(handle) !== 0n;
  } catch {
    return false;
  }
}

export function wrapperStateSessionKey(status: string, address?: string, walletId?: string): string {
  if (status !== "connected" || !address) return `disconnected:${walletId ?? ""}`;
  return `connected:${walletId ?? ""}:${address.toLowerCase()}`;
}

export type WalletSessionToken = {
  key: string;
  generation: number;
};

export type WalletSessionGuard = {
  update: (key: string) => WalletSessionToken;
  capture: () => WalletSessionToken;
  isCurrent: (token: WalletSessionToken) => boolean;
};

/**
 * Invalidate wallet-scoped async work whenever the account, provider, or
 * connection state changes. The generation prevents an old session from
 * becoming valid again if the user later reconnects the same wallet.
 */
export function createWalletSessionGuard(initialKey = ""): WalletSessionGuard {
  let activeKey = initialKey;
  let generation = 0;

  return {
    update(key) {
      if (key !== activeKey) {
        activeKey = key;
        generation += 1;
      }
      return { key: activeKey, generation };
    },
    capture() {
      return { key: activeKey, generation };
    },
    isCurrent(token) {
      return token.key === activeKey && token.generation === generation;
    },
  };
}

export function sameWalletSession(left: WalletSessionToken, right: WalletSessionToken): boolean {
  return left.key === right.key && left.generation === right.generation;
}

export function requiredWrapAmount(requested: bigint, confidentialBalance: bigint): bigint {
  if (requested <= confidentialBalance) return 0n;
  return requested - confidentialBalance;
}

export function canResumeWithBalance(requested: bigint, confidentialBalance: bigint): boolean {
  return requested > 0n && confidentialBalance >= requested;
}

export type WrapperBalancePresentation = {
  title: string;
  detail: string;
};

export const UNWRAP_PROGRESS_STEPS = [
  "Preparing unwrap",
  "Requesting unwrap",
  "Waiting for unwrap confirmation",
  "Decrypting unwrap amount",
  "Preparing finalization",
  "Finalizing unwrap",
  "Waiting for final confirmation",
] as const;

export type UnwrapProgressStatus =
  | "idle"
  | "preparing"
  | "requesting"
  | "confirming"
  | "decrypting"
  | "preparing-finalization"
  | "finalizing"
  | "finalizing-confirmation"
  | "complete"
  | "failed";

export function unwrapProgressStep(status: UnwrapProgressStatus, lastKnownStep = 0): number {
  const steps: Partial<Record<UnwrapProgressStatus, number>> = {
    preparing: 0,
    requesting: 1,
    confirming: 2,
    decrypting: 3,
    "preparing-finalization": 4,
    finalizing: 5,
    "finalizing-confirmation": 6,
  };
  return steps[status] ?? Math.min(Math.max(lastKnownStep, 0), UNWRAP_PROGRESS_STEPS.length - 1);
}

export function unwrapProgressCopy(status: UnwrapProgressStatus): { label: string; supporting?: string } {
  const copy: Record<UnwrapProgressStatus, { label: string; supporting?: string }> = {
    idle: { label: "Ready to unwrap" },
    preparing: { label: "Preparing unwrap…" },
    requesting: { label: "Confirm the unwrap transaction in your wallet." },
    confirming: { label: "Waiting for unwrap confirmation." },
    decrypting: { label: "Decrypting unwrap amount…", supporting: "Waiting for the Zama relayer to verify the unwrap amount." },
    "preparing-finalization": { label: "Preparing finalization…" },
    finalizing: { label: "Confirm the finalization transaction in your wallet." },
    "finalizing-confirmation": { label: "Waiting for final confirmation." },
    complete: { label: "Unwrap successful" },
    failed: { label: "Unwrap needs attention." },
  };
  return copy[status];
}

export function unwrapSuccessCopy(amount: bigint | undefined, decimals = 6): { title: string; detail: string } {
  if (amount === undefined) {
    return {
      title: "Unwrap successful",
      detail: "Your confidential balance has been converted to public mUNDER in your connected wallet.",
    };
  }
  const formatted = formatUnits(amount, decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return {
    title: "Unwrap successful",
    detail: `${formatted} mUNDER has been converted from your confidential balance to public mUNDER in your connected wallet.`,
  };
}

export function wrapperBalancePresentation(status: "idle" | "requesting" | "revealed" | "failed", value: bigint | undefined, decimals = 6): WrapperBalancePresentation {
  if (status === "revealed" && value === 0n) {
    return { title: "No unused confidential balance.", detail: "Your confidential wrapper currently holds 0 mUNDER." };
  }
  if (status === "revealed" && value !== undefined) {
    const amount = formatUnits(value, decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    return { title: "A confidential wrapper balance is available.", detail: `${amount} mUNDER is safely held in your confidential balance. Unwrap it to return public Sepolia mUNDER.` };
  }
  return { title: "Confidential balance available to review.", detail: "Authorize a private view to check whether any unused confidential balance remains." };
}

export function canOfferResume(status: "idle" | "requesting" | "revealed" | "failed", requested: bigint | undefined, value: bigint | undefined): boolean {
  return status === "revealed" && requested !== undefined && value !== undefined && canResumeWithBalance(requested, value);
}

export function canOfferRecovery(status: "idle" | "requesting" | "revealed" | "failed", value: bigint | undefined): boolean {
  return status === "revealed" && value !== undefined && value > 0n;
}

export type DepositCheckpoint = "approval" | "wrap" | "authorization" | "encryption" | "deposit";

export function checkpointAfterPrerequisites(
  requiredWrap: bigint,
  approval: bigint,
  authorized: boolean,
): DepositCheckpoint {
  if (requiredWrap > 0n && approval < requiredWrap) return "approval";
  if (requiredWrap > 0n) return "wrap";
  if (!authorized) return "authorization";
  return "encryption";
}
