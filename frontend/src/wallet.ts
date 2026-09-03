import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type BrowserProvider, type JsonRpcSigner } from "ethers";
import { classifyError } from "./appLogic";
import { contractConfig } from "./config/contracts";
import { browserProvider } from "./lib/veilpoolClient";
import {
  FALLBACK_WALLET_ID,
  GENERIC_WALLET_NAME,
  collectWalletOptions,
  clearedWalletState,
  disconnectedWalletState,
  parseChainId,
  selectWalletOption,
  walletStateForAccount,
  walletStatusWithoutProviders,
  type EIP6963ProviderDetail,
  type EthereumProvider,
  type WalletOption,
  type WalletOptionView,
} from "./walletLogic";

export * from "./walletLogic";

export type WalletStatus = "unsupported" | "disconnected" | "connecting" | "connected" | "wrong-network" | "error";

export type WalletState = {
  status: WalletStatus;
  address?: string;
  chainId?: number;
  error?: string;
  walletId?: string;
  walletName?: string;
  walletIcon?: string;
  ethereum?: EthereumProvider;
  provider?: BrowserProvider;
  signer?: JsonRpcSigner;
};

export function displayErrorMessage(error: unknown): string {
  return classifyError(error);
}

type UseWalletResult = {
  wallet: WalletState;
  walletOptions: WalletOptionView[];
  walletSelectionOpen: boolean;
  connect: (walletId?: string) => Promise<void>;
  closeWalletSelection: () => void;
  resetWallet: () => void;
  switchToSepolia: () => Promise<void>;
};

export function useWallet(): UseWalletResult {
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);
  const [wallet, setWallet] = useState<WalletState>({ status: "unsupported" });
  const [walletSelectionOpen, setWalletSelectionOpen] = useState(false);
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const optionsRef = useRef<WalletOption[]>([]);
  const hydratedWalletRef = useRef("");

  const publishOptions = useCallback((options: WalletOption[]) => {
    optionsRef.current = options;
    setWalletOptions(options);
    setWallet((current) => {
      if (current.status === "unsupported" || (current.status === "error" && !current.ethereum)) {
        return options.length ? { status: "disconnected" } : { status: "unsupported" };
      }
      return current;
    });
  }, []);

  useEffect(() => {
    let active = true;
    const announced = new Map<string, EIP6963ProviderDetail>();
    const fallback = window.ethereum;
    const publish = () => {
      if (active) publishOptions(collectWalletOptions([...announced.values()], fallback));
    };
    const announce = (event: Event) => {
      const detail = (event as CustomEvent<EIP6963ProviderDetail>).detail;
      if (!detail?.info?.uuid || !detail.provider?.request) return;
      announced.set(detail.info.uuid, detail);
      publish();
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const fallbackTimer = window.setTimeout(() => {
      publish();
      if (active) setDiscoveryComplete(true);
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("eip6963:announceProvider", announce);
    };
  }, [publishOptions]);

  const sync = useCallback(async (option: WalletOption, requested = false) => {
    const accounts = (await option.provider.request({ method: requested ? "eth_requestAccounts" : "eth_accounts" })) as string[];
    const chainId = parseChainId(await option.provider.request({ method: "eth_chainId" }));
    const address = accounts[0];
    const next = walletStateForAccount(option, address, chainId);
    if (!address) {
      setWallet(next);
      return;
    }
    const provider = browserProvider(option.provider);
    const signer = await provider.getSigner(address);
    setWallet({ ...next, provider, signer });
  }, []);

  useEffect(() => {
    if (!discoveryComplete || walletOptions.length !== 1 || (wallet.status !== "disconnected" && wallet.status !== "unsupported")) return;
    const option = walletOptions[0];
    if (hydratedWalletRef.current === option.id) return;
    hydratedWalletRef.current = option.id;
    void sync(option).catch((error) => setWallet({ ...disconnectedWalletState(option), status: "error", error: displayErrorMessage(error) }));
  }, [discoveryComplete, sync, wallet.status, walletOptions]);

  useEffect(() => {
    const ethereum = wallet.ethereum;
    if (!ethereum) return;
    const option = selectWalletOption(optionsRef.current, wallet.walletId ?? "") ?? {
      id: wallet.walletId ?? FALLBACK_WALLET_ID,
      name: wallet.walletName ?? GENERIC_WALLET_NAME,
      icon: wallet.walletIcon,
      provider: ethereum,
    };
    const accountsChanged = () => {
      void sync(option).catch((error) => setWallet({ ...disconnectedWalletState(option), status: "error", error: displayErrorMessage(error) }));
    };
    const chainChanged = () => {
      void sync(option).catch((error) => setWallet({ ...disconnectedWalletState(option), status: "error", error: displayErrorMessage(error) }));
    };
    const disconnected = () => {
      hydratedWalletRef.current = "";
      setWallet({ ...clearedWalletState(optionsRef.current), error: "Wallet disconnected." });
    };
    ethereum.on?.("accountsChanged", accountsChanged);
    ethereum.on?.("chainChanged", chainChanged);
    ethereum.on?.("disconnect", disconnected);
    return () => {
      ethereum.removeListener?.("accountsChanged", accountsChanged);
      ethereum.removeListener?.("chainChanged", chainChanged);
      ethereum.removeListener?.("disconnect", disconnected);
    };
  }, [sync, wallet.chainId, wallet.ethereum, wallet.walletIcon, wallet.walletId, wallet.walletName]);

  const connect = useCallback(async (walletId?: string) => {
    const options = optionsRef.current;
    const option = walletId ? selectWalletOption(options, walletId) : options.length === 1 ? options[0] : undefined;
    if (!option) {
      if (options.length === 0) setWallet({ status: "unsupported", error: "No compatible EVM wallet was detected. Install an EIP-1193-compatible browser wallet." });
      else setWalletSelectionOpen(true);
      return;
    }
    setWalletSelectionOpen(false);
    setWallet((current) => ({ ...current, ...walletStateForAccount(option, undefined, current.chainId), status: "connecting", error: undefined }));
    try {
      await sync(option, true);
    } catch (error) {
      setWallet({ ...disconnectedWalletState(option), status: "error", error: displayErrorMessage(error) });
    }
  }, [sync]);

  const resetWallet = useCallback(() => {
    hydratedWalletRef.current = "";
    setWalletSelectionOpen(false);
    setWallet(clearedWalletState(optionsRef.current));
  }, []);

  const switchToSepolia = useCallback(async () => {
    const ethereum = wallet.ethereum;
    if (!ethereum) return;
    const option = wallet.walletId ? selectWalletOption(optionsRef.current, wallet.walletId) : undefined;
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
      if (option) await sync(option);
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code === 4902) {
        if (!contractConfig.rpcUrl) throw new Error("Your wallet does not have Sepolia. Set VITE_SEPOLIA_RPC_URL before adding it automatically.");
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: "0xaa36a7", chainName: "Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [contractConfig.rpcUrl], blockExplorerUrls: ["https://sepolia.etherscan.io"] }],
        });
        if (option) await sync(option);
        return;
      }
      setWallet((current) => ({ ...current, status: "wrong-network", error: displayErrorMessage(error) }));
      throw error;
    }
  }, [sync, wallet.ethereum, wallet.walletId]);

  const walletOptionViews = useMemo(() => walletOptions.map(({ provider: _provider, ...view }) => view), [walletOptions]);
  const closeWalletSelection = useCallback(() => setWalletSelectionOpen(false), []);

  return { wallet, walletOptions: walletOptionViews, walletSelectionOpen, connect, closeWalletSelection, resetWallet, switchToSepolia };
}
