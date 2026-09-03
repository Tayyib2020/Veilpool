import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@typechain/hardhat";
import type { HardhatUserConfig } from "hardhat/config";

const MNEMONIC = "test test test test test test test test test test test junk";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL?.trim() || "";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim();

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      accounts: { mnemonic: MNEMONIC },
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.27",
    settings: {
      metadata: { bytecodeHash: "none" },
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
    },
  },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
};

export default config;
