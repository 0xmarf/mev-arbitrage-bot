import { BigNumber, Contract, Wallet, providers, ethers } from "ethers";
import { EventEmitter } from "events";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { IPendingTransaction } from "@flashbots/matchmaker-ts";
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";
import { MarketsByToken, CrossedMarketDetails } from './types';
import { MarketThresholds } from './config/thresholds';
import { MevShareService } from "./services/MevShareService";
import { UNISWAP_PAIR_ABI } from "./abi";

// Use test logger in test environment
const logger = process.env.NODE_ENV === 'test'
  ? require('../test/mevshare/TestLogger').default
  : require('./utils/logger').default;

// Define the shape of MEV-Share transaction hints
interface TransactionHints {
  function_selector?: string;
  calldata?: string;
  logs?: string[];
  hash?: string;
}

// Extend IPendingTransaction with hints and required properties
interface EnhancedPendingTransaction extends IPendingTransaction {
  hints?: TransactionHints;
  signedTransaction: string;  // The signed transaction data
  hash: string;              // Transaction hash
  blockNumber: number;       // Target block number
}

export class MevShareArbitrage extends EventEmitter {
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;
  private mevShareService: MevShareService;
  private thresholds: MarketThresholds;
  private marketsByToken: MarketsByToken = {};

  constructor(
    executorWallet: Wallet,
    bundleExecutorContract: Contract,
    mevShareService: MevShareService,
    thresholds: MarketThresholds
  ) {
    super();
    this.executorWallet = executorWallet;
    this.bundleExecutorContract = bundleExecutorContract;
    this.mevShareService = mevShareService;
    this.thresholds = thresholds;

    // Subscribe to MEV-Share events
    this.mevShareService.on('pendingTransaction', this.handlePendingTransaction.bind(this));
  }

  public setMarkets(marketsByToken: MarketsByToken) {
    this.marketsByToken = marketsByToken;
  }

  private async handlePendingTransaction(tx: EnhancedPendingTransaction) {
    try {
        // Validate required fields
        if (!tx.signedTransaction || !tx.hash || !tx.blockNumber) {
            logger.warn('Incomplete transaction data received', {
                hash: tx.hash,
                hasSignedTx: !!tx.signedTransaction,
                hasBlockNumber: !!tx.blockNumber
            });
            return;
        }

        logger.info('Processing pending transaction', {
            hash: tx.hash,
            blockNumber: tx.blockNumber,
            hints: tx.hints
        });

        // Check if this is a DEX trade we can arbitrage
        if (!this.isArbitrageable(tx)) {
            return;
        }

        // Get the target pair address from the transaction
        const targetPair = await this.extractTargetPair(tx);
        if (!targetPair) {
            logger.info('Could not extract target pair from transaction');
            return;
        }

        // Find arbitrage opportunities based on the target pair
        const opportunities = await this.findArbitrageOpportunities(targetPair, tx);
        if (opportunities.length === 0) {
            logger.info('No profitable arbitrage opportunities found');
            return;
        }

        // Emit the arbitrage opportunity event
        this.emit('arbitrageOpportunity', {
            profitAmount: opportunities[0].profit,
            markets: opportunities[0].marketPairs,
            tokenAddress: opportunities[0].tokenAddress
        });

        // Execute the most profitable opportunity
        await this.executeArbitrage(opportunities[0], tx);

    } catch (error) {
        logger.error('Error handling pending transaction', { error: error as Error });
    }
  }

  private isArbitrageable(tx: EnhancedPendingTransaction): boolean {
    // Check if we have function selector hint
    if (!tx.hints?.function_selector) {
      return false;
    }

    // Check if it's a swap function
    const SWAP_SELECTORS = [
      '0x38ed1739', // swapExactTokensForTokens
      '0x7ff36ab5', // swapExactETHForTokens
      '0x18cbafe5', // swapExactTokensForETH
      '0x8803dbee'  // swapTokensForExactTokens
    ];

    return SWAP_SELECTORS.includes(tx.hints.function_selector);
  }

