import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatEther, getAddress, isAddress, Wallet, type ContractRunner, type ContractTransactionResponse } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, network } from "hardhat";
import {
  ERC4626YieldAdapter__factory,
  MockUnderlyingToken__factory,
  PrizeEngine__factory,
  SepoliaYieldVault__factory,
  VeilPoolConfidentialToken__factory,
  VeilPool__factory,
} from "../types";

const SEPOLIA_CHAIN_ID = 11155111n;
const MAX_PARTICIPANTS = 10n;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const DEPLOYMENT_ARTIFACT = resolve("deployments/sepolia.json");
const PARTIAL_ARTIFACT = resolve("deployments/sepolia.partial.json");
const EXPLORER_BASE_URL = (process.env.EXPLORER_BASE_URL?.trim() || "https://sepolia.etherscan.io").replace(/\/$/, "");

type PublicDeployment = {
  address: string;
  deploymentTxHash: string;
  deploymentBlock: number;
};

type PublicSummary = {
  status: "complete" | "partial";
  network: "sepolia";
  chainId: number;
  deployer: string;
  operator: string;
  yieldSource: "Controlled Sepolia ERC-4626 yield simulation";
  testAssetsOnly: true;
  contracts: Record<string, PublicDeployment | undefined>;
  transactions: Record<string, string>;
  blocks: Record<string, number>;
  frontendEnv: Record<string, string>;
  explorer: {
    contracts: Record<string, string>;
    transactions: Record<string, string>;
  };
  timestamp: string;
};

const deployed: Record<string, PublicDeployment> = {};
const transactions: Record<string, string> = {};
const blocks: Record<string, number> = {};
let deployerAddress = "";
let operatorAddress = "";

type PreflightResult = {
  deployer: HardhatEthersSigner;
  operatorSigner: ContractRunner;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function publicAddress(name: string): string {
  const value = requiredEnv(name);
  if (!isAddress(value)) throw new Error(`${name} is not a valid Ethereum address.`);
  return getAddress(value);
}

function keyAddress(name: string): string {
  const value = requiredEnv(name);
  try {
    return new Wallet(value).address;
  } catch {
    throw new Error(`${name} is not a valid private key.`);
  }
}

function assertSameAddress(label: string, actual: string, expected: string): void {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label} mismatch: expected ${getAddress(expected)}, received ${getAddress(actual)}.`);
  }
}

function explorerUrl(value: string): string {
  return `${EXPLORER_BASE_URL}/${value.startsWith("0x") && value.length === 66 ? "tx" : "address"}/${value}`;
}

function summary(status: "complete" | "partial"): PublicSummary {
  const contracts = Object.fromEntries(Object.entries(deployed).map(([name, value]) => [name, value]));
  const frontendEnv: Record<string, string> = deployed.veilPool && deployed.confidentialToken && deployed.underlyingToken && deployed.prizeEngine && deployed.yieldAdapter
    ? {
        VITE_CHAIN_ID: SEPOLIA_CHAIN_ID.toString(),
        VITE_VEILPOOL_ADDRESS: deployed.veilPool.address,
        VITE_CONFIDENTIAL_TOKEN_ADDRESS: deployed.confidentialToken.address,
        VITE_UNDERLYING_TOKEN_ADDRESS: deployed.underlyingToken.address,
        VITE_PRIZE_ENGINE_ADDRESS: deployed.prizeEngine.address,
        VITE_YIELD_ADAPTER_ADDRESS: deployed.yieldAdapter.address,
        VITE_OPERATOR_ADDRESS: operatorAddress,
      }
    : {};

  return {
    status,
    network: "sepolia",
    chainId: Number(SEPOLIA_CHAIN_ID),
    deployer: deployerAddress,
    operator: operatorAddress,
    yieldSource: "Controlled Sepolia ERC-4626 yield simulation",
    testAssetsOnly: true,
    contracts,
    transactions,
    blocks,
    frontendEnv,
    explorer: {
      contracts: Object.fromEntries(Object.entries(deployed).map(([name, value]) => [name, explorerUrl(value.address)])),
      transactions: Object.fromEntries(Object.entries(transactions).map(([name, hash]) => [name, explorerUrl(hash)])),
    },
    timestamp: new Date().toISOString(),
  };
}

function writeSummary(path: string, status: "complete" | "partial"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(summary(status), null, 2)}\n`, "utf8");
}

