import { ethers } from "hardhat";
import { Arbitrage } from "../src/Arbitrage";
import { EnhancedWebSocketManager } from "../src/websocketmanager";
import { FACTORY_ADDRESSES } from "../src/addresses";
import UniswapV2EthPair from "../src/UniswapV2EthPair";
import { DEFAULT_CONFIG } from "../src/config/config";
import { MarketsByToken } from "../src/types";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Wallet } from "ethers";

async function main() {
  // Get the test account
  const [owner] = await ethers.getSigners();
  console.log("Testing with account:", owner.address);
  
  // Deploy BundleExecutor
  console.log("\nDeploying BundleExecutor...");
  const BundleExecutor = await ethers.getContractFactory("FlashBotsMultiCall");
  const bundleExecutor = await BundleExecutor.deploy(owner.address);
  await bundleExecutor.deployed();
  console.log("BundleExecutor deployed to:", bundleExecutor.address);

  // Fund the bundle executor
  await owner.sendTransaction({
    to: bundleExecutor.address,
    value: ethers.utils.parseEther("10.0")
  });
  console.log("Funded BundleExecutor with 10 ETH");

  // Get markets from major DEXes
  console.log("\nFetching markets...");
  const marketsByToken: MarketsByToken = {};
  
  for (const factoryAddress of Object.values(FACTORY_ADDRESSES)) {
    try {
      const markets = await UniswapV2EthPair.getUniswapMarkets(ethers.provider, factoryAddress);
      console.log(`Found ${markets.length} markets for factory ${factoryAddress}`);
      
      // Group markets by token
      for (const market of markets) {
        for (const token of market.tokens) {
          if (!marketsByToken[token]) {
            marketsByToken[token] = [];
          }
          const marketWithToken = new UniswapV2EthPair(
            market.marketAddress,
            market.tokens,
            market.protocol,
            token,
            ethers.provider
          );
          marketsByToken[token].push(marketWithToken);
        }
      }
    } catch (error) {
      console.error(`Error fetching markets for factory ${factoryAddress}:`, error);
    }
  }

  // Initialize Flashbots provider
  const flashbotsProvider = await FlashbotsBundleProvider.create(
    ethers.provider,
    new Wallet(ethers.Wallet.createRandom().privateKey)
  );

  // Initialize Arbitrage bot
  const arbitrageBot = new Arbitrage(
    new Wallet(ethers.Wallet.createRandom().privateKey),
    flashbotsProvider,
    bundleExecutor
  );
  console.log("\nInitialized Arbitrage bot");

  // Initialize WebSocket manager
  const wsManager = new EnhancedWebSocketManager(
    "ws://localhost:8545",
    DEFAULT_CONFIG,
    arbitrageBot,
    marketsByToken
  );

  // Look for arbitrage opportunities
  console.log("\nLooking for arbitrage opportunities...");
  const opportunities = await arbitrageBot.evaluateMarkets(marketsByToken);
  
  if (opportunities.length > 0) {
    console.log(`Found ${opportunities.length} potential arbitrage opportunities!`);
    
    // Try to execute the first opportunity
    const bestOpportunity = opportunities[0];
    console.log("\nBest opportunity:", {
      token: bestOpportunity.tokenAddress,
      profit: ethers.utils.formatEther(bestOpportunity.profit),
      volume: ethers.utils.formatEther(bestOpportunity.volume)
    });

    try {
      const tx = await arbitrageBot.takeCrossedMarkets(
        [bestOpportunity],
        await ethers.provider.getBlockNumber(),
        10 // 10% miner reward
      );

      if (tx) {
        console.log("Transaction hash:", tx.hash);
        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt.blockNumber);
        console.log("Gas used:", receipt.gasUsed.toString());
      } else {
        console.log("No transaction was sent - opportunity may have disappeared");
      }
    } catch (error) {
      console.error("Error executing arbitrage:", error);
    }
  } else {
    console.log("No profitable arbitrage opportunities found");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 