  private async extractTargetPair(tx: EnhancedPendingTransaction): Promise<string | null> {
    if (!tx.hints?.calldata) {
      return null;
    }

    try {
      // Decode the calldata based on the function selector
      const iface = new ethers.utils.Interface([
        'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)',
        'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)',
        'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)',
        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)'
      ]);

      const decodedData = iface.parseTransaction({ data: tx.hints.calldata });
      const path = decodedData.args.path as string[];
      
      // The pair address will be derived from the first two tokens in the path
      const token0 = path[0];
      const token1 = path[1];
      
      // Find the pair address in our markets
      for (const tokenMarkets of Object.values(this.marketsByToken)) {
        for (const market of tokenMarkets) {
          if (market.tokens[0] === token0 && market.tokens[1] === token1) {
            return market.marketAddress;
          }
        }
      }

      return null;
    } catch (error) {
      logger.error(error as Error, 'Error extracting target pair');
      return null;
    }
  }

  private async findArbitrageOpportunities(
    targetPair: string,
    tx: EnhancedPendingTransaction
  ): Promise<CrossedMarketDetails[]> {
    const opportunities: CrossedMarketDetails[] = [];

    // Find all markets that share tokens with the target pair
    const relatedMarkets = await this.findRelatedMarkets(targetPair);
    if (relatedMarkets.length === 0) {
      return opportunities;
    }

    // For each related market, calculate potential profit
    for (const market of relatedMarkets) {
      try {
        const profit = await this.calculatePotentialProfit(targetPair, market.marketAddress);
        if (profit.gt(0)) {
          opportunities.push({
            profit,
            volume: profit, // This is an estimate, will be refined during execution
            tokenAddress: market.tokens[0],
            buyFromMarket: market,
            sellToMarket: market, // This will be updated during execution
            marketPairs: []
          });
        }
      } catch (error) {
        logger.error(error as Error, 'Error calculating potential profit');
      }
    }

    // Sort by profit
    opportunities.sort((a, b) => b.profit.sub(a.profit).toNumber());
    return opportunities;
  }

  private async findRelatedMarkets(targetPair: string): Promise<EthMarket[]> {
    const relatedMarkets: EthMarket[] = [];
    const targetMarket = await this.findMarketByAddress(targetPair);
    
    if (!targetMarket) {
      return relatedMarkets;
    }

    const [token0, token1] = targetMarket.tokens;
    
    for (const tokenMarkets of Object.values(this.marketsByToken)) {
      for (const market of tokenMarkets) {
        if (market.marketAddress !== targetPair && 
            (market.tokens.includes(token0) || market.tokens.includes(token1))) {
          relatedMarkets.push(market);
        }
      }
    }

    return relatedMarkets;
  }

  private async calculatePotentialProfit(
    targetPair: string,
    relatedPair: string
  ): Promise<BigNumber> {
    try {
      // Get reserves for both pairs
      const targetMarket = await this.findMarketByAddress(targetPair);
      const relatedMarket = await this.findMarketByAddress(relatedPair);

      if (!targetMarket || !relatedMarket) {
        return BigNumber.from(0);
      }

      const targetReserves = await targetMarket.getReserves(targetMarket.tokens[0]);
      const relatedReserves = await relatedMarket.getReserves(relatedMarket.tokens[0]);

      // Simple profit calculation based on reserve ratios
      // This will be refined during actual execution using reserve deltas
      const targetRatio = targetReserves.mul(1000).div(await targetMarket.getReserves(targetMarket.tokens[1]));
      const relatedRatio = relatedReserves.mul(1000).div(await relatedMarket.getReserves(relatedMarket.tokens[1]));

      return relatedRatio.sub(targetRatio);
    } catch (error) {
      logger.error(error as Error, 'Error calculating potential profit');
      return BigNumber.from(0);
    }
  }

  private async findMarketByAddress(address: string): Promise<EthMarket | null> {
    for (const tokenMarkets of Object.values(this.marketsByToken)) {
      for (const market of tokenMarkets) {
        if (market.marketAddress === address) {
          return market;
        }
      }
    }
    return null;
  }

  private async executeArbitrage(
    opportunity: CrossedMarketDetails,
    userTx: EnhancedPendingTransaction
  ) {
    try {
      // Encode the flash swap callback data
      const callbackData = ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [
          userTx.hash,                   // User tx hash for verification
          opportunity.sellToMarket.marketAddress,  // Where to sell the tokens
          opportunity.profit             // Minimum profit expected
        ]
      );

      // Get the pair contract for the source market
      const sourcePair = new ethers.Contract(
        opportunity.buyFromMarket.marketAddress,
        UNISWAP_PAIR_ABI,
        this.executorWallet
      );

      // Create the flash swap transaction
      // amount0Out and amount1Out depend on which token we want to borrow
      const [amount0Out, amount1Out] = opportunity.buyFromMarket.tokens[0] === WETH_ADDRESS 
        ? [opportunity.volume, BigNumber.from(0)]  // Borrowing token0 (WETH)
        : [BigNumber.from(0), opportunity.volume]; // Borrowing token1

      const flashswapTx = await sourcePair.populateTransaction.swap(
        amount0Out,
        amount1Out,
        this.bundleExecutorContract.address, // The callback will be triggered on our executor contract
        callbackData
      );

      // Sign and serialize the backrun transaction
      const signedTx = await this.executorWallet.signTransaction(flashswapTx);

      const bundleParams = {
        transactions: [
          {
            signedTransaction: userTx.signedTransaction,
            hash: userTx.hash
          },
          {
            signedTransaction: signedTx,
            hash: ethers.utils.keccak256(signedTx)
          }
        ],
        targetBlock: userTx.blockNumber + 1
      };

      // Submit the bundle
      const bundleHash = await this.mevShareService.sendBundle(bundleParams);

      logger.info('Arbitrage bundle submitted', {
        bundleHash,
        userTxHash: userTx.hash,
        expectedProfit: opportunity.profit.toString(),
        sourceMarket: opportunity.buyFromMarket.marketAddress,
        targetMarket: opportunity.sellToMarket.marketAddress
      });

    } catch (error) {
      logger.error(error as Error, 'Error executing arbitrage');
    }
  }
} 