async function waitForTransaction(label: string, tx: ContractTransactionResponse): Promise<void> {
  transactions[label] = tx.hash;
  console.log(`${label} transaction: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} transaction did not return a receipt.`);
  blocks[label] = receipt.blockNumber;
}

async function waitForDeployment(label: string, contract: { waitForDeployment(): Promise<unknown>; getAddress(): Promise<string>; deploymentTransaction(): ContractTransactionResponse | null }): Promise<string> {
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`${label} deployment transaction was unavailable.`);
  transactions[label] = tx.hash;
  console.log(`${label}: ${address}`);
  console.log(`${label} deployment transaction: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} deployment did not return a receipt.`);
  deployed[label] = { address, deploymentTxHash: tx.hash, deploymentBlock: receipt.blockNumber };
  blocks[label] = receipt.blockNumber;
  return address;
}

async function verifyRelationships(
  underlying: Awaited<ReturnType<MockUnderlyingToken__factory["deploy"]>>,
  wrapper: Awaited<ReturnType<VeilPoolConfidentialToken__factory["deploy"]>>,
  vault: Awaited<ReturnType<VeilPool__factory["deploy"]>>,
  yieldVault: Awaited<ReturnType<SepoliaYieldVault__factory["deploy"]>>,
  adapter: Awaited<ReturnType<ERC4626YieldAdapter__factory["deploy"]>>,
  engine: Awaited<ReturnType<PrizeEngine__factory["deploy"]>>,
): Promise<void> {
  assertSameAddress("wrapper underlying", await wrapper.underlying(), deployed.underlyingToken.address);
  assertSameAddress("vault confidential token", await vault.confidentialToken(), deployed.confidentialToken.address);
  assertSameAddress("vault PrizeEngine", await vault.prizeEngine(), deployed.prizeEngine.address);
  assertSameAddress("engine vault", await engine.vault(), deployed.veilPool.address);
  assertSameAddress("engine confidential token", await engine.confidentialToken(), deployed.confidentialToken.address);
  assertSameAddress("engine operator", await engine.operator(), operatorAddress);
  assertSameAddress("yield vault asset", await yieldVault.asset(), deployed.underlyingToken.address);
  assertSameAddress("yield vault owner", await yieldVault.owner(), operatorAddress);
  assertSameAddress("adapter asset", await adapter.asset(), deployed.underlyingToken.address);
  assertSameAddress("adapter yield vault", await adapter.yieldVault(), deployed.sepoliaYieldVault.address);
  assertSameAddress("adapter controller", await adapter.controller(), deployed.prizeEngine.address);
  assertSameAddress("engine yield adapter", await engine.yieldAdapter(), deployed.yieldAdapter.address);

  if (await vault.maxParticipants() !== MAX_PARTICIPANTS) throw new Error("VeilPool maxParticipants is not 10.");
  if (await vault.participantCount() !== 0n) throw new Error("VeilPool participant count is not zero.");
  if (await engine.roundId() !== 1n || await engine.roundState() !== 0n) throw new Error("PrizeEngine did not start at round 1 OPEN.");
  if (await engine.publicPrincipalLiability() !== 0n || await engine.roundPrizeAmount() !== 0n || await engine.unallocatedHarvestedYield() !== 0n) {
    throw new Error("PrizeEngine initial accounting is not zero.");
  }
  if (await engine.pendingPrincipalUnwrapRequest() !== ZERO_BYTES32) throw new Error("PrizeEngine has an unexpected pending unwrap request.");
  void underlying;
}

