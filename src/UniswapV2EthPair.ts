import * as _ from "lodash";
import { BigNumber, Contract, providers, utils } from "ethers";
import { UNISWAP_PAIR_ABI, UNISWAP_QUERY_ABI, UNISWAP_FACTORY_ABI, WETH_ABI} from "./abi.js";
import { FACTORY_ADDRESSES, UNISWAP_LOOKUP_CONTRACT_ADDRESS } from "./addresses.js";
import { CallDetails, MultipleCallData, TokenBalances } from "./EthMarket.js";
import { ETHER } from "./utils.js";
import { MarketType, EthMarket, CrossedMarketDetails, MarketsByToken, BuyCalls } from "./types.js";
import { DEFAULT_THRESHOLDS } from "./config/thresholds.js";
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { flattenArray } from "./utils.js";
import pLimit from 'p-limit';
import { Provider } from '@ethersproject/providers';
import pkg from 'lodash';
import { logInfo, logError, logDebug, logWarn } from './utils/logger.js';
const { groupBy, zipObject, isEqual } = pkg;

dotenv.config();

const CONCURRENT_REQUESTS = 50; // Increased from 5
const DEFAULT_WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
//const factoryAddress = UNISWAP_FACTORY_ADDRESS;

const WETH_ADDRESS = process.env.WETH_ADDRESS || DEFAULT_WETH_ADDRESS;

// batch count limit helpful for testing, loading entire set of uniswap markets takes a long time to load
const BATCH_COUNT_LIMIT = 1000;
const UNISWAP_BATCH_SIZE = 25000; // Increased from 10000
const provider = new ethers.providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);

// Not necessary, slightly speeds up loading initialization when we know tokens are bad
// Estimate gas will ensure we aren't submitting bad bundles, but bad tokens waste time
const blacklistTokens = [
  '0xD75EA151a61d06868E31F8988D28DFE5E9df57B4',
  //'0x06AF07097C9Eeb7fD685c692751D5C66dB49c215'
]

// Add these constants at the top of the file after the existing imports
const BATCH_SIZE = 100; // Reduced from 300 to avoid timeouts
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds
const BATCH_DELAY = 100; // Reduced from 500ms to 100ms
const MAX_TOTAL_PAIRS = 100000; // Increased from 25000

// Add this type definition near the top of the file with other interfaces
interface PairArray extends Array<string> {
    0: string;  // token0
    1: string;  // token1
    2: string;  // pairAddress
}

export interface ImpactAndFeeFuncs {
  getPriceImpact: (tokenAddress: string, tradeSize: BigNumber, reserve: BigNumber) => Promise<BigNumber>;
  getTradingFee: (tokenAddress: string) => Promise<BigNumber>;
}

export interface GroupedMarkets {
  marketsByToken: MarketsByToken;
  allMarketPairs: Array<UniswapV2EthPair>;
  getPriceImpact(tokenAddress: string, tradeSize: BigNumber): Promise<BigNumber>;
  getTradingFee(tokenAddress: string): Promise<BigNumber>;
}

export class UniswapV2EthPair implements MarketType, EthMarket {
  static filteredPairs: any;
  private static limit = pLimit(CONCURRENT_REQUESTS);
  private static BATCH_SIZE = UNISWAP_BATCH_SIZE;
  private _tokenBalances: TokenBalances;
  private _provider: ethers.providers.JsonRpcProvider;
  private _reserves: BigNumber[] = [BigNumber.from(0), BigNumber.from(0)];

  public readonly marketAddress: string;
  public readonly protocol: string;
  public readonly tokens: string[];
  public readonly tokenAddress: string;

  constructor(
    marketAddress: string,
    tokens: string[],
    protocol: string,
    tokenAddress: string,
    provider: Provider
  ) {
    this.marketAddress = marketAddress;
    this.tokens = tokens;
    this.protocol = protocol;
    this.tokenAddress = tokenAddress;
    this._provider = provider as ethers.providers.JsonRpcProvider;
    this._tokenBalances = zipObject(tokens, tokens.map(() => BigNumber.from(0)));
  }

