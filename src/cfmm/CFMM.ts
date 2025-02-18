import { BigNumber, Contract, providers } from "ethers";
import { UNISWAP_PAIR_ABI } from "../abi.js";

export interface CFMM {
    reserves: BigNumber[];
    fee: number;
    A: number[][]; // Matrix to map local to global indices
    marketAddress: string;
    tradingFunction: (reserves: BigNumber[]) => BigNumber;
    tradingFunctionGradient: (reserves: BigNumber[]) => BigNumber[];
    arbitrage: (prices: BigNumber[]) => Promise<{ delta: BigNumber[], value: BigNumber }>;
    updateReserves(): Promise<void>;
}

// Example: Uniswap V2 CFMM Implementation
export class UniswapV2CFMM implements CFMM {
    reserves: BigNumber[];
    fee: number;
    A: number[][];
    marketAddress: string;

    constructor(
        marketAddress: string, 
        reserves: BigNumber[], 
        fee: number, 
        A: number[][], 
        private provider: providers.Provider
    ) {
        this.marketAddress = marketAddress;
        this.reserves = reserves;
        this.fee = fee;
        this.A = A;
    }

    async updateReserves() {
        const contract = new Contract(this.marketAddress, UNISWAP_PAIR_ABI, this.provider);
        const reserves = await contract.getReserves();
        this.reserves = [reserves._reserve0, reserves._reserve1];
    }

    tradingFunction(reserves: BigNumber[]): BigNumber {
        // Constant product formula: k = x*y
        return reserves[0].mul(reserves[1]);
    }

    tradingFunctionGradient(reserves: BigNumber[]): BigNumber[] {
        // Gradient of the constant product formula
        return [reserves[1], reserves[0]];
    }

    async arbitrage(prices: BigNumber[]): Promise<{ delta: BigNumber[], value: BigNumber }> {
        // Map global prices to local prices using A
        const localPrices = this.A.map(row => {
            let sum = BigNumber.from(0);
            for (let i = 0; i < row.length; i++) {
                if (row[i] !== 0) {
                    sum = sum.add(BigNumber.from(row[i]).mul(prices[i]));
                }
            }
            return sum;
        });

        const v1 = localPrices[0];
        const v2 = localPrices[1];

        if (v1.isZero() || v2.isZero()) {
            return { delta: [BigNumber.from(0), BigNumber.from(0)], value: BigNumber.from(0) };
        }

        const R1 = this.reserves[0];
        const R2 = this.reserves[1];
        const gamma = 1 - this.fee;
        const eta = 1; // For Uniswap V2, η = 1

        // Calculate optimal delta1 (buying asset 2, selling asset 1)
        let delta1 = R1.mul(v2.mul(R2).div(v1.mul(R1)).pow(1/(eta + 1))).sub(R1).div(gamma);
        let f1delta1 = R2.mul(BigNumber.from(1).sub(delta1.mul(gamma).add(R1).div(R1))).div(BigNumber.from(1));

        // Calculate optimal delta2 (buying asset 1, selling asset 2)
        let delta2_alt = R2.mul(v1.mul(R1).div(v2.mul(R2)).pow(1/(eta + 1))).sub(R2).div(gamma);
        let f2delta2 = R1.mul(BigNumber.from(1).sub(delta2_alt.mul(gamma).add(R2).div(R2))).div(BigNumber.from(1));

        // Determine which trade is more profitable
        let value1 = v2.mul(f1delta1).sub(v1.mul(delta1));
        let value2 = v1.mul(f2delta2).sub(v2.mul(delta2_alt));

        if (value1.gt(value2) && value1.gt(0)) {
            return { delta: [delta1.mul(-1), f1delta1], value: value1 };
        } else if (value2.gt(0)) {
            return { delta: [f2delta2, delta2_alt.mul(-1)], value: value2 };
        } else {
            return { delta: [BigNumber.from(0), BigNumber.from(0)], value: BigNumber.from(0) };
        }
    }
} 