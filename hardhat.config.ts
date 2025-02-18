import { HardhatUserConfig } from "hardhat/config";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

// Load plugins
import "@nomicfoundation/hardhat-toolbox";
import "@nomiclabs/hardhat-ethers";

// Load environment variables
dotenvConfig({ path: resolve(__dirname, "./.env") });

if (!process.env.ETH_MAINNET_URL) {
  throw new Error("Please set your ETH_MAINNET_URL in a .env file");
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.ETH_MAINNET_URL,
        blockNumber: 19250000,  // Recent block number
        enabled: true
      },
      chainId: 1,
      mining: {
        auto: true,
        interval: 0
      },
      allowUnlimitedContractSize: true
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto"
    },
    // You can add local network for testing
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY
  },
  mocha: {
    timeout: 100000
  }
} as HardhatUserConfig;

export default config; 