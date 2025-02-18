import { BigNumber } from "ethers";
import { EthMarket } from "../../src/EthMarket";

export class MockMarket implements EthMarket {
    marketAddress: string;
    tokenAddress: string;
    tokens: string[];
    protocol: string;

    constructor(address: string, tokens: string[]) {
        this.marketAddress = address;
        this.tokenAddress = tokens[0];
        this.tokens = tokens;
        this.protocol = "MockProtocol";
    }

    async getVolatility(): Promise<BigNumber> {
        return BigNumber.from(0);
    }

    async getLiquidity(): Promise<BigNumber> {
        return BigNumber.from(0);
    }

    async getReserves(): Promise<BigNumber> {
        return BigNumber.from('1000000000000000000');
    }

    async getPriceImpact(): Promise<BigNumber> {
        return BigNumber.from('10000000000000000');
    }

    async getTradingFee(): Promise<BigNumber> {
        return BigNumber.from('3000000000000000');
    }

    async sellTokens(): Promise<string> {
        return '0x';
    }

    async sellTokensToNextMarket(): Promise<{ targets: string[], data: string[] }> {
        return { targets: [], data: [] };
    }

    async getTokensOut(): Promise<BigNumber> {
        return BigNumber.from(0);
    }

    async getBalance(): Promise<BigNumber> {
        return BigNumber.from(0);
    }

    receiveDirectly(): boolean {
        return false;
    }
} 