export const TEST_TOKEN_MINT_AMOUNT = 100_000_000n;

export type FaucetAvailability = "idle" | "wallet-required" | "wrong-network";

type FaucetWallet = {
  address?: string;
  signer?: unknown;
  ethereum?: unknown;
  status: string;
};

export function faucetAvailability(wallet: FaucetWallet): FaucetAvailability {
  if (wallet.status === "wrong-network") return "wrong-network";
  if (wallet.status !== "connected" || !wallet.address || !wallet.signer || !wallet.ethereum) return "wallet-required";
  return "idle";
}

export function canStartFaucetMint(status: string): boolean {
  return status !== "minting";
}

type MintTransaction = {
  hash?: string;
  wait: () => Promise<unknown>;
};

export type MintableToken = {
  mint: (recipient: string, amount: bigint) => Promise<MintTransaction>;
};

export async function mintTestTokens(token: MintableToken, recipient: string, refresh?: () => Promise<void>): Promise<string | undefined> {
  const transaction = await token.mint(recipient, TEST_TOKEN_MINT_AMOUNT);
  await transaction.wait();
  if (refresh) await refresh();
  return transaction.hash;
}
