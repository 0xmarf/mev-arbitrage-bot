import { BigNumber } from 'ethers';

export interface MarketThresholds {
    MIN_LIQUIDITY_ETH: BigNumber;
    MIN_VOLUME_24H: BigNumber;
    MIN_MARKET_CAP: BigNumber;
    MAX_PAIRS: number;
    minProfitThreshold: BigNumber;
}

export const DEFAULT_THRESHOLDS: MarketThresholds = {
    // Set minimum liquidity to 2 ETH for more opportunities
    MIN_LIQUIDITY_ETH: BigNumber.from('2000000000000000000'),
    // Set minimum 24h volume to 0.5 ETH
    MIN_VOLUME_24H: BigNumber.from('500000000000000000'),
    // Set minimum market cap to 25 ETH as requested
    MIN_MARKET_CAP: BigNumber.from('25000000000000000000'),
    // Set to a very high number to effectively remove the limit
    MAX_PAIRS: 1000000,
    minProfitThreshold: BigNumber.from('100000000000000000') // 0.1 ETH minimum profit
};