  static async buyFromMarket(buyFromMarket: EthMarket, sellToMarket: EthMarket, tokenAddress: string, profit: number): Promise<CrossedMarketDetails> {
    const volume = BigNumber.from(profit).mul(2); // Simple volume calculation
    return {
      buyFromMarket,
      sellToMarket,
      volume,
      profit: BigNumber.from(profit),
      marketPairs: [{
        market: buyFromMarket,
        tokens: buyFromMarket.tokens
      }],
      tokenAddress
    };
  }

  static async impactAndFeeFuncs(
    provider: providers.StaticJsonRpcProvider,
    factoryAddresses: string[],
    impactAndFeeFuncs: ImpactAndFeeFuncs
  ): Promise<GroupedMarkets> {
    const allMarketPairs: UniswapV2EthPair[] = [];
    const marketsByToken: MarketsByToken = {};

    for (const factoryAddress of factoryAddresses) {
      const pairs = await UniswapV2EthPair.getUniswapMarkets(provider, factoryAddress);
      allMarketPairs.push(...pairs);

      for (const pair of pairs) {
        for (const token of pair.tokens) {
          if (!marketsByToken[token]) {
            marketsByToken[token] = [];
          }
          marketsByToken[token].push(pair);
        }
      }
    }

    return {
      marketsByToken,
      allMarketPairs,
      getPriceImpact: async (tokenAddress: string, tradeSize: BigNumber) => {
        return impactAndFeeFuncs.getPriceImpact(tokenAddress, tradeSize, BigNumber.from(0));
      },
      getTradingFee: async (tokenAddress: string) => {
        return impactAndFeeFuncs.getTradingFee(tokenAddress);
      }
    };
  }

  async getTradingFee(): Promise<BigNumber> {
    return BigNumber.from(3000); // 0.3% fee in basis points
  }

  receiveDirectly(tokenAddress: string): boolean {
    return this.tokens.includes(tokenAddress.toLowerCase());
  }

  static uniswapInterface = new Contract(WETH_ADDRESS, UNISWAP_PAIR_ABI);

