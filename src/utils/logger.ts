import winston from 'winston';
import { BigNumber } from '@ethersproject/bignumber';

// Custom format for BigNumber values
const bigNumberFormat = winston.format((info) => {
    const transformed = { ...info };
    Object.keys(transformed).forEach(key => {
        if (transformed[key] instanceof BigNumber) {
            transformed[key] = transformed[key].toString();
        }
    });
    return transformed;
});

// Create logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        bigNumberFormat(),
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'mev-arbitrage-bot' },
    transports: [
        // Console transport with custom format
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        // File transport for error logs
        new winston.transports.File({
            filename: 'error.log',
            level: 'error'
        }),
        // File transport for all logs
        new winston.transports.File({
            filename: 'combined.log'
        })
    ]
});

// Add request context
export interface LogContext {
    txHash?: string;
    blockNumber?: number;
    marketAddress?: string;
    tokenAddress?: string;
    profit?: BigNumber;
    gasPrice?: BigNumber;
    error?: Error;
    // Additional properties for WebSocket and market monitoring
    url?: string;
    wsUrl?: string;
    rpcUrl?: string;
    pollingInterval?: number;
    searcherAddress?: string;
    totalMarkets?: number;
    minLiquidityETH?: string;
    minVolume24H?: string;
    maxPriceImpact?: string;
    maxPairsPerToken?: number;
    pairCount?: number;
    updatedPairCount?: number;
    attempt?: number;
    maxAttempts?: number;
    // Additional properties for WebSocket events
    message?: any;
    event?: any;
    maxProfit?: string;
    subscriptionTypes?: string[];
    dexAddresses?: string[];
    method?: string;
    id?: number | string;
    params?: any;
    data?: string;
    code?: number;
    reason?: string;
    readyState?: number;
    eventType?: string;
    timestamp?: number;
    result?: any;
    // Additional properties for optimization and calculations
    iteration?: number;
    deltaPlus?: number;
    deltaMinus?: number;
    objectiveFunctionResult?: number;
    penaltyResult?: number;
    finalNu?: number;
    finalPsi?: number;
    // Market analysis properties
    factoryAddress?: string;
    totalPairs?: number;
    batchSize?: number;
    concurrentRequests?: number;
    batch?: number;
    startIndex?: number;
    endIndex?: number;
    pairArray?: any;
    token0?: string;
    token1?: string;
    pairAddress?: string;
    totalLiquidity?: string;
    minRequired?: string;
    wethBalance?: string;
    priceImpact?: string;
    retry?: number;
    processed?: number;
    total?: string;
    validPairs?: number;
    skippedByLiquidity?: number;
    skippedByWeth?: number;
    skippedByImpact?: number;
    skippedByError?: number;
    totalProcessed?: number;
    validPairsFound?: number;
    totalSkipped?: number;
    // Additional properties for market analysis
    thresholds?: {
        minLiquidity: string;
        minVolume: string;
        minMarketCap: string;
        maxPairs: number;
    };
    filteredMarkets?: number;
    count?: number;
    adjustedGasPrice?: string;
    bundleHash?: string;
    current?: string;
    average?: string;
    competing?: string;
    optimalVolume?: string;
    retries?: number;
    duration?: number;
    address?: string;
    marketCount?: number;
    factoryCount?: number;
    totalTokens?: number;
    averagePairsPerToken?: number;
    monitoredPairs?: number;
    updateInterval?: string;
    wsEnabled?: boolean;
    tradingFunctionResult?: string;
    tradingFunctionResult2?: string;
    bundleGas?: string;
    isValid?: boolean;
    gasPrices?: string[];
}

// Wrapper functions for consistent logging
export const logInfo = (message: string, context: LogContext = {}) => {
    logger.info(message, context);
};

export const logError = (message: string, context: LogContext = {}) => {
    logger.error(message, context);
};

export const logWarn = (message: string, context: LogContext = {}) => {
    logger.warn(message, context);
};

export const logDebug = (message: string, context: LogContext = {}) => {
    logger.debug(message, context);
};

// Circuit breaker events
export const logCircuitBreakerTripped = (reason: string, context: LogContext = {}) => {
    logger.error(`Circuit breaker tripped: ${reason}`, {
        ...context,
        event: 'CIRCUIT_BREAKER_TRIPPED'
    });
};

// Arbitrage events
export const logArbitrageOpportunity = (context: LogContext & {
    buyMarket: string;
    sellMarket: string;
    inputAmount: BigNumber;
    expectedOutput: BigNumber;
}) => {
    logger.info('Arbitrage opportunity found', {
        ...context,
        event: 'ARBITRAGE_OPPORTUNITY'
    });
};

export const logArbitrageExecution = (context: LogContext & {
    status: 'success' | 'failure';
    gasUsed?: BigNumber;
    actualProfit?: BigNumber;
}) => {
    logger.info('Arbitrage execution completed', {
        ...context,
        event: 'ARBITRAGE_EXECUTION'
    });
};

// MEV-Share events
export const logMevShareEvent = (event: string, context: LogContext = {}) => {
    logger.info(`MEV-Share event: ${event}`, {
        ...context,
        event: 'MEV_SHARE'
    });
};

export default logger; 