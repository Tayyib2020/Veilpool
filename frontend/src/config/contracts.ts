import { getAddress, isAddress } from "ethers";

export const SEPOLIA_CHAIN_ID = 11155111;
export const DEFAULT_EXPLORER_BASE_URL = "https://sepolia.etherscan.io";
export const DEFAULT_ROUND_DURATION_SECONDS = 24 * 60 * 60;

function readPositiveInteger(key: string, fallback: number): number {
  const value = Number(import.meta.env[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readOptionalTimestamp(key: string): number | undefined {
  const value = Number(import.meta.env[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readAddress(key: string): string | undefined {
  const value = import.meta.env[key]?.trim();
  if (!value) return undefined;
  return isAddress(value) ? getAddress(value) : undefined;
}

export const contractConfig = {
  chainId: Number(import.meta.env.VITE_CHAIN_ID || SEPOLIA_CHAIN_ID),
  rpcUrl: import.meta.env.VITE_SEPOLIA_RPC_URL?.trim() || "",
  explorerBaseUrl: (import.meta.env.VITE_EXPLORER_BASE_URL?.trim() || DEFAULT_EXPLORER_BASE_URL).replace(/\/$/, ""),
  relayerUrl: import.meta.env.VITE_ZAMA_RELAYER_URL?.trim() || "",
  veilPool: readAddress("VITE_VEILPOOL_ADDRESS"),
  confidentialToken: readAddress("VITE_CONFIDENTIAL_TOKEN_ADDRESS"),
  underlyingToken: readAddress("VITE_UNDERLYING_TOKEN_ADDRESS"),
  prizeEngine: readAddress("VITE_PRIZE_ENGINE_ADDRESS"),
  yieldAdapter: readAddress("VITE_YIELD_ADAPTER_ADDRESS"),
  operatorAddress: readAddress("VITE_OPERATOR_ADDRESS"),
};

export const roundSchedule = {
  durationSeconds: readPositiveInteger("VITE_ROUND_DURATION_SECONDS", DEFAULT_ROUND_DURATION_SECONDS),
  startTimestamp: readOptionalTimestamp("VITE_ROUND_START_TIMESTAMP"),
};

export const invalidAddressKeys = [
  "VITE_VEILPOOL_ADDRESS",
  "VITE_CONFIDENTIAL_TOKEN_ADDRESS",
  "VITE_UNDERLYING_TOKEN_ADDRESS",
  "VITE_PRIZE_ENGINE_ADDRESS",
  "VITE_YIELD_ADAPTER_ADDRESS",
  "VITE_OPERATOR_ADDRESS",
].filter((key) => {
  const raw = import.meta.env[key]?.trim();
  return Boolean(raw) && !isAddress(raw);
});

export const missingCoreContracts = [
  ["VeilPool", contractConfig.veilPool],
  ["Confidential token", contractConfig.confidentialToken],
  ["Underlying token", contractConfig.underlyingToken],
].filter(([, address]) => !address).map(([name]) => name);

export const contractsConfigured = contractConfig.chainId === SEPOLIA_CHAIN_ID && missingCoreContracts.length === 0;

export function explorerTxUrl(hash: string): string {
  return `${contractConfig.explorerBaseUrl}/tx/${hash}`;
}
