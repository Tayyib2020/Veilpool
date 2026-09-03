export type UnderlyingBalanceReader = {
  balanceOf: (account: string) => Promise<bigint | string | number>;
  decimals: () => Promise<number | bigint | string>;
};

export type UnderlyingBalance = {
  value: bigint;
  decimals: number;
};

export type BalanceReadStatus = "idle" | "loading" | "loaded" | "error";

export type BalanceReadFailureKind = "rpc" | "rate-limit" | "contract";

export class UnderlyingBalanceReadError extends Error {
  readonly kind: BalanceReadFailureKind;
  readonly cause: unknown;

  constructor(kind: BalanceReadFailureKind, cause: unknown) {
    super(kind === "rate-limit" ? "The balance service is temporarily busy." : kind === "contract" ? "The underlying token rejected the balance request." : "The underlying balance could not be read from the network.");
    this.name = "UnderlyingBalanceReadError";
    this.kind = kind;
    this.cause = cause;
  }
}

const decimalsCache = new Map<string, number>();

function readFailureKind(error: unknown): BalanceReadFailureKind {
  const value = error as { code?: string | number; status?: number; shortMessage?: string; message?: string; data?: unknown; error?: { code?: string | number; message?: string } } | undefined;
  const code = value?.code ?? value?.error?.code;
  const message = `${value?.shortMessage || value?.message || value?.error?.message || ""}`.toLowerCase();
  if (value?.status === 429 || code === 429 || code === -32005 || message.includes("rate limit") || message.includes("too many requests")) return "rate-limit";
  if (code === "CALL_EXCEPTION" && typeof value?.data === "string" && value.data.length > 10 && value.data !== "0x") return "contract";
  if (message.includes("execution reverted") && !message.includes("missing revert data")) return "contract";
  return "rpc";
}

export async function readUnderlyingBalance(reader: UnderlyingBalanceReader, account: string, cacheKey?: string): Promise<UnderlyingBalance> {
  try {
    const rawValue = await reader.balanceOf(account);
    let decimals = cacheKey ? decimalsCache.get(cacheKey) : undefined;
    if (decimals === undefined) {
      decimals = Number(await reader.decimals());
      if (cacheKey) decimalsCache.set(cacheKey, decimals);
    }
    return { value: BigInt(String(rawValue)), decimals };
  } catch (error) {
    throw new UnderlyingBalanceReadError(readFailureKind(error), error);
  }
}

export function formatUnderlyingBalance(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function balanceStatusText(status: BalanceReadStatus, value?: bigint, decimals = 6): string {
  if (status === "loading") return "Loading balance…";
  if (status === "error") return "Balance unavailable";
  if (status !== "loaded" || value === undefined) return "Connect wallet to check balance";
  return `${formatUnderlyingBalance(value, decimals)} mUNDER`;
}
