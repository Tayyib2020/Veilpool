/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_SEPOLIA_RPC_URL?: string;
  readonly VITE_EXPLORER_BASE_URL?: string;
  readonly VITE_ZAMA_RELAYER_URL?: string;
  readonly VITE_ROUND_START_TIMESTAMP?: string;
  readonly VITE_VEILPOOL_ADDRESS?: string;
  readonly VITE_CONFIDENTIAL_TOKEN_ADDRESS?: string;
  readonly VITE_UNDERLYING_TOKEN_ADDRESS?: string;
  readonly VITE_PRIZE_ENGINE_ADDRESS?: string;
  readonly VITE_YIELD_ADAPTER_ADDRESS?: string;
  readonly VITE_OPERATOR_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  ethereum?: import("./lib/veilpoolClient").EthereumProvider;
}