  private static async exponentialBackoff(attempt: number): Promise<void> {
    const delay = Math.min(Math.pow(2, attempt) * 1000, 10000); // Cap at 10 seconds
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  async getPriceImpact(tokenAddress: string, amount: BigNumber): Promise<BigNumber> {
    const reserves = await this.getReservesByToken(tokenAddress);
    if (Array.isArray(reserves)) {
      throw new Error('Unexpected array of reserves');
    }
    return amount.mul(1000).div(reserves); // Simple price impact calculation
  }

  async getReserves(tokenAddress?: string): Promise<BigNumber> {
    if (!tokenAddress) {
      return this._reserves[0];
    }
    const tokenIndex = this.tokens.indexOf(tokenAddress);
    if (tokenIndex === -1) {
      throw new Error('Token not found in pair');
    }
    return this._reserves[tokenIndex];
  }

  async getReservesByToken(tokenAddress?: string): Promise<BigNumber | BigNumber[]> {
    if (!tokenAddress) {
      return this._reserves;
    }
    const tokenIndex = this.tokens.indexOf(tokenAddress);
    if (tokenIndex === -1) {
      throw new Error('Token not found in pair');
    }
    return this._reserves[tokenIndex];
  }

  async prepareReceive(tokenAddress: string, amountIn: BigNumber): Promise<Array<CallDetails>> {
    if (this._tokenBalances[tokenAddress] === undefined) {
      throw new Error(`Market does not operate on token ${tokenAddress}`)
    }
    if (! amountIn.gt(0)) {
      throw new Error(`Invalid amount: ${amountIn.toString()}`)
    }
    // No preparation necessary
    return []
  }
  // Example: Advanced error handling and potential gas optimization placeholder

  static async fetchWETHBalance(
    provider: ethers.providers.JsonRpcProvider, 
    marketAddress: string, 
    WETH_ADDRESS: string
  ): Promise<BigNumber> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, provider);
        const balance = await wethContract.balanceOf(marketAddress);
        return BigNumber.from(balance);
      } catch (error: any) {
        if (attempt === 2) {
          console.error(
            `Failed to fetch WETH balance for address ${marketAddress}`, 
            error.message
          );
          return BigNumber.from(0);
        }
        await this.exponentialBackoff(attempt);
      }
    }
    return BigNumber.from(0); // Typescript requires a return here even though it won't be reached
  }

  static async getUniswapMarkets(provider: providers.JsonRpcProvider, factoryAddress: string): Promise<Array<UniswapV2EthPair>> {
    const uniswapQuery = new Contract(UNISWAP_LOOKUP_CONTRACT_ADDRESS, UNISWAP_QUERY_ABI, provider);
    
    logInfo(`Starting market analysis`, { factoryAddress });
    const allPairsLength = await new Contract(factoryAddress, UNISWAP_FACTORY_ABI, provider).allPairsLength();
    const totalBatches = Math.ceil(allPairsLength.toNumber() / UNISWAP_BATCH_SIZE);
    logInfo(`Found pairs in factory`, { 
        factoryAddress,
        totalPairs: allPairsLength.toString()
    });
    logInfo(`Processing configuration`, {
        batchSize: UNISWAP_BATCH_SIZE,
        concurrentRequests: CONCURRENT_REQUESTS
    });

    const marketPairs: UniswapV2EthPair[] = [];
    let totalPairsProcessed = 0;
    let skippedByLiquidity = 0;
    let skippedByWeth = 0;
    let skippedByImpact = 0;
    let skippedByError = 0;

    for (let batch = 0; batch < Math.min(totalBatches, BATCH_COUNT_LIMIT) && totalPairsProcessed < MAX_TOTAL_PAIRS; batch++) {
        const startIndex = batch * UNISWAP_BATCH_SIZE;
        const endIndex = Math.min(startIndex + UNISWAP_BATCH_SIZE, allPairsLength.toNumber());

        // Add delay between batches
        if (batch > 0) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }

        try {
            const batchPairs = await uniswapQuery.functions.getPairsByIndexRange(factoryAddress, startIndex, endIndex);
            
            if (!Array.isArray(batchPairs) || !batchPairs[0]) {
                logWarn('Invalid batch pairs result', { batch, startIndex, endIndex });
                continue;
            }

            const processedPairs = await Promise.all(
                batchPairs[0].map(async (pairArray: PairArray) => {
                    if (!Array.isArray(pairArray) || pairArray.length !== 3) {
                        logWarn('Invalid pair array format', { pairArray });
                        return null;
                    }

                    const [token0, token1, pairAddress] = pairArray;
                    
                    return this.limit(async () => {
                        try {
                            // Basic validation
                            if (!ethers.utils.isAddress(token0) || !ethers.utils.isAddress(token1)) {
                                skippedByError++;
                                logDebug('Invalid token addresses', { token0, token1, pairAddress });
                                return null;
                            }

                            if (blacklistTokens.includes(token0) || blacklistTokens.includes(token1)) {
                                skippedByError++;
                                logDebug('Blacklisted token', { token0, token1, pairAddress });
                                return null;
                            }

                            // Check liquidity with retries
                            let reserves: any;
                            for (let retry = 0; retry < MAX_RETRIES; retry++) {
                                try {
                                    const pairContract = new Contract(pairAddress, UNISWAP_PAIR_ABI, provider);
                                    reserves = await pairContract.getReserves();
                                    break;
                                } catch (error: any) {
                                    if (retry === MAX_RETRIES - 1) {
                                        skippedByError++;
                                        logError('Failed to get reserves after max retries', {
                                            error: error instanceof Error ? error : new Error(error?.message || String(error)),
                                            pairAddress,
                                            retry
                                        });
                                        return null;
                                    }
                                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                                }
                            }

                            const totalLiquidity = reserves[0].add(reserves[1]);
                            if (totalLiquidity.lt(DEFAULT_THRESHOLDS.MIN_LIQUIDITY_ETH)) {
                                skippedByLiquidity++;
                                logDebug('Insufficient liquidity', { 
                                    pairAddress, 
                                    totalLiquidity: totalLiquidity.toString(),
                                    minRequired: DEFAULT_THRESHOLDS.MIN_LIQUIDITY_ETH.toString()
                                });
                                return null;
                            }

                            // Check WETH balance
                            const wethBalance = await this.fetchWETHBalance(provider, pairAddress, WETH_ADDRESS);
                            if (!wethBalance || wethBalance.lt(DEFAULT_THRESHOLDS.MIN_LIQUIDITY_ETH)) {
                                skippedByWeth++;
                                logDebug('Insufficient WETH balance', { 
                                    pairAddress, 
                                    wethBalance: wethBalance?.toString(),
                                    minRequired: DEFAULT_THRESHOLDS.MIN_LIQUIDITY_ETH.toString()
                                });
                                return null;
                            }

                            // Price impact check
                            const oneEth = ethers.utils.parseEther("1");
                            const priceImpact = oneEth.mul(10000).div(
                                token0.toLowerCase() === WETH_ADDRESS.toLowerCase() ? 
                                reserves[0].add(oneEth) : reserves[1].add(oneEth)
                            );

                            if (priceImpact.gt(100)) { // > 1%
                                skippedByImpact++;
                                logDebug('Price impact too high', { 
                                    pairAddress, 
                                    priceImpact: priceImpact.toString()
                                });
                                return null;
                            }

                            return new UniswapV2EthPair(pairAddress, [token0, token1], 'UniswapV2', token0, provider);
                        } catch (error: any) {
                            skippedByError++;
                            logError('Error processing pair', {
                                error: error instanceof Error ? error : new Error(error?.message || String(error)),
                                pairAddress,
                                token0,
                                token1
                            });
                            return null;
                        }
                    });
                })
            );

            const validPairs = processedPairs.filter(pair => pair !== null);
            marketPairs.push(...validPairs);
            
            totalPairsProcessed += batchPairs[0].length;
            logInfo('Processing status', {
                factoryAddress,
                processed: totalPairsProcessed,
                total: allPairsLength.toString(),
                validPairs: marketPairs.length,
                skippedByLiquidity,
                skippedByWeth,
                skippedByImpact,
                skippedByError
            });
        } catch (error: any) {
            logError('Batch processing error', {
                error: error instanceof Error ? error : new Error(error?.message || String(error)),
                batch,
                startIndex,
                endIndex
            });
        }
    }

    logInfo('Final processing results', {
        factoryAddress,
        totalProcessed: totalPairsProcessed,
        validPairsFound: marketPairs.length,
        totalSkipped: skippedByLiquidity + skippedByWeth + skippedByImpact + skippedByError,
        skippedByLiquidity,
        skippedByWeth,
        skippedByImpact,
        skippedByError
    });
    
    return marketPairs;
}

