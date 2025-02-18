// types.ts

import { BigNumber } from '@ethersproject/bignumber';
import { EthMarket } from './EthMarket';

export interface MarketType {
    marketAddress: string;
    tokenAddress: string;
    protocol: string;
    tokens: string[];
    getReserves(tokenAddress?: string): Promise<BigNumber>;
    getPriceImpact(tokenAddress: string, tradeSize: BigNumber): Promise<BigNumber>;
    getTradingFee(): Promise<BigNumber>;
    getBalance(tokenAddress: string): Promise<BigNumber>;
    sellTokensToNextMarket(tokenIn: string, amountIn: BigNumber, sellToMarket: MarketType | EthMarket): Promise<BuyCalls>;
    getTokensOut(tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<BigNumber>;
    sellTokens(tokenIn: string, amountIn: BigNumber, recipient: string): Promise<string>;
    receiveDirectly(tokenAddress: string): boolean;
    getVolatility(): Promise<BigNumber>;
    getLiquidity(): Promise<BigNumber>;
}

export interface MarketPair {
    market: EthMarket;
    tokens: string[];
}

export interface CrossedMarketDetails {
    buyFromMarket: EthMarket;
    sellToMarket: EthMarket;
    volume: BigNumber;
    profit: BigNumber;
    marketPairs: MarketPair[];
    tokenAddress: string;
}

export interface MarketsByToken {
    [tokenAddress: string]: EthMarket[];
}

export interface BuyCalls {
    targets: string[];
    data: string[];
    payloads: string[];
    values: BigNumber[];
}

export type { EthMarket } from './EthMarket';
  
