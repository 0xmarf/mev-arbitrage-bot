import * as _ from "lodash";
import { BigNumber } from '@ethersproject/bignumber';
import { Contract } from '@ethersproject/contracts';
import { Wallet } from '@ethersproject/wallet';
import { providers, ethers } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { WETH_ADDRESS } from "./addresses.js";
import { EthMarket } from "./EthMarket.js";
import type { MarketType } from "./EthMarket.js";
import { ETHER, bigNumberToDecimal } from "./utils.js";
import { MarketsByToken, CrossedMarketDetails, BuyCalls } from './types.js';
import { Provider } from "@ethersproject/providers";
import { TransactionResponse } from "@ethersproject/providers";
import { MarketThresholds, DEFAULT_THRESHOLDS } from './config/thresholds.js';
import { EnhancedWebSocketManager } from "./websocketmanager.js";
import { CFMM, UniswapV2CFMM } from "./cfmm/CFMM.js";
import { UtilityFunction, SimpleArbitrageUtility } from "./utility/UtilityFunction.js";
import { HybridOptimizer } from './optimization/HybridOptimizer.js';
import { logInfo, logError, logDebug, logWarn } from './utils/logger.js';
import { CircuitBreaker } from './utils/CircuitBreaker.js';
import { GasPriceManager } from './utils/GasPriceManager.js';

export { MarketsByToken, CrossedMarketDetails } from './types.js';

export interface BundleEntry {
    to: string,
    gas: number,
    gas_price: string,
    value: number,
    input: string,
    from: string,
    signedTransaction: string,
    signer: string,
}

// Update CFMM to use BigNumber
let CFMM = {
    reserves: {
        x: BigNumber.from(0),
        y: BigNumber.from(0),
    },
    getOutputAmount: function (inputAmount: BigNumber, inputReserve: BigNumber, outputReserve: BigNumber) {
        const inputAmountWithFee = inputAmount.mul(997);
        const numerator = inputAmountWithFee.mul(outputReserve);
        const denominator = inputReserve.mul(1000).add(inputAmountWithFee);
        return numerator.div(denominator);
    },
    tradingFee: BigNumber.from("3000"),
};

let acceptTrade = (R: BigNumber, deltaPlus: number, deltaMinus: number) => {
    let tradingFunctionResult = CFMM.getOutputAmount(R.sub(CFMM.tradingFee.mul(deltaMinus)).sub(deltaPlus), CFMM.reserves.x, CFMM.reserves.y);
    let tradingFunctionResult2 = CFMM.getOutputAmount(R, CFMM.reserves.x, CFMM.reserves.y);
    logDebug('Trade evaluation results', {
        tradingFunctionResult: tradingFunctionResult.toString(),
        tradingFunctionResult2: tradingFunctionResult2.toString()
    });
    return tradingFunctionResult.gte(tradingFunctionResult2) && R.sub(CFMM.tradingFee.mul(deltaMinus)).sub(deltaPlus).gte(0);
};

export const dualDecomposition = (referencePrices: string | any[], objectiveFunction: (arg0: any) => any, penaltyVector: number[]) => {
    logInfo("Entering dualDecomposition");
    let T = [];
    for (let i = 0; i < referencePrices.length; i++) {
        let deltaPlus = referencePrices[i].cumulativePrice;
        let deltaMinus = Math.min(referencePrices[i].cumulativePrice, 0);
        logDebug(`Iteration details`, { iteration: i, deltaPlus, deltaMinus });
        if (acceptTrade(CFMM.reserves.x, deltaPlus, deltaMinus)) {
            T.push([deltaPlus, deltaMinus]);
        }
    }
    let nu = 0;
    for (let i = 0; i < T.length; i++) {
        let objectiveFunctionResult = objectiveFunction(T[i][0]);
        let penaltyResult = penaltyVector[i] * nu;
        logDebug(`Optimization details`, { iteration: i, objectiveFunctionResult, penaltyResult });
        nu = Math.max(nu, (objectiveFunctionResult - penaltyResult));
    }
    logInfo(`Dual decomposition completed`, { finalNu: nu });
    return nu;
};

// Define the bisection search
let bisectionSearch = (referencePrices: Array<{ cumulativePrice: number; marketCount: number; }>, objectiveFunction: (arg0: number) => number, penaltyVector: number[]) => {
    logInfo("Entering bisectionSearch");
    let left = 0;
    let right = referencePrices.length - 1;
    let tolerance = 1e-6;
    let psi;

    while (right - left > tolerance) {
        let mid = Math.floor((left + right) / 2);
        let midValue = objectiveFunction(mid);
        let penaltyResult = penaltyVector[mid] * mid;

        if (midValue > penaltyResult) {
            left = mid;
            psi = mid;
        } else {
            right = mid;
        }
    }
    logInfo(`Bisection search completed`, { finalPsi: psi });

    return psi;
};

