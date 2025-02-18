import { Wallet, providers, BigNumber } from 'ethers';
import { FlashbotsBundleProvider, FlashbotsTransactionResponse } from '@flashbots/ethers-provider-bundle';
import { logInfo, logError, logMevShareEvent, LogContext } from '../utils/logger';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import { GasPriceManager } from '../utils/GasPriceManager';
import { EventEmitter } from 'events';

// Extend LogContext for MEV-Share specific logging
interface MevShareLogContext extends LogContext {
    reason?: string;
    gasUsed?: BigNumber;
}

export interface MevShareConfig {
    maxBaseFeeGwei: number;
    minProfitThreshold: BigNumber;
    maxBundleSize: number;
    maxBlocksToTry: number;
}

export interface BundleParams {
    transactions: Array<{
        signedTransaction: string;
        hash: string;
    }>;
    targetBlock: number;
    minTimestamp?: number;
    maxTimestamp?: number;
}

interface SimulationResult {
    coinbaseDiff: BigNumber;
    totalGasUsed: number;
    error?: { message: string };
}

interface BundleError {
    error: {
        message: string;
    };
}

export class MevShareService extends EventEmitter {
    private flashbotsProvider!: FlashbotsBundleProvider;
    private circuitBreaker: CircuitBreaker;
    private gasPriceManager: GasPriceManager;
    private isRunning: boolean = false;
    private wallet: Wallet;
    private provider: providers.BaseProvider;
    private config: MevShareConfig;

    constructor(
        wallet: Wallet,
        provider: providers.BaseProvider,
        config: MevShareConfig
    ) {
        super();
        this.wallet = wallet;
        this.provider = provider;
        this.config = config;
        this.circuitBreaker = new CircuitBreaker({
            maxFailures: 3,
            resetTimeoutMs: 60000, // 1 minute
            cooldownPeriodMs: 300000 // 5 minutes
        });
        this.gasPriceManager = new GasPriceManager(this.provider);
    }

    public async connect(): Promise<void> {
        try {
            this.flashbotsProvider = await FlashbotsBundleProvider.create(
                this.provider,
                this.wallet,
                'https://relay.flashbots.net',
                'mainnet'
            );
            this.isRunning = true;
            logInfo('Connected to MEV-Share relay');
        } catch (error) {
            logError('Failed to connect to MEV-Share relay', { error: error as Error });
            throw error;
        }
    }

    public async submitBundle(params: BundleParams): Promise<boolean> {
        if (!this.isRunning) {
            throw new Error('MEV-Share service is not running');
        }

        if (this.circuitBreaker.isTripped()) {
            logError('Circuit breaker is tripped, skipping bundle submission');
            return false;
        }

        try {
            // Simulate bundle first
            const simulation = await this.flashbotsProvider.simulate(
                params.transactions.map(tx => tx.signedTransaction),
                params.targetBlock
            ) as SimulationResult;

            if (simulation.error) {
                throw new Error(`Simulation failed: ${simulation.error.message}`);
            }

            // Check if simulation is profitable
            const profit = simulation.coinbaseDiff;
            const gasUsed = BigNumber.from(simulation.totalGasUsed);

            if (!await this.gasPriceManager.isGasProfitable(profit, gasUsed)) {
                logInfo('Bundle not profitable enough', {
                    profit,
                    gasUsed
                } as MevShareLogContext);
                return false;
            }

            // Submit bundle
            const bundleSubmission = await this.flashbotsProvider.sendBundle(
                params.transactions.map(tx => ({
                    signedTransaction: tx.signedTransaction,
                    hash: tx.hash
                })),
                params.targetBlock,
                {
                    minTimestamp: params.minTimestamp,
                    maxTimestamp: params.maxTimestamp
                }
            );

            // Check for bundle submission error
            if ((bundleSubmission as BundleError).error) {
                throw new Error(`Bundle submission failed: ${(bundleSubmission as BundleError).error.message}`);
            }

            // Wait for bundle inclusion
            const waitResponse = await (bundleSubmission as FlashbotsTransactionResponse).wait();
            
            switch (waitResponse) {
                case 0:
                    logMevShareEvent('Bundle included', {
                        blockNumber: params.targetBlock,
                        profit
                    } as MevShareLogContext);
                    this.circuitBreaker.recordSuccess();
                    return true;
                case 1:
                    logMevShareEvent('Bundle failed', {
                        blockNumber: params.targetBlock,
                        reason: 'BlockPassedWithoutInclusion'
                    } as MevShareLogContext);
                    return false;
                case 2:
                    logMevShareEvent('Bundle still pending', {
                        blockNumber: params.targetBlock
                    });
                    return false;
                default:
                    throw new Error(`Unknown wait response: ${waitResponse}`);
            }
        } catch (error) {
            this.circuitBreaker.recordFailure({
                error: error as Error,
                reason: 'Bundle submission failed'
            });
            logError('Error submitting bundle', { error: error as Error });
            return false;
        }
    }

    public stop(): void {
        this.isRunning = false;
        logInfo('MEV-Share service stopped');
    }

    public isActive(): boolean {
        return this.isRunning && !this.circuitBreaker.isTripped();
    }

    public async sendBundle(params: BundleParams): Promise<string | null> {
        const success = await this.submitBundle(params);
        return success ? params.transactions[0].hash : null;
    }
} 