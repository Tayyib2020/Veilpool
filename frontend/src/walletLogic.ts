export type EthereumProvider = {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

export type EIP6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type EIP6963ProviderDetail = {
  info: EIP6963ProviderInfo;
  provider: EthereumProvider;
};

export type WalletOption = {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
  provider: EthereumProvider;
};

export type WalletOptionView = Omit<WalletOption, "provider">;
export const FALLBACK_WALLET_ID = "injected:default";
export const GENERIC_WALLET_NAME = "Compatible EVM wallet";
export const SEPOLIA_CHAIN_ID = 11155111;

function hasRequest(value: unknown): value is EthereumProvider {
  return Boolean(value && typeof (value as EthereumProvider).request === "function");
}

function optionFromAnnouncement(detail: EIP6963ProviderDetail): WalletOption | undefined {
  if (!detail || !hasRequest(detail.provider) || !detail.info?.uuid) return undefined;
  return {
    id: detail.info.uuid,
    name: detail.info.name?.trim() || GENERIC_WALLET_NAME,
    icon: detail.info.icon || undefined,
    rdns: detail.info.rdns || undefined,
    provider: detail.provider,
  };
}

export function collectWalletOptions(announced: readonly EIP6963ProviderDetail[], fallback?: EthereumProvider): WalletOption[] {
  const options: WalletOption[] = [];
  const seenIds = new Set<string>();
  const seenProviders = new Set<EthereumProvider>();
  for (const detail of announced) {
    const option = optionFromAnnouncement(detail);
    if (!option || seenIds.has(option.id) || seenProviders.has(option.provider)) continue;
    seenIds.add(option.id);
    seenProviders.add(option.provider);
    options.push(option);
  }
  if (options.length === 0 && hasRequest(fallback)) options.push({ id: FALLBACK_WALLET_ID, name: GENERIC_WALLET_NAME, provider: fallback });
  return options;
}

export function selectWalletOption(options: readonly WalletOption[], walletId: string): WalletOption | undefined {
  return options.find((option) => option.id === walletId);
}

export function parseChainId(value: unknown): number | undefined {
  const raw = String(value ?? "");
  if (!raw) return undefined;
  const parsed = raw.toLowerCase().startsWith("0x") ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function walletStateForAccount(option: WalletOption, address: string | undefined, chainId: number | undefined) {
  const base = { ethereum: option.provider, walletId: option.id, walletName: option.name, walletIcon: option.icon, chainId };
  if (!address) return { status: "disconnected" as const, ...base };
  return { status: chainId === SEPOLIA_CHAIN_ID ? "connected" as const : "wrong-network" as const, address, ...base };
}

export function disconnectedWalletState(option?: WalletOption, chainId?: number) {
  if (!option) return { status: "disconnected" as const, chainId };
  return walletStateForAccount(option, undefined, chainId);
}

export function clearedWalletState(options: readonly WalletOption[]) {
  return walletStatusWithoutProviders(options) === "unsupported" ? { status: "unsupported" as const } : { status: "disconnected" as const };
}

export function walletStatusWithoutProviders(options: readonly WalletOption[]) {
  return options.length === 0 ? "unsupported" as const : "disconnected" as const;
}