async function preflight(): Promise<PreflightResult> {
  requiredEnv("SEPOLIA_RPC_URL");
  const deployerKeyAddress = keyAddress("DEPLOYER_PRIVATE_KEY");
  operatorAddress = publicAddress("OPERATOR_ADDRESS");

  if (network.name !== "sepolia") throw new Error(`Refusing deployment on network '${network.name}'. Use --network sepolia.`);
  const connectedNetwork = await ethers.provider.getNetwork();
  if (connectedNetwork.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`Refusing deployment on chain ID ${connectedNetwork.chainId}. Expected Sepolia chain ID ${SEPOLIA_CHAIN_ID}.`);
  }

  const [deployer] = await ethers.getSigners();
  deployerAddress = await deployer.getAddress();
  assertSameAddress("deployer private key", deployerAddress, deployerKeyAddress);
  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log(`Deployer: ${deployerAddress}`);
  console.log("Network: Sepolia");
  console.log(`Chain ID: ${SEPOLIA_CHAIN_ID}`);
  console.log(`ETH balance: ${formatEther(balance)}`);
  console.log(`Operator: ${operatorAddress}`);
  if (balance === 0n) throw new Error("Deployer has zero Sepolia ETH; aborting before deployment.");

  let operatorSigner: ContractRunner = deployer;
  if (deployerAddress !== operatorAddress) {
    const operatorKeyAddress = keyAddress("OPERATOR_PRIVATE_KEY");
    assertSameAddress("operator private key", operatorKeyAddress, operatorAddress);
    operatorSigner = new Wallet(requiredEnv("OPERATOR_PRIVATE_KEY"), ethers.provider);
  }

  return { deployer, operatorSigner };
}

async function main(): Promise<void> {
  const { deployer, operatorSigner } = await preflight();
  if (process.argv.includes("--preflight") || process.env.DEPLOYMENT_PREFLIGHT_ONLY === "1") {
    console.log("Sepolia preflight passed; no deployment transactions were sent.");
    return;
  }

  const underlying = await new MockUnderlyingToken__factory(deployer).deploy();
  await waitForDeployment("underlyingToken", underlying);
  const wrapper = await new VeilPoolConfidentialToken__factory(deployer).deploy(deployed.underlyingToken.address);
  await waitForDeployment("confidentialToken", wrapper);
  const vault = await new VeilPool__factory(deployer).deploy(deployed.confidentialToken.address, MAX_PARTICIPANTS);
  await waitForDeployment("veilPool", vault);
  const yieldVault = await new SepoliaYieldVault__factory(deployer).deploy(deployed.underlyingToken.address, operatorAddress);
  await waitForDeployment("sepoliaYieldVault", yieldVault);
  const adapter = await new ERC4626YieldAdapter__factory(deployer).deploy(
    deployed.underlyingToken.address,
    deployed.sepoliaYieldVault.address,
  );
  await waitForDeployment("yieldAdapter", adapter);
  const engine = await new PrizeEngine__factory(deployer).deploy(
    deployed.veilPool.address,
    deployed.confidentialToken.address,
    operatorAddress,
  );
  await waitForDeployment("prizeEngine", engine);

  await waitForTransaction("setPrizeEngine", await vault.setPrizeEngine(deployed.prizeEngine.address));
  await waitForTransaction("setAdapterController", await adapter.setController(deployed.prizeEngine.address));
  await waitForTransaction("setYieldAdapter", await engine.connect(operatorSigner).setYieldAdapter(deployed.yieldAdapter.address));

  await verifyRelationships(underlying, wrapper, vault, yieldVault, adapter, engine);
  writeSummary(DEPLOYMENT_ARTIFACT, "complete");
  console.log(`Deployment artifact: ${DEPLOYMENT_ARTIFACT}`);
  console.log("Yield source: Controlled Sepolia ERC-4626 yield simulation (Test assets only)");
  console.log("Deployment and setup completed; no private values are included in the artifact.");
}

main().catch((error: unknown) => {
  if (Object.keys(deployed).length > 0) writeSummary(PARTIAL_ARTIFACT, "partial");
  const message = error instanceof Error ? error.message : String(error);
  const secrets = [process.env.SEPOLIA_RPC_URL, process.env.DEPLOYER_PRIVATE_KEY, process.env.OPERATOR_PRIVATE_KEY]
    .filter((value): value is string => Boolean(value));
  const sanitized = secrets.reduce((result, secret) => result.split(secret).join("<REDACTED>"), message);
  console.error(`Deployment aborted: ${sanitized}`);
  process.exitCode = 1;
});
