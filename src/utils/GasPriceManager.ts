import { BigNumber, providers } from 'ethers';
import { logInfo, logError, LogContext } from './logger.js';

// Extend LogContext for gas-specific logging
interface GasLogContext extends LogContext {
    baseFee?: string;
    avgBaseFee?: string;
    priorityFee?: string;
    maxFee?: string;
}

export interface GasPriceConfig {
    maxFeePerGas: BigNumber;
    maxPriorityFeePerGas: BigNumber;
    minProfitMultiplier: number;
    priorityFeePremium: number;
}

export class GasPriceManager {
    private lastBaseFee: BigNumber = BigNumber.from(0);
    private historicalBaseFees: BigNumber[] = [];
    private readonly MAX_HISTORICAL_FEES = 20;

    constructor(
        private provider: providers.Provider,
        private config: GasPriceConfig = {
            maxFeePerGas: BigNumber.from("500000000000"), // 500 gwei
            maxPriorityFeePerGas: BigNumber.from("3000000000"), // 3 gwei
            minProfitMultiplier: 1.1, // 10% minimum profit after gas
            priorityFeePremium: 1.2 // 20% premium on priority fee
        }
    ) {}

    public async updateBaseFee(): Promise<void> {
        try {
            const block = await this.provider.getBlock('latest');
            if (block && block.baseFeePerGas) {
                this.lastBaseFee = block.baseFeePerGas;
                this.historicalBaseFees.push(block.baseFeePerGas);
                if (this.historicalBaseFees.length > this.MAX_HISTORICAL_FEES) {
                    this.historicalBaseFees.shift();
                }
            }
        } catch (error) {
            logError('Failed to update base fee', { error: error as Error });
        }
    }

    public async getOptimalGasFees(profit: BigNumber): Promise<{
        maxFeePerGas: BigNumber;
        maxPriorityFeePerGas: BigNumber;
    }> {
        await this.updateBaseFee();

        // Calculate the average base fee from recent blocks
        const avgBaseFee = this.historicalBaseFees.reduce(
            (sum, fee) => sum.add(fee),
            BigNumber.from(0)
        ).div(this.historicalBaseFees.length || 1);

        // Get the current network conditions
        const feeData = await this.provider.getFeeData();
        const currentPriorityFee = feeData.maxPriorityFeePerGas || BigNumber.from(0);

        // Calculate optimal priority fee (add premium to be competitive)
        let priorityFee = currentPriorityFee.mul(
            Math.floor(this.config.priorityFeePremium * 100)
        ).div(100);

        // Cap priority fee at our maximum
        if (priorityFee.gt(this.config.maxPriorityFeePerGas)) {
            priorityFee = this.config.maxPriorityFeePerGas;
        }

        // Calculate max fee (base fee + priority fee + buffer)
        const maxFee = avgBaseFee.mul(2).add(priorityFee);

        // Ensure max fee doesn't exceed our limit
        const finalMaxFee = maxFee.gt(this.config.maxFeePerGas)
            ? this.config.maxFeePerGas
            : maxFee;

        // Log the gas price decision with proper context type
        logInfo('Calculated optimal gas fees', {
            baseFee: this.lastBaseFee.toString(),
            avgBaseFee: avgBaseFee.toString(),
            priorityFee: priorityFee.toString(),
            maxFee: finalMaxFee.toString()
        } as GasLogContext);

        return {
            maxFeePerGas: finalMaxFee,
            maxPriorityFeePerGas: priorityFee
        };
    }

    public async isGasProfitable(
        profit: BigNumber,
        gasLimit: BigNumber
    ): Promise<boolean> {
        const { maxFeePerGas } = await this.getOptimalGasFees(profit);
        const gasCost = gasLimit.mul(maxFeePerGas);
        const minProfit = gasCost.mul(Math.floor(this.config.minProfitMultiplier * 100)).div(100);
        
        return profit.gt(minProfit);
    }

    public getHistoricalBaseFees(): BigNumber[] {
        return [...this.historicalBaseFees];
    }

    public getLastBaseFee(): BigNumber {
        return this.lastBaseFee;
    }
} 