static async getUniswapMarketsByToken(
    provider: providers.JsonRpcProvider,
    factoryAddresses: string[],
    impactAndFeeFuncs: any,
    progressCallback?: (progress: number) => void
): Promise<{
    marketsByToken: { [token: string]: UniswapV2EthPair[] };
    allMarketPairs: UniswapV2EthPair[];
    getPriceImpact: (tokenAddress: string, tradeSize: BigNumber) => Promise<BigNumber>;
    getTradingFee: (tokenAddress: string) => Promise<BigNumber>;
}> {
    try {
        // Fetch all pairs from factory addresses with filtering already applied
        logInfo('Starting to fetch pairs from factories', {
            factoryCount: factoryAddresses.length
        });
        
        const allPairs = await Promise.all(
            factoryAddresses.map(factoryAddress => UniswapV2EthPair.getUniswapMarkets(provider, factoryAddress))
        );
        const allPairsFlat = flattenArray(allPairs);

        // Update reserves for filtered pairs
        logInfo('Starting reserve updates for pre-filtered pairs', {
            pairCount: allPairsFlat.length
        });
        
        await UniswapV2EthPair.updateReserves(provider, allPairsFlat, WETH_ADDRESS);

        // Group markets by token (no additional filtering needed since getUniswapMarkets already filtered)
        const marketsByToken = groupBy(allPairsFlat, pair => 
            pair.tokens[0].toLowerCase() === WETH_ADDRESS.toLowerCase() ? pair.tokens[1] : pair.tokens[0]
        ) as { [token: string]: UniswapV2EthPair[] };

        // Limit pairs per token if needed
        Object.keys(marketsByToken).forEach(token => {
            if (marketsByToken[token].length > DEFAULT_THRESHOLDS.MAX_PAIRS) {
                marketsByToken[token] = marketsByToken[token].slice(0, DEFAULT_THRESHOLDS.MAX_PAIRS);
            }
        });

        // Log final counts
        const totalPairs = flattenArray(Object.values(marketsByToken)).length;
        const totalTokens = Object.keys(marketsByToken).length;
        logInfo('Market grouping completed', {
            totalPairs,
            totalTokens,
            averagePairsPerToken: Number((totalPairs / totalTokens).toFixed(2))
        });

        // Return structured market data along with impact and fee calculation methods
        return {
            marketsByToken,
            allMarketPairs: allPairsFlat,
            getPriceImpact: async (tokenAddress: string, tradeSize: BigNumber) => {
                const pair = allPairsFlat.find(pair => pair.tokens.includes(tokenAddress));
                if (!pair) {
                    throw new Error(`No pair found for token ${tokenAddress}`);
                }
                const reserve = await pair.getReserves(tokenAddress);
                return impactAndFeeFuncs.getPriceImpact(tokenAddress, tradeSize, reserve);
            },
            getTradingFee: impactAndFeeFuncs.getTradingFee,
        };
    } catch (error) {
        logError('Error in getUniswapMarketsByToken', {
            error: error as Error
        });
        throw error;
    }
}
static async updateReserves(provider: ethers.providers.JsonRpcProvider, pairsInArbitrage: UniswapV2EthPair[], WETH_ADDRESS: string) {
    logInfo(`Updating reserves`, { pairCount: pairsInArbitrage.length });
    let filteredPairsInArbitrage = [];
    
    // Increase batch size to match provider's capability
    const BATCH_SIZE = 300; // Match provider's MAX_CONCURRENT
    
    // Process in optimized batches
    for (let i = 0; i < pairsInArbitrage.length; i += BATCH_SIZE) {
        const batchPairs = pairsInArbitrage.slice(i, i + BATCH_SIZE);
        
        // Remove delay between batches since provider handles rate limiting
        const promises = batchPairs.map(marketPair => 
            this.limit(async () => {
                try {
                    const pairContract = new ethers.Contract(
                        marketPair.marketAddress, 
                        UNISWAP_PAIR_ABI, 
                        provider
                    );
                    
                    // Retry logic with exponential backoff
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const [reserve0, reserve1] = await pairContract.getReserves();
                            const totalReserves = reserve0.add(reserve1);
                            const totalReservesInEth = ethers.utils.formatEther(totalReserves);

                            if (parseFloat(totalReservesInEth) < 3) {
                                return null;
                            }
                            
                            const wethBalance = await this.limit(async () => 
                                this.fetchWETHBalance(provider, marketPair.marketAddress, WETH_ADDRESS)
                            );
                            
                            if (!wethBalance.isZero()) {
                                await marketPair.setReservesViaOrderedBalances([wethBalance]);
                                return marketPair;
                            }
                            return null;
                        } catch (error) {
                            if (attempt === 2) throw error;
                            await this.exponentialBackoff(attempt);
                        }
                    }
                } catch (error) {
                    logError('Failed to update reserves for pair', {
                        marketAddress: marketPair.marketAddress,
                        error: error as Error
                    });
                    return null;
                }
            })
        );

        try {
            const results = await Promise.all(promises);
            const validResults = results.filter(pair => pair !== null);
            filteredPairsInArbitrage.push(...validResults);
        } catch (error) {
            logError('Batch processing error', { error: error as Error });
        }
    }

    logInfo(`Reserve update completed`, { 
        updatedPairCount: filteredPairsInArbitrage.length 
    });
    return filteredPairsInArbitrage;
}
// In UniswapV2EthPair getBalance method:

