import { BigNumber } from "@ethersproject/bignumber";
import { BuyCalls } from "./types.js";
import { Contract } from '@ethersproject/contracts';
import { Provider } from '@ethersproject/providers';

export interface CallDetails {
    target: string;
    data: string;
    value?: BigNumber;
}

export interface TokenBalances {
    [tokenAddress: string]: BigNumber
}

export interface MultipleCallData {
    targets: Array<string>
    data: Array<string>
}

export interface BaseMarket {
    marketAddress: string;
    tokens: string[];
    protocol: string;
    updateReserves(): Promise<void>;
    getTradingFee(): Promise<BigNumber>;
    getBalance(tokenAddress: string): Promise<BigNumber>;
}

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
    updateReserves(): Promise<void>;
    getReservesByToken(tokenAddress?: string): Promise<BigNumber | BigNumber[]>;
}

export class EthMarket implements MarketType {
    public readonly marketAddress: string;
    public readonly tokenAddress: string;
    public readonly tokens: string[];
    public readonly protocol: string;

    constructor(marketAddress: string, tokens: string[], protocol: string, tokenAddress: string) {
        this.marketAddress = marketAddress;
        this.tokens = tokens;
        this.protocol = protocol;
        this.tokenAddress = tokenAddress;
    }

    async getReserves(tokenAddress?: string): Promise<BigNumber> {
        throw new Error('Method not implemented.');
    }

    async getTradingFee(): Promise<BigNumber> {
        throw new Error('Method not implemented.');
    }

    async updateReserves(): Promise<void> {
        throw new Error('Method not implemented.');
    }

    async getPriceImpact(tokenAddress: string, amount: BigNumber): Promise<BigNumber> {
        throw new Error('Method not implemented.');
    }

    async sellTokensToNextMarket(tokenIn: string, amountIn: BigNumber, sellToMarket: MarketType | EthMarket): Promise<BuyCalls> {
        throw new Error('Method not implemented.');
    }

    async sellTokens(tokenAddress: string, amountIn: BigNumber, recipient: string): Promise<string> {
        throw new Error('Method not implemented.');
    }

    async getTokensOut(tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<BigNumber> {
        throw new Error('Method not implemented.');
    }

    async getBalance(tokenAddress: string): Promise<BigNumber> {
        throw new Error('Method not implemented.');
    }

    receiveDirectly(tokenAddress: string): boolean {
        throw new Error('Method not implemented.');
    }

    async getVolatility(): Promise<BigNumber> {
        throw new Error('Method not implemented.');
    }

    async getLiquidity(): Promise<BigNumber> {
        throw new Error('Method not implemented.');
    }

    async getReservesByToken(tokenAddress?: string): Promise<BigNumber | BigNumber[]> {
        throw new Error('Method not implemented.');
    }
}

export class UniswapV2EthPair extends EthMarket {
    private readonly contract: Contract;
    private readonly provider: Provider;
    private _reserves: BigNumber[];

    constructor(
        marketAddress: string,
        tokens: string[],
        contract: Contract,
        provider: Provider,
        tokenAddress: string
    ) {
        super(marketAddress, tokens, 'UniswapV2', tokenAddress);
        this.contract = contract;
        this.provider = provider;
        this._reserves = [BigNumber.from(0), BigNumber.from(0)];
    }

    public async updateReserves(): Promise<void> {
        const reserves = await this.contract.getReserves();
        this._reserves = [reserves[0], reserves[1]];
    }

    public async getReserves(tokenAddress?: string): Promise<BigNumber> {
        await this.updateReserves();
        if (!tokenAddress) {
            return this._reserves[0];
        }
        const index = this.tokens.indexOf(tokenAddress);
        if (index === -1) throw new Error('Token not found in pair');
        return this._reserves[index];
    }

    public async getVolatility(): Promise<BigNumber> {
        // Simple implementation - could be enhanced with historical data
        return BigNumber.from(0);
    }

    public async getLiquidity(): Promise<BigNumber> {
        await this.updateReserves();
        return this._reserves[0].add(this._reserves[1]);
    }

    public async sellTokensToNextMarket(
        tokenIn: string,
        amountIn: BigNumber,
        sellToMarket: MarketType | EthMarket
    ): Promise<BuyCalls> {
        const path = [tokenIn, this.tokenAddress];
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

        const data = this.contract.interface.encodeFunctionData('swapExactTokensForTokens', [
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

    public async getTradingFee(): Promise<BigNumber> {
        // Uniswap V2 has a fixed 0.3% fee
        return BigNumber.from(30); // 30 basis points = 0.3%
    }

    public async getPriceImpact(
        tokenAddress: string,
        tradeSize: BigNumber
    ): Promise<BigNumber> {
        // Simple implementation
        const index = this.tokens.indexOf(tokenAddress);
        if (index === -1) throw new Error('Token not found in pair');
        const reserve = this._reserves[index];
        return tradeSize.mul(1000).div(reserve); // Return impact in basis points
    }

    public receiveDirectly(tokenAddress: string): boolean {
        return this.tokens.includes(tokenAddress);
    }

    public async getBalance(tokenAddress: string): Promise<BigNumber> {
        const tokenContract = new Contract(
            tokenAddress,
            ['function balanceOf(address) view returns (uint256)'],
            this.provider
        );
        return tokenContract.balanceOf(this.marketAddress);
    }

    public async getTokensOut(
        tokenIn: string,
        tokenOut: string,
        amountIn: BigNumber
    ): Promise<BigNumber> {
        // Simple implementation using constant product formula
        const indexIn = this.tokens.indexOf(tokenIn);
        const indexOut = this.tokens.indexOf(tokenOut);
        if (indexIn === -1 || indexOut === -1) throw new Error('Token not found in pair');

        const reserveIn = this._reserves[indexIn];
        const reserveOut = this._reserves[indexOut];
        const amountInWithFee = amountIn.mul(997); // 0.3% fee
        const numerator = amountInWithFee.mul(reserveOut);
        const denominator = reserveIn.mul(1000).add(amountInWithFee);
        return numerator.div(denominator);
    }

    public async sellTokens(
        tokenIn: string,
        amountIn: BigNumber,
        recipient: string
    ): Promise<string> {
        // Implementation for selling tokens
        return '0x'; // Placeholder
    }

    async getReservesByToken(tokenAddress?: string): Promise<BigNumber | BigNumber[]> {
        throw new Error('Method not implemented.');
    }
}