let swapMarketArbitrage = (referencePrices: Array<{ cumulativePrice: number; marketCount: number; }> = [], objectiveFunction: (price: number) => number, penaltyVector: number[]) => {
    logInfo("Entering swapMarketArbitrage");
    // Initialize the dual variable ν
    let nu = 0;

    // Use bisection or ternary search to solve for the vector Ψ
    // Assuming that bisectionSearch accepts a number, not an array
    let psi = bisectionSearch(referencePrices, objectiveFunction, penaltyVector);

    // Iterate through the ∆i with i = 1, . . . , m
    for (let i = 0; i < referencePrices.length; i++) {
        // Compute the objective function U(Ψ)
        // Ensure psi is used correctly as an index
        if (psi !== undefined && psi >= 0 && psi < referencePrices.length) {
            const objectiveFunctionResult = objectiveFunction(referencePrices[psi].cumulativePrice);

            // Compute the linear penalty in the objective
            let penaltyResult = penaltyVector[i] * nu;

            // Update the dual variable ν
            nu = Math.max(nu, (objectiveFunctionResult - penaltyResult));
        }
    }
    // Return the dual variable ν
    logInfo(`Swap market arbitrage completed`, { finalNu: nu });
    return nu;
};

export class Arbitrage {
    [x: string]: any;
    private bundleEntries: { bundle: BundleEntry[], blockNumber: number }[] = [];
    private readonly wallet: Wallet;
    private readonly provider: Provider;
    private readonly bundleExecutorContract: Contract;
    private readonly thresholds: MarketThresholds;
    private readonly circuitBreaker: CircuitBreaker;
    private readonly gasPriceManager: GasPriceManager;
    private readonly WETH_ADDRESS: string;

    constructor(
        wallet: Wallet,
        provider: Provider,
        bundleExecutorContract: Contract,
        thresholds: MarketThresholds,
        circuitBreaker: CircuitBreaker,
        gasPriceManager: GasPriceManager,
        wethAddress: string = WETH_ADDRESS
    ) {
        this.wallet = wallet;
        this.provider = provider;
        this.bundleExecutorContract = bundleExecutorContract;
        this.thresholds = thresholds;
        this.circuitBreaker = circuitBreaker;
        this.gasPriceManager = gasPriceManager;
        this.WETH_ADDRESS = wethAddress;
    }

    public async evaluateMarkets(
        marketsByToken: MarketsByToken
    ): Promise<CrossedMarketDetails[]> {
        logInfo('Starting market evaluation using hybrid optimization...');

        const opportunities: CrossedMarketDetails[] = [];

        try {
            // Update reserves for all markets
            for (const markets of Object.values(marketsByToken)) {
                await Promise.all(markets.map(market => (market as MarketType).updateReserves()));
            }

            // Convert markets to CFMM format
            const cfmmNetwork = await this.convertMarketsToNetwork(marketsByToken);

            // Create utility function
            const utility: UtilityFunction = {
                U: (delta: BigNumber[]) => {
                    // Simple quadratic utility function
                    return delta.reduce((a, b) => a.add(b.mul(b)), BigNumber.from(0));
                },
                U_optimal: (v: BigNumber[]) => {
                    // Simple quadratic utility function
                    const value = v.reduce((a, b) => a.add(b.mul(b)), BigNumber.from(0));
                    const gradient = v.map(vi => vi.mul(2));
                    return { value, gradient };
                }
            };

            // Create and configure optimizer
            const optimizer = new HybridOptimizer(
                cfmmNetwork,
                utility,
                {
                    maxIterations: 100,
                    tolerance: 1e-6,
                    memory: 10
                }
            );

            // Run optimization
            const initialV = cfmmNetwork.map(() => BigNumber.from('1000000000000000000')); // 1 ETH initial price
            const result = await optimizer.optimize(initialV);

            logInfo(`Optimization completed: converged=${result.converged}, iterations=${result.iterations}`);
            logDebug(`Final dual value: ${result.dualValue.toString()}`);

            if (result.converged && result.dualValue.gt(this.thresholds.minProfitThreshold)) {
                // Convert optimization result to CrossedMarketDetails
                const crossedMarkets = await this.convertOptimizationResult(result, marketsByToken);
                opportunities.push(...crossedMarkets);
            }
        } catch (error) {
            logError('Error in market evaluation', {
                error: error instanceof Error ? error : new Error(String(error))
            });
        }

        return opportunities;
    }

