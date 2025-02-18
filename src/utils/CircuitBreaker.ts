import { BigNumber } from 'ethers';
import { logCircuitBreakerTripped } from './logger.js';

export interface CircuitBreakerConfig {
    maxFailures: number;
    resetTimeoutMs: number;
    cooldownPeriodMs: number;
}

export class CircuitBreaker {
    private failures: number = 0;
    private lastFailureTime: number = 0;
    private isOpen: boolean = false;
    private resetTimeout: NodeJS.Timeout | null = null;

    constructor(private config: CircuitBreakerConfig) {}

    public recordFailure(context: { reason?: string; error?: Error } = {}): void {
        this.failures++;
        this.lastFailureTime = Date.now();

        if (this.failures >= this.config.maxFailures) {
            if (!this.isOpen) {
                this.isOpen = true;
                logCircuitBreakerTripped(context.reason || 'Max failures exceeded', {
                    error: context.error
                });
            }

            // Set up auto-reset after timeout
            if (this.resetTimeout === null) {
                this.resetTimeout = setTimeout(() => {
                    this.reset();
                }, this.config.resetTimeoutMs);
            }
        }
    }

    public recordSuccess(): void {
        this.failures = 0;
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
            this.resetTimeout = null;
        }
    }

    public isTripped(): boolean {
        if (!this.isOpen) {
            return false;
        }

        // Check if we're still in the cooldown period
        const timeSinceLastFailure = Date.now() - this.lastFailureTime;
        return timeSinceLastFailure < this.config.cooldownPeriodMs;
    }

    public reset(): void {
        this.failures = 0;
        this.isOpen = false;
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
            this.resetTimeout = null;
        }
    }
}

// Create a default instance for global use
export const defaultCircuitBreaker = new CircuitBreaker({
    maxFailures: 3,
    resetTimeoutMs: 60000, // 1 minute
    cooldownPeriodMs: 300000 // 5 minutes
}); 