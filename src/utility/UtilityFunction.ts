import { BigNumber } from "ethers";

export interface UtilityFunction {
    U: (psi: BigNumber[]) => BigNumber;  // U
    U_optimal: (v: BigNumber[]) => { value: BigNumber; gradient: BigNumber[] }; // returns Ū(v) and -Ψ*
}

// Example: Simple arbitrage utility (wants to trade a specific amount of a single asset)
export class SimpleArbitrageUtility implements UtilityFunction {
    constructor(
        private inputTokenIndex: number,
        private inputAmount: BigNumber
    ) {}

    U(psi: BigNumber[]): BigNumber {
        // We want to input a specific amount of the input token.
        // All other net trades are heavily penalized.
        if (psi[this.inputTokenIndex].eq(this.inputAmount.mul(-1))) {
            // Find the index of the max value in psi, excluding the input token
            let maxIndex = -1;
            let maxValue = BigNumber.from(0);
            for (let i = 0; i < psi.length; i++) {
                if (i !== this.inputTokenIndex && psi[i].gt(maxValue)) {
                    maxValue = psi[i];
                    maxIndex = i;
                }
            }

            // Return the value of the most valuable output token
            if (maxIndex !== -1) {
                return maxValue;
            }
        }
        return BigNumber.from(-10).pow(18); // "Negative infinity"
    }

    U_optimal(v: BigNumber[]): { value: BigNumber; gradient: BigNumber[] } {
        // For simple arbitrage utility, the optimal Ψ* is fixed, and Ū(v) is 0 if prices are valid.
        const gradient = Array(v.length).fill(BigNumber.from(0));
        gradient[this.inputTokenIndex] = this.inputAmount.mul(-1); // We *tender* the input amount

        // Check if prices are valid (non-negative)
        for (const price of v) {
            if (price.lt(0)) {
                return { value: BigNumber.from(10).pow(36), gradient }; // "Positive infinity"
            }
        }

        // Find the maximum v[i] where i is not the input token index
        let maxOutputValue = BigNumber.from(0);
        let maxOutputIndex = -1;

        for (let i = 0; i < v.length; i++) {
            if (i !== this.inputTokenIndex && v[i].gt(maxOutputValue)) {
                maxOutputValue = v[i];
                maxOutputIndex = i;
            }
        }

        // If we found a valid output token, set its gradient
        if (maxOutputIndex !== -1) {
            gradient[maxOutputIndex] = this.inputAmount;
        }

        return { value: BigNumber.from(0), gradient };
    }
} 