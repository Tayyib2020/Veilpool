export type FheInputBinding = {
  contractAddress: string;
  userAddress: string;
};

/**
 * VeilPool.deposit is reached through the confidential wrapper's ERC-7984
 * operator flow. The input proof is therefore bound to the wrapper contract
 * and the VeilPool vault, which is the immediate operator caller.
 */
export function depositInputBinding(wrapperAddress: string, vaultAddress: string): FheInputBinding {
  return { contractAddress: wrapperAddress, userAddress: vaultAddress };
}
