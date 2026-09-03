import { readFileSync } from "node:fs";
import { getAddress, isAddress, Wallet, formatEther } from "ethers";
import { ethers, network } from "hardhat";

const CHAIN_ID = 11155111n;
const deployment = JSON.parse(readFileSync("deployments/sepolia.json", "utf8")) as {
  status: string;
  network: string;
  chainId: number;
  deployer: string;
  operator: string;
  contracts: Record<string, { address: string }>;
  frontendEnv: Record<string, string>;
};

function sameAddress(label: string, actual: string, expected: string): void {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label} mismatch: expected ${getAddress(expected)}, received ${getAddress(actual)}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function frontendEnv(): Record<string, string> {
  const source = readFileSync("frontend/.env.local", "utf8");
  return Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

async function main(): Promise<void> {
  if (network.name !== "sepolia") throw new Error(`Expected Hardhat network sepolia, received ${network.name}`);
  if (deployment.status !== "complete" || deployment.network !== "sepolia" || deployment.chainId !== Number(CHAIN_ID)) {
    throw new Error("deployments/sepolia.json is not a complete Sepolia deployment artifact");
  }

  const connected = await ethers.provider.getNetwork();
  if (connected.chainId !== CHAIN_ID) throw new Error(`Chain ID mismatch: ${connected.chainId}`);

  const deployerKey = requiredEnv("DEPLOYER_PRIVATE_KEY");
  const deployer = new Wallet(deployerKey).address;
  if (!isAddress(deployment.deployer) || !isAddress(deployment.operator)) throw new Error("Deployment artifact contains an invalid signer address");
  sameAddress("deployer", deployer, deployment.deployer);
  sameAddress("operator/deployer", deployment.operator, deployer);

  const balance = await ethers.provider.getBalance(deployer);
  if (balance === 0n) throw new Error("Deployer has zero Sepolia ETH");

  const address = (name: string): string => {
    const value = deployment.contracts[name]?.address;
    if (!value || !isAddress(value)) throw new Error(`Missing or invalid ${name} address`);
    return getAddress(value);
  };
  const addresses = {
    underlying: address("underlyingToken"),
    token: address("confidentialToken"),
    vault: address("veilPool"),
    yieldVault: address("sepoliaYieldVault"),
    adapter: address("yieldAdapter"),
    engine: address("prizeEngine"),
  };

  for (const [name, target] of Object.entries(addresses)) {
    const code = await ethers.provider.getCode(target);
    if (code === "0x") throw new Error(`No deployed bytecode at ${name} ${target}`);
  }

  const wrapper = await ethers.getContractAt(["function underlying() view returns (address)"], addresses.token);
  const vault = await ethers.getContractAt([
    "function confidentialToken() view returns (address)",
    "function prizeEngine() view returns (address)",
    "function maxParticipants() view returns (uint256)",
    "function participantCount() view returns (uint256)",
  ], addresses.vault);
  const engine = await ethers.getContractAt([
    "function vault() view returns (address)",
    "function confidentialToken() view returns (address)",
    "function operator() view returns (address)",
    "function yieldAdapter() view returns (address)",
    "function roundId() view returns (uint256)",
    "function roundState() view returns (uint8)",
    "function publicPrincipalLiability() view returns (uint64)",
    "function roundPrizeAmount() view returns (uint256)",
    "function unallocatedHarvestedYield() view returns (uint256)",
  ], addresses.engine);
  const yieldVault = await ethers.getContractAt([
    "function asset() view returns (address)",
    "function owner() view returns (address)",
  ], addresses.yieldVault);
  const adapter = await ethers.getContractAt([
    "function asset() view returns (address)",
    "function yieldVault() view returns (address)",
    "function controller() view returns (address)",
  ], addresses.adapter);

  sameAddress("wrapper underlying", await wrapper.underlying(), addresses.underlying);
  sameAddress("vault confidential token", await vault.confidentialToken(), addresses.token);
  sameAddress("vault PrizeEngine", await vault.prizeEngine(), addresses.engine);
  sameAddress("engine vault", await engine.vault(), addresses.vault);
  sameAddress("engine confidential token", await engine.confidentialToken(), addresses.token);
  sameAddress("engine operator", await engine.operator(), deployment.operator);
  sameAddress("yield vault asset", await yieldVault.asset(), addresses.underlying);
  sameAddress("yield vault owner", await yieldVault.owner(), deployment.operator);
  sameAddress("adapter asset", await adapter.asset(), addresses.underlying);
  sameAddress("adapter yield vault", await adapter.yieldVault(), addresses.yieldVault);
  sameAddress("adapter controller", await adapter.controller(), addresses.engine);
  sameAddress("engine yield adapter", await engine.yieldAdapter(), addresses.adapter);

  const roundId = await engine.roundId();
  const roundState = await engine.roundState();
  const participantCount = await vault.participantCount();
  if (roundState !== 0n) throw new Error(`Round is not OPEN: state ${roundState}`);
  if (participantCount !== 0n) throw new Error(`Participant count is not zero: ${participantCount}`);
  if (await vault.maxParticipants() !== 10n) throw new Error("VeilPool maxParticipants is not 10");

  const configured = frontendEnv();
  const expectedFrontend: Record<string, string> = {
    VITE_CHAIN_ID: CHAIN_ID.toString(),
    VITE_VEILPOOL_ADDRESS: addresses.vault,
    VITE_CONFIDENTIAL_TOKEN_ADDRESS: addresses.token,
    VITE_UNDERLYING_TOKEN_ADDRESS: addresses.underlying,
    VITE_PRIZE_ENGINE_ADDRESS: addresses.engine,
    VITE_YIELD_ADAPTER_ADDRESS: addresses.adapter,
    VITE_OPERATOR_ADDRESS: getAddress(deployment.operator),
  };
  for (const [key, expected] of Object.entries(expectedFrontend)) {
    if (configured[key] !== expected && configured[key] !== expected.toLowerCase()) {
      throw new Error(`Frontend config mismatch for ${key}`);
    }
  }

  console.log("PHASE_7C_PREFLIGHT_PASS");
  console.log(`Chain ID: ${connected.chainId}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`Operator: ${getAddress(deployment.operator)}`);
  console.log(`Sepolia ETH balance: ${formatEther(balance)}`);
  console.log(`Contracts with bytecode: ${Object.values(addresses).length}/${Object.values(addresses).length}`);
  console.log(`Round: ${roundId} OPEN`);
  console.log(`Participants: ${participantCount}`);
  console.log("Deployment relationships: PASS");
  console.log("Frontend public address configuration: PASS");
}

main().catch((error: unknown) => {
  console.error(`PHASE_7C_PREFLIGHT_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