    private async convertMarketsToNetwork(marketsByToken: MarketsByToken): Promise<CFMM[]> {
        const cfmmNetwork: CFMM[] = [];

        for (const [tokenAddress, markets] of Object.entries(marketsByToken)) {
            for (const market of markets) {
                const marketWithReserves = market as MarketType;
                const reserves = await marketWithReserves.getReservesByToken();
                
                if (!Array.isArray(reserves)) {
                    throw new Error('Expected array of reserves');
                }

                const cfmm: CFMM = {
                    reserves,
                    fee: 0.003, // 0.3% fee for Uniswap V2
                    A: [[1, 0], [0, 1]], // Identity matrix for simple case
                    marketAddress: marketWithReserves.marketAddress,
                    tradingFunction: (r: BigNumber[]) => {
                        return r[0].mul(r[1]); // x * y = k
                    },
                    tradingFunctionGradient: (r: BigNumber[]) => {
                        return [r[1], r[0]]; // [y, x]
                    },
                    arbitrage: async (prices: BigNumber[]) => {
                        const currentReserves = await marketWithReserves.getReservesByToken();
                        if (!Array.isArray(currentReserves)) {
                            throw new Error('Expected array of reserves');
                        }
                        const optimalDelta = await this.calculateOptimalDelta(currentReserves, prices);
                        const value = optimalDelta.reduce((a, b) => a.add(b), BigNumber.from(0));
                        return { delta: optimalDelta, value };
                    },
                    updateReserves: async () => {
                        await marketWithReserves.updateReserves();
                    }
                };

                cfmmNetwork.push(cfmm);
            }
        }

        return cfmmNetwork;
    }

    private async calculateOptimalDelta(reserves: BigNumber[], prices: BigNumber[]): Promise<BigNumber[]> {
        // Simple implementation - can be improved
        const price0 = prices[0];
        const price1 = prices[1];
        const reserve0 = reserves[0];
        const reserve1 = reserves[1];

        // Calculate optimal trade size based on price difference
        const priceDiff = price1.sub(price0);
        if (priceDiff.gt(0)) {
            // Buy token0, sell token1
            const delta0 = reserve0.mul(20).div(100); // Use 20% of reserves as a conservative estimate
            const delta1 = delta0.mul(price0).div(BigNumber.from('1000000000000000000')); // Scale by 1e18
            return [delta0, delta1.mul(-1)];
        } else {
            // Buy token1, sell token0
            const delta1 = reserve1.mul(20).div(100);
            const delta0 = delta1.mul(price1).div(BigNumber.from('1000000000000000000'));
            return [delta0.mul(-1), delta1];
        }
    }

    private async convertOptimizationResult(
        result: { v: BigNumber[]; dualValue: BigNumber },
        marketsByToken: MarketsByToken
    ): Promise<CrossedMarketDetails[]> {
        const opportunities: CrossedMarketDetails[] = [];

        // Group markets by token pairs
        for (const [tokenAddress, markets] of Object.entries(marketsByToken)) {
            for (let i = 0; i < markets.length; i++) {
                for (let j = i + 1; j < markets.length; j++) {
                    const market1 = markets[i] as MarketType;
                    const market2 = markets[j] as MarketType;

                    try {
                        // Calculate potential profit using optimization results
                        const reserves1 = await market1.getReservesByToken();
                        const reserves2 = await market2.getReservesByToken();
                        if (!Array.isArray(reserves1) || !Array.isArray(reserves2)) {
                            throw new Error('Expected array of reserves');
                        }

                        const optimalDelta1 = await this.calculateOptimalDelta(reserves1, [result.v[i], result.v[j]]);
                        const optimalDelta2 = await this.calculateOptimalDelta(reserves2, [result.v[j], result.v[i]]);

                        // Estimate profit (simplified)
                        const profit = optimalDelta1[0].mul(result.v[i])
                            .add(optimalDelta1[1].mul(result.v[j]))
                            .add(optimalDelta2[0].mul(result.v[j]))
                            .add(optimalDelta2[1].mul(result.v[i]));

                        if (profit.gt(this.thresholds.minProfitThreshold)) {
                            opportunities.push({
                                buyFromMarket: market1,
                                sellToMarket: market2,
                                volume: optimalDelta1[0].abs(),
                                profit,
                                marketPairs: [
                                    {
                                        market: market1,
                                        tokens: market1.tokens
                                    },
                                    {
                                        market: market2,
                                        tokens: market2.tokens
                                    }
                                ],
                                tokenAddress: this.WETH_ADDRESS
                            });
                        }
                    } catch (error) {
                        logError('Error calculating opportunity', {
                            error: error instanceof Error ? error : new Error(String(error)),
                            marketAddress: market1.marketAddress
                        });
                        continue;
                    }
                }
            }
        }

        return opportunities;
    }