async getBalance(tokenAddress: string): Promise<BigNumber> {
  const tokenContract = new Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    this._provider
  );
  try {
    return await tokenContract.balanceOf(this.marketAddress);
  } catch (error) {
    logError(`Failed to get balance`, {
      tokenAddress,
      marketAddress: this.marketAddress,
      error: error as Error
    });
    throw error;
  }
}
  async setReservesViaOrderedBalances(balances: Array<BigNumber>): Promise<void> {
    if (balances.length !== 2) {
      throw new Error("Expected exactly 2 balances");
    }
    this._reserves = [balances[0], balances[1]];
  }
  // Optimizing setReservesViaMatchingArray for clearer balance updating:

  async setReservesViaMatchingArray(tokens: Array<string>, balances: Array<BigNumber>): Promise<void> {
    const tokenBalances = zipObject(tokens, balances);
    if (!isEqual(this._tokenBalances, tokenBalances)) {
      this._tokenBalances = tokenBalances;
    }
  }

  async getTokensOut(tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<BigNumber> {
    const indexIn = this.tokens.indexOf(tokenIn);
    const indexOut = this.tokens.indexOf(tokenOut);
    if (indexIn === -1 || indexOut === -1) {
      throw new Error('Token not found in pair');
    }

    const reserveIn = this._reserves[indexIn];
    const reserveOut = this._reserves[indexOut];

    // Uniswap V2 formula with 0.3% fee
    const amountInWithFee = amountIn.mul(997);
    const numerator = amountInWithFee.mul(reserveOut);
    const denominator = reserveIn.mul(1000).add(amountInWithFee);
    return numerator.div(denominator);
  }

  async getTokensIn(tokenIn: string, tokenOut: string, amountOut: BigNumber): Promise<BigNumber> {
    const indexIn = this.tokens.indexOf(tokenIn);
    const indexOut = this.tokens.indexOf(tokenOut);
    if (indexIn === -1 || indexOut === -1) {
      throw new Error('Token not found in pair');
    }

    const reserveIn = this._reserves[indexIn];
    const reserveOut = this._reserves[indexOut];

    // Uniswap V2 formula with 0.3% fee
    const numerator = reserveIn.mul(amountOut).mul(1000);
    const denominator = reserveOut.sub(amountOut).mul(997);
    return numerator.div(denominator).add(1); // Add 1 to round up
  }

  getAmountIn(reserveIn: BigNumber, reserveOut: BigNumber, amountOut: BigNumber): BigNumber {
    const numerator: BigNumber = reserveIn.mul(amountOut).mul(1000);
    const denominator: BigNumber = reserveOut.sub(amountOut).mul(997);
    return numerator.div(denominator).add(1);
  }

  getAmountOut(reserveIn: BigNumber, reserveOut: BigNumber, amountIn: BigNumber): BigNumber {
    const amountInWithFee: BigNumber = amountIn.mul(997);
    const numerator = amountInWithFee.mul(reserveOut);
    const denominator = reserveIn.mul(1000).add(amountInWithFee);
    return numerator.div(denominator);
  }
  async sellTokensToNextMarket(
    tokenIn: string,
    amountIn: BigNumber,
    sellToMarket: MarketType | EthMarket
  ): Promise<BuyCalls> {
    const contract = new Contract(this.marketAddress, UNISWAP_PAIR_ABI, this._provider);
    const path = [tokenIn, this.tokenAddress];
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

    const data = contract.interface.encodeFunctionData('swapExactTokensForTokens', [
      amountIn,
      0, // Accept any amount of tokens
      path,
      sellToMarket.marketAddress,
      deadline
    ]);

    return {
      targets: [this.marketAddress],
      data: [data],
      payloads: [data],
      values: [BigNumber.from(0)]
    };
  }

  async sellTokens(
    tokenIn: string,
    amountIn: BigNumber,
    recipient: string
  ): Promise<string> {
    const contract = new Contract(this.marketAddress, UNISWAP_PAIR_ABI, this._provider);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

    return contract.interface.encodeFunctionData('swap', [
      0, // amount0Out
      amountIn, // amount1Out
      recipient,
      '0x' // No data needed
    ]);
  }

  async updateReserves(): Promise<void> {
    try {
      const contract = new Contract(this.marketAddress, UNISWAP_PAIR_ABI, this._provider);
      const [reserve0, reserve1] = await contract.getReserves();
      this._reserves = [reserve0, reserve1];
    } catch (error) {
      console.error(`Failed to update reserves for market ${this.marketAddress}:`, error);
      throw error;
    }
  }

  async getVolatility(): Promise<BigNumber> {
    // Simple implementation - could be enhanced with historical data
    return BigNumber.from(0);
  }

  async getLiquidity(): Promise<BigNumber> {
    const reserves = await this.getReserves();
    return reserves.mul(2); // Simple liquidity measure - sum of both reserves
  }
}

