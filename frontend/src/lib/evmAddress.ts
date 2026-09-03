import { getAddress, isAddress, isHexString } from "ethers";

/**
 * Return the canonical EIP-55 spelling for a public EVM address.
 *
 * EIP-1193 providers are allowed to return lower-case addresses, while the
 * Zama relayer SDK's browser WASM bindings require EIP-55 addresses for FHE
 * input and user-decryption operations. A mixed-case checksum failure is
 * therefore recovered only after the value has been proven to be exactly a
 * 20-byte hex address. Malformed values are never silently rewritten.
 */
export function normalizeEvmAddress(value: string, label = "EVM address"): string {
  const candidate = value.trim();
  if (!isHexString(candidate, 20)) {
    throw new Error(`${label} must be a 20-byte hexadecimal address.`);
  }
  const lowercaseCandidate = candidate.toLowerCase();
  if (isAddress(candidate)) return getAddress(candidate);
  return getAddress(lowercaseCandidate);
}

export function normalizeFheAuthAddresses(contractAddress: string, userAddress: string) {
  return {
    contractAddress: normalizeEvmAddress(contractAddress, "FHE contract address"),
    userAddress: normalizeEvmAddress(userAddress, "FHE user address"),
  };
}