    async takeCrossedMarkets(
        markets: CrossedMarketDetails[],
        currentBlock: number,
        maxAttempts: number
    ): Promise<void> {
        for (const market of markets) {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const transaction = await this.executeArbitrageTrade(market, currentBlock);
                    if (transaction) {
                        logInfo(`Successful arbitrage execution`, { 
                            txHash: transaction.hash,
                            blockNumber: currentBlock,
                            marketAddress: market.buyFromMarket.marketAddress
                        });
                        await transaction.wait(1);
                        break;
                    }
                } catch (error) {
                    logError(`Arbitrage attempt failed`, {
                        attempt,
                        maxAttempts,
                        error: error as Error,
                        marketAddress: market.buyFromMarket.marketAddress,
                        blockNumber: currentBlock
                    });
                    if (attempt === maxAttempts) {
                        logError("Max attempts reached for market", {
                            marketAddress: market.buyFromMarket.marketAddress,
                            blockNumber: currentBlock
                        });
                    } else {
                        await new Promise(r => setTimeout(r, this.RETRY_DELAY));
                    }
                }
            }
        }
    }

    public async findArbitrageTrades(arbitrageOpportunities: number, marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
        logInfo("Starting arbitrage trade search");
        let crossedMarkets: Array<CrossedMarketDetails> = [];

        logInfo(`Market analysis starting`, {
            totalMarkets: Object.values(marketsByToken).flat().length,
            thresholds: {
                minLiquidity: ethers.utils.formatEther(this.thresholds.MIN_LIQUIDITY_ETH),
                minVolume: ethers.utils.formatEther(this.thresholds.MIN_VOLUME_24H),
                minMarketCap: ethers.utils.formatEther(this.thresholds.MIN_MARKET_CAP),
                maxPairs: this.thresholds.MAX_PAIRS
            }
        });

        // Filter markets based on thresholds
        const filteredMarketsByToken: MarketsByToken = {};

        // Process each token's markets with proper async handling
        for (const tokenAddress in marketsByToken) {
            // Filter markets using Promise.all for parallel processing
            const markets = await Promise.all(
                marketsByToken[tokenAddress].map(async (market) => {
                    try {
                        const liquidity = await market.getReservesByToken(tokenAddress);
                        if (Array.isArray(liquidity)) {
                            throw new Error('Unexpected array of reserves');
                        }
                        if (liquidity.lt(this.thresholds.MIN_LIQUIDITY_ETH)) return null;
                        const wethBalance = await this.fetchWETHBalance(market.marketAddress);
                        if (wethBalance?.lt(this.thresholds.MIN_LIQUIDITY_ETH)) return null;
                        return market;
                    } catch (error) {
                        logError(`Error filtering market`, {
                            marketAddress: market.marketAddress,
                            error: error as Error
                        });
                        return null;
                    }
                })
            );

            // Remove null values and limit pairs
            const validMarkets = markets.filter((market): market is EthMarket => market !== null).slice(0, this.thresholds.MAX_PAIRS);

            if (validMarkets.length > 0) {
                filteredMarketsByToken[tokenAddress] = validMarkets;
            }
        }

        logInfo(`Market filtering completed`, {
            filteredMarkets: Object.values(filteredMarketsByToken).flat().length
        });

        // Get the reference prices for filtered markets
        let referencePrices = this.generateReferencePrices(filteredMarketsByToken);


        // Iterate through the given markets by token
        for (const tokenAddress in filteredMarketsByToken) {
            const markets = filteredMarketsByToken[tokenAddress];

            // Calculate the arbitrage opportunities
            for (let i = 0; i < markets.length; i++) {
                for (let j = i + 1; j < markets.length; j++) {
                    const buyFromMarket = markets[i] as EthMarket; // Ensure buyFromMarket is of type MarketType
                    const sellToMarket = markets[j] as EthMarket;

                    // Determine the difference between buy and sell prices
                    const sellToMarketRefPrice = (await referencePrices).find(refPrice => refPrice.marketAddress === sellToMarket.marketAddress);
                    const buyFromMarketRefPrice = (await referencePrices).find(refPrice => refPrice.marketAddress === buyFromMarket.marketAddress);

                    if (!sellToMarketRefPrice || !buyFromMarketRefPrice) {
                        continue; // Skip if either reference price is undefined
                    }

                    const profit = sellToMarketRefPrice.cumulativePrice - buyFromMarketRefPrice.cumulativePrice;

                    if (profit > 0) {
                        // Calculate the optimal trade volume based on your trading strategy
                        const optimalVolume = await this.calculateOptimalVolume(buyFromMarket, sellToMarket, tokenAddress, BigNumber.from(profit));

                        // Create a CrossedMarketDetails object and add it to the list of arbitrage opportunities
                        crossedMarkets.push({
                            profit: BigNumber.from(profit),
                            volume: optimalVolume,
                            tokenAddress,
                            buyFromMarket,
                            sellToMarket,
                            marketPairs: []
                        });
                    }
                }
            }
        }

        // Sort the list of arbitrage opportunities based on the highest profit
        crossedMarkets.sort((a, b) => b.profit.sub(a.profit).toNumber());
        logInfo(`Arbitrage opportunities found`, { count: crossedMarkets.length });
        return crossedMarkets;
    }

    generateReferencePrices = async (marketsByToken: MarketsByToken): Promise<Array<{ marketAddress: string; cumulativePrice: number; marketCount: number; }>> => {
        logInfo("Starting reference price generation");
        let referencePrices: Array<{ marketAddress: string, cumulativePrice: number, marketCount: number }> = [];

        for (const tokenAddress in marketsByToken) {
            const markets = marketsByToken[tokenAddress];

            for (const market of markets) {
                if (!market || !market.tokens || market.tokens.length < 2) {
                    logWarn(`Skipping invalid market`, { marketAddress: market?.marketAddress });
                    continue;
                }

                try {
                    let cumulativePrice: BigNumber = ethers.BigNumber.from(0);
                    let marketCount = 0;

                    const tokenAReserves = await market.getReservesByToken(market.tokens[0]);
                    const tokenBReserves = await market.getReservesByToken(market.tokens[1]);
                    if (Array.isArray(tokenAReserves) || Array.isArray(tokenBReserves)) {
                        throw new Error('Unexpected array of reserves');
                    }

                    const reserves = {
                        tokenA: tokenAReserves,
                        tokenB: tokenBReserves
                    };

                    let price: BigNumber = ethers.BigNumber.from(0);
                    if (market.tokens[0] === tokenAddress) {
                        price = reserves.tokenB.div(reserves.tokenA); // TypeScript should now know that price is a BigNumber
                    } else if (market.tokens[1] === tokenAddress) {
                        price = reserves.tokenA.div(reserves.tokenB); // TypeScript should now know that price is a BigNumber
                    }

                    cumulativePrice = cumulativePrice.add(price);
                    marketCount++;

                    referencePrices.push({
                        marketAddress: market.marketAddress,
                        cumulativePrice: Number(ethers.utils.formatUnits(cumulativePrice, 'ether')),
                        marketCount
                    });
                } catch (error) {
                    logError(`Error processing market`, {
                        marketAddress: market.marketAddress,
                        error: error as Error
                    });
                    continue;
                }
            }
        }

        logInfo(`Reference price generation completed`, { count: referencePrices.length });
        return referencePrices;
    }

    private async executeArbitrageTrade(
        market: CrossedMarketDetails,
        blockNumber: number
    ): Promise<TransactionResponse | null> {
        // Prepare the trade calls
        const buyCalls = await market.buyFromMarket.sellTokensToNextMarket(
            WETH_ADDRESS,
            market.volume,
            market.sellToMarket
        );

        // Calculate intermediate amounts
        const intermediateAmount = await market.buyFromMarket.getTokensOut(
            WETH_ADDRESS,
            market.tokenAddress,
            market.volume
        );

        // Prepare sell call
        const sellCallData = await market.sellToMarket.sellTokens(
            market.tokenAddress,
            intermediateAmount,
            this.bundleExecutorContract.address
        );

        // Combine all calls
        const targets = [...buyCalls.targets, market.sellToMarket.marketAddress];
        const payloads = [...buyCalls.data, sellCallData];

        // Calculate miner reward (90% of profit)
        const minerReward = market.profit.mul(90).div(100);

        // Create and simulate bundle
        const bundle = await this.createBundle(
            market.volume,
            minerReward,
            targets,
            payloads,
            blockNumber
        );

        // Execute if simulation successful
        return this.executeBundleWithRetry(bundle, blockNumber);
    }

    private async createBundle(
        volume: BigNumber,
        minerReward: BigNumber,
        targets: string[],
        payloads: string[],
        blockNumber: number
    ): Promise<BundleEntry[]> {
        // Estimate gas
        const gasEstimate = await this.estimateGasWithBuffer(
            volume,
            minerReward,
            targets,
            payloads
        );

        // Get optimal gas price
        const gasPrice = await this.getOptimalGasPrice(blockNumber);

        // Create transaction
        const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(
            volume,
            minerReward,
            targets,
            payloads,
            { gasLimit: gasEstimate, gasPrice }
        );

        // Sign transaction
        const signedTx = await this.wallet.signTransaction(transaction);

        // Create bundle entry
        const bundleEntry = await this.createBundleEntry(signedTx);

        return [bundleEntry];
    }

    private async estimateGasWithBuffer(
        volume: BigNumber,
        minerReward: BigNumber,
        targets: string[],
        payloads: string[]
    ): Promise<BigNumber> {
        const estimate = await this.bundleExecutorContract.estimateGas.uniswapWeth(
            volume,
            minerReward,
            targets,
            payloads
        );
        return estimate.mul(120).div(100); // Add 20% buffer
    }

    private async getOptimalGasPrice(blockNumber: number): Promise<BigNumber> {
        const { currentGasPrice, avgGasPrice } = await this.getGasPriceInfo();
        const basePrice = currentGasPrice.gt(avgGasPrice) ? currentGasPrice : avgGasPrice;
        return basePrice.mul(110).div(100); // Add 10% to be competitive
    }

    private async executeBundleWithRetry(
        bundle: BundleEntry[],
        blockNumber: number
    ): Promise<TransactionResponse | null> {
        for (let i = 0; i < this.MAX_RETRIES; i++) {
            try {
                // Simulation first
                await this.simulateBundle(bundle, blockNumber);

                // If simulation successful, submit
                const response = await this.flashbotsProvider.sendBundle(
                    bundle.map(entry => ({
                        signedTransaction: entry.signedTransaction,
                        signer: this.wallet,
                        transaction: {
                            to: entry.to,
                            gasLimit: entry.gas,
                            gasPrice: entry.gas_price,
                            value: entry.value,
                            data: entry.input
                        }
                    })),
                    blockNumber + 1
                );

                if ('error' in response) {
                    throw new Error(response.error.message);
                }

                return response as unknown as TransactionResponse;
            } catch (error) {
                logError(`Bundle execution attempt failed`, {
                    attempt: i + 1,
                    retries: this.MAX_RETRIES,
                    error: error instanceof Error ? error : new Error(String(error)),
                    blockNumber
                });
                if (i === this.MAX_RETRIES - 1) throw error;
                await new Promise(r => setTimeout(r, this.RETRY_DELAY));
            }
        }
        return null;
    }

    private async createBundleEntry(signedTx: string): Promise<BundleEntry> {
        const tx = await this.wallet.provider.getTransaction(signedTx);
        if (!tx?.to || !tx?.gasPrice || !tx?.value) {
            throw new Error("Invalid transaction");
        }

        return {
            to: tx.to,
            gas: tx.gasLimit.toNumber(),
            gas_price: tx.gasPrice.toString(),
            value: tx.value.toNumber(),
            input: tx.data,
            from: this.wallet.address,
            signedTransaction: signedTx,
            signer: this.wallet.address
        };
    }

    private async simulateBundle(bundle: BundleEntry[], blockNumber: number): Promise<void> {
        const stringBundle = bundle.map(entry => entry.signedTransaction);
        const simulation = await this.flashbotsProvider.simulate(stringBundle, blockNumber);

        if ('error' in simulation) {
            throw new Error(`Simulation failed: ${simulation.error.message}`);
        }

        // Verify profitability
        const { bundleGasPrice, coinbaseDiff, totalGasUsed } = simulation;
        const cost = bundleGasPrice.mul(totalGasUsed);
        const profit = coinbaseDiff.sub(cost);

        if (profit.lte(this.thresholds.minProfitThreshold)) {
            throw new Error("Bundle not profitable enough");
        }
    }

    async submitBundleWithAdjustedGasPrice(bundle: BundleEntry[], blockNumber: number, blocksApi: any): Promise<void> {
        logInfo(`Submitting bundle with adjusted gas price`, { blockNumber });

        try {
            // Get current gas prices
            const { currentGasPrice, avgGasPrice } = await this.getGasPriceInfo();

            // Monitor competing bundles
            const competingBundlesGasPrices = await this.monitorCompetingBundlesGasPrices(blocksApi);
            let competingBundleGasPrice = BigNumber.from(0);

            // Find highest competing gas price
            for (const price of competingBundlesGasPrices) {
                const currentPrice = BigNumber.from(price);
                if (currentPrice.gt(competingBundleGasPrice)) {
                    competingBundleGasPrice = currentPrice;
                }
            }

            // Calculate adjusted gas price
            const adjustedGasPrice = await this.adjustGasPriceForTransaction(
                currentGasPrice,
                avgGasPrice,
                competingBundleGasPrice
            );

            // Validate adjusted gas price
            if (adjustedGasPrice.lte(currentGasPrice)) {
                throw new Error("Adjusted gas price is not competitive");
            }

            // Validate bundle gas
            const isValidBundleGas = await this.checkBundleGas(adjustedGasPrice);
            if (!isValidBundleGas) {
                throw new Error("Invalid bundle gas");
            }

            // Set submission window
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const maxTimestamp = currentTimestamp + 60; // 1 minute window

            // Submit bundle
            const targetBlockNumber = blockNumber + 1;
            const bundleSubmission = await this.flashbotsProvider.sendBundle(
                bundle.map(entry => ({
                    signedTransaction: entry.signedTransaction,
                    signer: this.wallet,
                    transaction: {
                        to: entry.to,
                        gasLimit: entry.gas,
                        gasPrice: entry.gas_price,
                        value: entry.value,
                        data: entry.input
                    }
                })),
                targetBlockNumber,
                {
                    minTimestamp: currentTimestamp,
                    maxTimestamp: maxTimestamp
                }
            );

            // Check submission result
            if ('error' in bundleSubmission) {
                throw new Error(`Bundle submission failed: ${bundleSubmission.error.message}`);
            }

            logInfo("Bundle submitted successfully", {
                blockNumber: targetBlockNumber,
                adjustedGasPrice: adjustedGasPrice.toString(),
                bundleHash: bundleSubmission.bundleHash
            });

        } catch (error) {
            logError("Failed to submit bundle with adjusted gas price", {
                error: error as Error,
                blockNumber
            });
            throw error;
        }
    }

    private async adjustGasPriceForTransaction(
        currentGasPrice: BigNumber,
        avgGasPrice: BigNumber,
        competingBundleGasPrice: BigNumber
    ): Promise<BigNumber> {
        logInfo("Calculating adjusted gas price", {
            current: currentGasPrice.toString(),
            average: avgGasPrice.toString(),
            competing: competingBundleGasPrice.toString()
        });

        // Find highest gas price
        let adjustedGasPrice = currentGasPrice;
        if (avgGasPrice.gt(adjustedGasPrice)) {
            adjustedGasPrice = avgGasPrice;
        }
        if (competingBundleGasPrice.gt(adjustedGasPrice)) {
            adjustedGasPrice = competingBundleGasPrice;
        }

        // Add premium to ensure priority (10% increase)
        const premium = adjustedGasPrice.mul(10).div(100);
        adjustedGasPrice = adjustedGasPrice.add(premium);

        logInfo("Gas price adjustment completed", { 
            adjustedGasPrice: adjustedGasPrice.toString() 
        });
        return adjustedGasPrice;
    }

    // Modified to accept BigNumber for profit
    private async calculateOptimalVolume(
        buyFromMarket: MarketType,
        sellToMarket: MarketType,
        tokenAddress: string,
        profit: BigNumber
    ): Promise<BigNumber> {
        logInfo("Starting optimal volume calculation");

        // Determine the available liquidity in both markets
        const availableLiquidityBuy = await buyFromMarket.getReservesByToken(tokenAddress);
        const availableLiquiditySell = await sellToMarket.getReservesByToken(tokenAddress);

        if (Array.isArray(availableLiquidityBuy) || Array.isArray(availableLiquiditySell)) {
            throw new Error('Unexpected array of reserves');
        }

        // Set a maximum trade size limit to manage risk
        const maxTradeSize = BigNumber.from(100000); // Adjust as needed

        // Calculate price impacts and trading fees
        const priceImpactBuy = await buyFromMarket.getPriceImpact(tokenAddress, maxTradeSize);
        const priceImpactSell = await sellToMarket.getPriceImpact(tokenAddress, maxTradeSize);

        const tradingFeeBuy = await buyFromMarket.getTradingFee();
        const tradingFeeSell = await sellToMarket.getTradingFee();

        // Binary Search Initialization
        let left = BigNumber.from(1);
        let right = maxTradeSize;
        let optimalVolume = BigNumber.from(0);
        let maxExpectedProfit = BigNumber.from(0);

        while (left.lt(right)) {
            const mid = left.add(right).div(2);

            // Calculate expected profit at mid
            const expectedProfit = profit
                .mul(mid)
                .sub(priceImpactBuy.mul(mid))
                .sub(priceImpactSell.mul(mid))
                .sub(tradingFeeBuy.mul(mid))
                .sub(tradingFeeSell.mul(mid));

            if (expectedProfit.gt(maxExpectedProfit) && expectedProfit.gte(this.thresholds.minProfitThreshold)) {
                maxExpectedProfit = expectedProfit;
                optimalVolume = mid;
                left = mid.add(1);
            } else {
                right = mid.sub(1);
            }
        }

        // Ensure that the optimal volume does not exceed available liquidity
        optimalVolume = BigNumber.from(Math.min(
            optimalVolume.toNumber(),
            availableLiquidityBuy.toNumber(),
            availableLiquiditySell.toNumber()
        ));

        logInfo(`Optimal volume calculation completed`, { 
            optimalVolume: optimalVolume.toString(),
            tokenAddress
        });
        return optimalVolume;
    }

    public async fetchWETHBalance(address: string, retries = 5, delayMs = 500): Promise<BigNumber | null> {
        const ABI = [
            "function balanceOf(address owner) view returns (uint256)"
        ];
        const contract = new ethers.Contract(this.WETH_ADDRESS, ABI, this.wallet.provider);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const balance: BigNumber = await contract.balanceOf(address);
                return balance;
            } catch (error: any) {
                logError(`Failed to fetch WETH balance`, {
                    attempt,
                    address,
                    error: error as Error
                });
                if (attempt < retries) {
                    await new Promise(res => setTimeout(res, delayMs * attempt));
                } else {
                    logError(`All attempts failed to fetch WETH balance`, {
                        retries,
                        address
                    });
                    return null;
                }
            }
        }
        return null;
    }

    public async getGasPriceInfo(): Promise<{
        currentGasPrice: BigNumber,
        avgGasPrice: BigNumber
    }> {
        const feeData = await this.wallet.provider.getFeeData();
        const currentGasPrice = feeData.gasPrice || BigNumber.from(0);

        // Get average from last few blocks
        const block = await this.wallet.provider.getBlock("latest");
        const prices: BigNumber[] = [];
        for (let i = 0; i < 5; i++) {
            const historicalBlock = await this.wallet.provider.getBlock(block.number - i);
            if (historicalBlock.baseFeePerGas) {
                prices.push(historicalBlock.baseFeePerGas);
            }
        }

        const avgGasPrice = prices.length > 0
            ? prices.reduce((a, b) => a.add(b)).div(prices.length)
            : currentGasPrice;

        return { currentGasPrice, avgGasPrice };
    }
    //Added from second script
    generateObjectiveFunction(marketsByToken: MarketsByToken): (price: number) => number {
        return (price: number) => {
            let adjustment = 0;
            // Assuming marketsByToken is an object where each value is an array of markets
            for (const token in marketsByToken) {
                for (const market of marketsByToken[token]) {
                    // Assuming each market has a 'buyPrice' and 'sellPrice' properties
                    let buyPrice: number = (market as any).buyPrice; // Assuming buyPrice exists; adjust as necessary
                    let sellPrice: number = (market as any).sellPrice; // Assuming sellPrice exists; adjust as necessary

                    // Compute the difference between sell price and buy price
                    let difference = sellPrice - buyPrice;
                    adjustment += difference;
                }
            }
            return -price + adjustment;
        };
    }
    async generatePenaltyVector(marketsByToken: MarketsByToken): Promise<number[]> {
        let penaltyVector: Promise<number>[] = [];
        for (const tokenAddress in marketsByToken) {
          const markets = marketsByToken[tokenAddress];
          penaltyVector = penaltyVector.concat(markets.map((market) => market.getTradingFee().then(fee => fee.toNumber())));
        }
        return Promise.all(penaltyVector);
    }

}

// Helper functions
async function checkBundleGas(bundleGas: BigNumber): Promise<boolean> {
    const isValid = bundleGas.gte(42000);
    logDebug('Bundle gas check', {
        bundleGas: bundleGas.toString(),
        isValid
    });
    return isValid;
}

export async function monitorCompetingBundlesGasPrices(blocksApi: { getRecentBlocks: () => any; }): Promise<Array<BigNumber>> {
    logInfo("Starting competing bundles gas price monitoring");
    const recentBlocks = await blocksApi.getRecentBlocks();
    const competingBundlesGasPrices = recentBlocks.map((block: { bundleGasPrice: any; }) => block.bundleGasPrice);
    logDebug('Competing bundles gas prices', {
        gasPrices: competingBundlesGasPrices.map((price: BigNumber) => price.toString())
    });
    return competingBundlesGasPrices;
}