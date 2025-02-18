import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi.js";
import { UniswapV2EthPair } from "./UniswapV2EthPair.js";
import { FACTORY_ADDRESSES } from "./addresses.js";
import { WETH_ADDRESS } from "./addresses.js";
import { Arbitrage } from "./Arbitrage.js";
import { getDefaultRelaySigningKey } from "./utils.js";
import { EnhancedWebSocketManager } from './websocketmanager.js';
import { DEFAULT_THRESHOLDS } from './config/thresholds.js';
import { DEFAULT_CONFIG } from './config/config.js';
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { flattenArray } from "./utils.js";
import { MarketsByToken } from './types.js';
import { CircuitBreaker } from './utils/CircuitBreaker.js';
import { GasPriceManager } from './utils/GasPriceManager.js';
import { logInfo, logError, logDebug, logWarn } from './utils/logger.js';
dotenv.config();

console.log("Starting WebSocket version of MEV bot...");

// Environment variables and configuration
const ETHEREUM_WS_URL = (process.env.ALCHEMY_WEBSOCKET_URL || process.env.ETHEREUM_WS_URL) as string;

if (!ETHEREUM_WS_URL || typeof ETHEREUM_WS_URL !== 'string' || !ETHEREUM_WS_URL.startsWith('wss://')) {
    logError("Error: Invalid or missing WebSocket URL. Please set ALCHEMY_WEBSOCKET_URL or ETHEREUM_WS_URL in your environment variables. URL must start with 'wss://'.");
    process.exit(1);
}

// Fallback RPC URL if ETHEREUM_RPC_URL is not provided
let ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
if (!ETHEREUM_RPC_URL) {
    ETHEREUM_RPC_URL = ETHEREUM_WS_URL.replace('wss://', 'https://');
    logInfo('Derived RPC URL from WebSocket URL', { url: ETHEREUM_RPC_URL });
}

logInfo('WebSocket configuration', { 
    wsUrl: ETHEREUM_WS_URL,
    rpcUrl: ETHEREUM_RPC_URL 
});

const PRIVATE_KEY = process.env.PRIVATE_KEY || getDefaultRelaySigningKey();
const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || "";
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();
const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "90");

// Circuit breaker configuration
const circuitBreakerConfig = {
    maxFailures: 3,
    resetTimeoutMs: 60000, // 1 minute
    cooldownPeriodMs: 300000 // 5 minutes
};

if (PRIVATE_KEY === "") {
    console.error("Error: Must provide PRIVATE_KEY environment variable");
    process.exit(1);
}

if (BUNDLE_EXECUTOR_ADDRESS === "") {
    console.error("Error: Must provide BUNDLE_EXECUTOR_ADDRESS environment variable");
    process.exit(1);
}

async function main() {
    logInfo("Starting MEV searcher with WebSocket...");
    
    try {
        // Initialize HTTP provider for standard JSON-RPC calls
        logInfo('Initializing HTTP Provider...');
        const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
        provider.pollingInterval = parseInt(process.env.PROVIDER_TIMEOUT || "300000");
        logInfo('HTTP Provider initialized', { 
            url: ETHEREUM_RPC_URL,
            pollingInterval: provider.pollingInterval 
        });

        // Initialize wallets
        const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
        const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);
        logInfo('Wallets initialized', {
            searcherAddress: await arbitrageSigningWallet.getAddress()
        });
    
        // Initialize Flashbots provider
        const flashbotsProvider = await FlashbotsBundleProvider.create(
            provider, 
            flashbotsRelaySigningWallet
        );
        logInfo('Flashbots provider initialized');

        // Initialize circuit breaker and gas price manager
        const circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
        const gasPriceManager = new GasPriceManager(provider);

        // Initialize arbitrage instance
        const arbitrage = new Arbitrage(
            arbitrageSigningWallet,
            provider,
            new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider),
            DEFAULT_THRESHOLDS,
            circuitBreaker,
            gasPriceManager
        );
        logInfo('Arbitrage instance initialized');

        // Get initial markets
        logInfo('Fetching initial markets...');
        const markets = await UniswapV2EthPair.getUniswapMarketsByToken(
            provider,
            FACTORY_ADDRESSES,
            UniswapV2EthPair.impactAndFeeFuncs
        );
        
        logInfo('Initial markets before filtering', {
            totalMarkets: flattenArray(Object.values(markets.marketsByToken)).length,
            minLiquidityETH: ethers.utils.formatEther(DEFAULT_THRESHOLDS.MIN_LIQUIDITY_ETH),
            minVolume24H: ethers.utils.formatEther(DEFAULT_THRESHOLDS.MIN_VOLUME_24H),
            maxPriceImpact: '1%',
            maxPairsPerToken: DEFAULT_THRESHOLDS.MAX_PAIRS
        });

        // Update reserves using multicall for efficiency
        if (markets.allMarketPairs.length > 0) {
            logInfo(`Updating reserves via multicall`, { 
                pairCount: markets.allMarketPairs.length 
            });
            
            const updatedPairs = await UniswapV2EthPair.updateReserves(
                provider,
                markets.allMarketPairs,
                WETH_ADDRESS
            );
            markets.allMarketPairs = updatedPairs.filter((pair): pair is UniswapV2EthPair => pair !== undefined);
            logInfo(`Successfully updated reserves`, { 
                updatedPairCount: markets.allMarketPairs.length 
            });
        }

        // Initialize WebSocket manager
        logInfo('Initializing WebSocket manager...');
        const wsManager = new EnhancedWebSocketManager(
            ETHEREUM_WS_URL,
            DEFAULT_CONFIG,
            arbitrage,
            markets.marketsByToken as unknown as MarketsByToken
        );

        logInfo("WebSocket MEV bot initialized successfully!");
        logInfo("Bot is now running and monitoring for arbitrage opportunities...", {
            monitoredPairs: markets.allMarketPairs.length,
            updateInterval: `${DEFAULT_CONFIG.NETWORK.BLOCK_TIME}s`,
            wsEnabled: true
        });

        // Periodic reserve updates
        setInterval(async () => {
            try {
                if (markets.allMarketPairs.length > 0) {
                    logDebug('Starting periodic reserve update', {
                        pairCount: markets.allMarketPairs.length
                    });
                    
                    const updatedPairs = await UniswapV2EthPair.updateReserves(
                        provider, 
                        markets.allMarketPairs,
                        WETH_ADDRESS
                    );
                    markets.allMarketPairs = updatedPairs.filter((pair): pair is UniswapV2EthPair => pair !== undefined);
                    logInfo(`Updated reserves`, { 
                        updatedPairCount: markets.allMarketPairs.length 
                    });
                }
            } catch (error: any) {
                logError('Error updating reserves', { 
                    error: error instanceof Error ? error : new Error(error?.message || String(error))
                });
            }
        }, DEFAULT_CONFIG.NETWORK.BLOCK_TIME * 1000);

    } catch (error: any) {
        logError('Error initializing WebSocket searcher', { error: error as Error });
        process.exit(1);
    }
}

main().catch((error: any) => {
    logError('Unhandled error in main', { 
        error: error instanceof Error ? error : new Error(error?.message || String(error))
    });
    process.exit(1);
});
