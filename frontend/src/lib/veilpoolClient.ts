import { BrowserProvider, Contract, type ContractRunner, type JsonRpcSigner, type TransactionResponse, hexlify } from "ethers";
import { createInstance, initSDK, SepoliaConfig, type FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import { contractConfig } from "../config/contracts";
import { confidentialTokenAbi, underlyingTokenAbi, veilPoolAbi, prizeEngineAbi, yieldAdapterAbi } from "../contracts/generated";
import type { EthereumProvider } from "../walletLogic";
import { normalizeFheAuthAddresses, normalizeEvmAddress } from "./evmAddress";
import { createInitializedFheInstance } from "./fheSdkInitialization";

export type { EthereumProvider } from "../walletLogic";

export type AppContract = Contract & Record<string, any>;

export type ReadContracts = {
  vault: AppContract;
  token: AppContract;
  underlying: AppContract;
  engine?: AppContract;
  yieldAdapter?: AppContract;
};

export function browserProvider(ethereum: EthereumProvider): BrowserProvider {
  return new BrowserProvider(ethereum as never);
}

export function readContracts(provider: ContractRunner): ReadContracts | undefined {
  if (!contractConfig.veilPool || !contractConfig.confidentialToken || !contractConfig.underlyingToken) return undefined;
  return {
    vault: new Contract(contractConfig.veilPool, veilPoolAbi, provider) as AppContract,
    token: new Contract(contractConfig.confidentialToken, confidentialTokenAbi, provider) as AppContract,
    underlying: new Contract(contractConfig.underlyingToken, underlyingTokenAbi, provider) as AppContract,
    engine: contractConfig.prizeEngine ? new Contract(contractConfig.prizeEngine, prizeEngineAbi, provider) as AppContract : undefined,
    yieldAdapter: contractConfig.yieldAdapter ? new Contract(contractConfig.yieldAdapter, yieldAdapterAbi, provider) as AppContract : undefined,
  };
}

export function yieldAdapterContract(provider: ContractRunner, address: string): AppContract {
  return new Contract(address, yieldAdapterAbi, provider) as AppContract;
}

let fheInstancePromise: Promise<FhevmInstance> | undefined;
let fheInstanceKey = "";
const createInitializedInstance = createInitializedFheInstance(initSDK, createInstance);
const fheProviderIds = new WeakMap<object, number>();
let nextFheProviderId = 1;

function fheProviderKey(ethereum: EthereumProvider): number {
  const provider = ethereum as unknown as object;
  const existingId = fheProviderIds.get(provider);
  if (existingId !== undefined) return existingId;
  const id = nextFheProviderId++;
  fheProviderIds.set(provider, id);
  return id;
}

export async function fhevmInstance(ethereum: EthereumProvider): Promise<FhevmInstance> {
  const key = `${contractConfig.chainId}:${contractConfig.relayerUrl}:${fheProviderKey(ethereum)}`;
  if (fheInstanceKey !== key) {
    fheInstanceKey = key;
    fheInstancePromise = undefined;
  }
  if (!fheInstancePromise) {
    const pending = createInitializedInstance({
        ...SepoliaConfig,
        ...(contractConfig.relayerUrl ? { relayerUrl: contractConfig.relayerUrl } : {}),
        network: ethereum,
        chainId: contractConfig.chainId,
      });
    fheInstancePromise = pending;
    void pending.catch(() => {
      // A transient relayer/network failure must not poison future retries.
      if (fheInstancePromise === pending) fheInstancePromise = undefined;
    });
  }
  return fheInstancePromise!;
}

export async function encryptUint64(ethereum: EthereumProvider, contractAddress: string, userAddress: string, amount: bigint) {
  const instance = await fhevmInstance(ethereum);
  const input = instance.createEncryptedInput(
    normalizeEvmAddress(contractAddress, "FHE contract address"),
    normalizeEvmAddress(userAddress, "FHE user address"),
  );
  input.add64(amount);
  const encrypted = await input.encrypt();
  return { handle: hexlify(encrypted.handles[0]), inputProof: hexlify(encrypted.inputProof) };
}

export async function decryptHandle(
  ethereum: EthereumProvider,
  signer: JsonRpcSigner,
  handle: string,
  contractAddress: string,
  userAddress: string,
): Promise<bigint | boolean> {
  const normalized = normalizeFheAuthAddresses(contractAddress, userAddress);
  const instance = await fhevmInstance(ethereum);
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const eip712 = instance.createEIP712(keypair.publicKey, [normalized.contractAddress], startTimestamp, durationDays);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification as unknown as Array<{ name: string; type: string }> },
    eip712.message,
  );
  const result = await instance.userDecrypt(
    [{ handle, contractAddress: normalized.contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    signature,
    [normalized.contractAddress],
    normalized.userAddress,
    startTimestamp,
    durationDays,
  );
  const values = result as Record<string, bigint | boolean | `0x${string}`>;
  const value = values[handle] ?? values[handle.toLowerCase()];
  if (value === undefined) throw new Error("Decryption returned no value for this handle.");
  if (typeof value !== "bigint" && typeof value !== "boolean") throw new Error("Decryption returned an unsupported value.");
  return value;
}

export async function publicDecryptHandle(
  ethereum: EthereumProvider,
  handle: string,
): Promise<{ value: bigint | boolean; decryptionProof: string }> {
  const instance = await fhevmInstance(ethereum);
  const result = await instance.publicDecrypt([handle]);
  const values = result.clearValues as Record<string, bigint | boolean>;
  const value = values[handle] ?? values[handle.toLowerCase()];
  if (value === undefined) throw new Error("Public decryption returned no value for this handle.");
  return { value, decryptionProof: hexlify(result.decryptionProof) };
}

export async function waitForTransaction(tx: TransactionResponse): Promise<string> {
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Transaction receipt was not returned.");
  return receipt.hash;
}
