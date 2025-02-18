import { ethers, Wallet } from 'ethers';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { BUNDLE_EXECUTOR_ABI } from './abi';
import { FACTORY_ADDRESSES } from './addresses';
import { UniswapV2EthPair } from './UniswapV2EthPair';
import { MevShareArbitrage } from './MevShareArbitrage';
import { MevShareService } from './services/MevShareService';
import { DEFAULT_THRESHOLDS } from './config/thresholds';
import { logInfo, logError, logDebug } from './utils/logger.js';
import { providers } from 'ethers';
import { BigNumber } from 'ethers';
import { MevShareConfig } from './services/MevShareService';

// Load environment variables
dotenvConfig({ path: resolve(__dirname, '../.env') });

// Required environment variables
const {
  ETHEREUM_RPC_URL,
  PRIVATE_KEY,
  BUNDLE_EXECUTOR_ADDRESS,
  BUILDERS_API_KEY,
  REFUND_ADDRESS
} = process.env;

// Validate environment variables
if (!ETHEREUM_RPC_URL) throw new Error('ETHEREUM_RPC_URL is required');
if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is required');
if (!BUNDLE_EXECUTOR_ADDRESS) throw new Error('BUNDLE_EXECUTOR_ADDRESS is required');
if (!BUILDERS_API_KEY) throw new Error('BUILDERS_API_KEY is required');
if (!REFUND_ADDRESS) throw new Error('REFUND_ADDRESS is required');

async function main() {
  logInfo("Starting MEV-Share searcher...");
  
  try {
    // Initialize provider and wallet
    const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
    
    if (!PRIVATE_KEY) {
      throw new Error("PRIVATE_KEY environment variable is required");
    }
    const wallet = new Wallet(PRIVATE_KEY);

    logInfo('Initializing MEV-Share arbitrage bot', {
      address: await wallet.getAddress()
    });

    // Initialize contracts
    const bundleExecutorContract = new ethers.Contract(
      BUNDLE_EXECUTOR_ADDRESS as string,
      BUNDLE_EXECUTOR_ABI,
      wallet
    );

    // Initialize MEV-Share service
    const mevShareConfig: MevShareConfig = {
        maxBaseFeeGwei: 100,
        minProfitThreshold: BigNumber.from("100000000000000"), // 0.0001 ETH
        maxBundleSize: 3,
        maxBlocksToTry: 25
    };

    const mevShareService = new MevShareService(
        wallet,
        provider,
        mevShareConfig
    );

    // Initialize arbitrage instance
    const arbitrage = new MevShareArbitrage(
      wallet,
      bundleExecutorContract,
      mevShareService,
      DEFAULT_THRESHOLDS
    );

    // Connect to MEV-Share
    await mevShareService.connect();
    logInfo('Connected to MEV-Share');

    // Initialize markets
    logInfo('Initializing markets...');
    const { marketsByToken } = await UniswapV2EthPair.getUniswapMarketsByToken(
      provider,
      FACTORY_ADDRESSES,
      UniswapV2EthPair.impactAndFeeFuncs
    );
    
    // Set markets in arbitrage instance
    arbitrage.setMarkets(marketsByToken);
    logInfo('Markets initialized', {
      marketCount: Object.values(marketsByToken).flat().length
    });

    // Set up error handlers
    process.on('unhandledRejection', (error: Error) => {
      logError('Unhandled promise rejection', { error });
      process.exit(1);
    });

    process.on('SIGINT', async () => {
      logInfo('Shutting down...');
      await mevShareService.stop();
      process.exit();
    });

    // Keep the process running
    process.stdin.resume();
    
  } catch (error) {
    logError('Fatal error in main', { error: error as Error });
    process.exit(1);
  }
}

// Start the bot
(async () => {
    try {
        await main();
    } catch (error) {
        logError('Fatal error', { error: error as Error });
        process.exit(1);
    }
})(); 