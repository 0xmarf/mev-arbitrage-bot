import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi.js";
import { UniswapV2EthPair } from "./UniswapV2EthPair";
import { FACTORY_ADDRESSES, WETH_ADDRESS } from "./addresses.js";
import { Arbitrage } from "./Arbitrage.js";
import { getDefaultRelaySigningKey } from "./utils.js"; 
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { CircuitBreaker } from './utils/CircuitBreaker';
import { GasPriceManager } from './utils/GasPriceManager';
import { DEFAULT_THRESHOLDS } from './config/thresholds';
import { MarketType, MarketsByToken } from './types';
import { BigNumber } from '@ethersproject/bignumber';
import fetch from 'node-fetch';
import { logInfo, logError, logDebug } from './utils/logger.js';

dotenv.config();

const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || "0xD664837a41986DCf1Aba5D36bF9D1D1aaA88B4F1";

// Define the GroupedMarkets interface to match what UniswapV2EthPair.getUniswapMarketsByToken returns
interface GroupedMarkets {
    marketsByToken: { [tokenAddress: string]: UniswapV2EthPair[] };
    allMarketPairs: UniswapV2EthPair[];
    getPriceImpact: (tokenAddress: string, tradeSize: BigNumber) => Promise<BigNumber>;
    getTradingFee: (tokenAddress: string) => Promise<BigNumber>;
}

function log(level: string, message: any) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [${level.toUpperCase()}] ${message}`);
}

function logWithTime(message: string, startTime?: number): number {
    const currentTime = Date.now();
    if (startTime) {
        const duration = currentTime - startTime;
        logInfo(message, { duration });
    } else {
        logInfo(message);
    }
    return currentTime;
}

const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "http://127.0.0.1:8545"
const PRIVATE_KEY = process.env.PRIVATE_KEY || getDefaultRelaySigningKey();
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();
const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "90")

// Circuit breaker configuration
const circuitBreakerConfig = {
    maxFailures: 3,
    resetTimeoutMs: 60000, // 1 minute
    cooldownPeriodMs: 300000 // 5 minutes
};

if (ETHEREUM_RPC_URL === "") {
    console.warn("Must provide ETHEREUM_RPC_URL environment variable. Please see README.md")
    process.exit(1)
}

const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || ""
const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

const circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
const gasPriceManager = new GasPriceManager(provider);

function healthcheck() {
    if (HEALTHCHECK_URL === "") return
    void fetch(HEALTHCHECK_URL)
        .then(() => console.log("healthcheck ping sent"))
        .catch((error: Error) => console.warn("failed to send healthcheck", error))
}

async function updateReserves(markets: GroupedMarkets) {
    try {
        await Promise.all(markets.allMarketPairs.map(async (pair) => {
            const pairContract = new Contract(pair.marketAddress, UniswapV2EthPair.uniswapInterface.interface, provider);
            const reserves = await pairContract.getReserves();
            await pair.updateReserves();
        }));
    } catch (error) {
        log("error", `Failed to update reserves: ${error}`);
    }
}

async function main() {
    const startTime = logWithTime("Starting MEV searcher...");
    console.log("Searcher Wallet Address: " + await arbitrageSigningWallet.getAddress());
    console.log("Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress());

    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);
    
    // Create Arbitrage instance
    const arbitrage = new Arbitrage(
        arbitrageSigningWallet,
        provider,
        new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider),
        DEFAULT_THRESHOLDS,
        circuitBreaker,
        gasPriceManager,
        WETH_ADDRESS
    );

    let markets: GroupedMarkets = {
        marketsByToken: {},
        allMarketPairs: [],
        getPriceImpact: async () => { throw new Error("Not implemented"); },
        getTradingFee: async () => { throw new Error("Not implemented"); },
    };

    const initStart = logWithTime("Initializing markets...");
    try {
        const result = await UniswapV2EthPair.getUniswapMarketsByToken(
            provider,
            FACTORY_ADDRESSES,
            UniswapV2EthPair.impactAndFeeFuncs
        );
        if (result) {
            markets = result;
            const totalMarkets = markets.allMarketPairs.length;
            logWithTime(`Initialized with ${totalMarkets} filtered markets (${Object.keys(markets.marketsByToken).length} tokens)`, initStart);
            
            // Log market statistics
            console.log("Market Statistics:");
            console.log(`- Total Tokens: ${Object.keys(markets.marketsByToken).length}`);
            console.log(`- Total Market Pairs: ${totalMarkets}`);
            console.log(`- Average Pairs per Token: ${(totalMarkets / Object.keys(markets.marketsByToken).length).toFixed(2)}`);
        }
    } catch (error) {
        logWithTime(`Failed to initialize markets: ${error}`, initStart);
        return;
    }

    // Set up event-based monitoring
    provider.on('block', async (blockNumber) => {
        const blockStart = logWithTime(`New block ${blockNumber}: Starting market evaluation`);
        
        try {
            // Update reserves
            const reservesStart = logWithTime("Starting reserves update");
            await updateReserves(markets);
            logWithTime("Finished updating reserves", reservesStart);
            
            // Evaluate markets for arbitrage opportunities
            const evalStart = logWithTime("Starting market evaluation");
            const bestCrossedMarkets = await arbitrage.evaluateMarkets(markets.marketsByToken);
            logWithTime(`Finished market evaluation. Found ${bestCrossedMarkets.length} opportunities`, evalStart);
            
            if (bestCrossedMarkets.length === 0) {
                logWithTime("No crossed markets found", blockStart);
                return;
            }

            logWithTime(`Found ${bestCrossedMarkets.length} crossed markets`);
            // Log details of each crossed market
            bestCrossedMarkets.forEach(market => {
                console.log(`Market Details:
                    Token: ${market.tokenAddress}
                    Buy From: ${market.buyFromMarket.marketAddress}
                    Sell To: ${market.sellToMarket.marketAddress}
                    Profit: ${market.profit.toString()}
                `);
            });
            
            // Execute arbitrage
            const execStart = logWithTime("Starting arbitrage execution");
            await arbitrage.takeCrossedMarkets(bestCrossedMarkets, MINER_REWARD_PERCENTAGE, blockNumber)
                .then(() => {
                    logWithTime("Finished arbitrage execution", execStart);
                    healthcheck();
                })
                .catch(error => logWithTime(`Failed to execute arbitrage: ${error}`, execStart));
        } catch (error) {
            logError(`Error processing block`, {
                blockNumber,
                error: error as Error
            });
        }
    });

    // Monitor for RPC errors
    provider.on("error", (error) => {
        logError(`Provider error`, { error: error as Error });
    });
}

// Start the bot
main().catch((error) => {
    logError(`Fatal error`, { error: error as Error });
    process.exit(1);
});