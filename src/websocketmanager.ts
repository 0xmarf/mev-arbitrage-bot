import { WebSocket } from 'ws';
import { BigNumber } from '@ethersproject/bignumber';
import { Arbitrage } from './Arbitrage.js';
import { UniswapV2EthPair } from './UniswapV2EthPair.js';
import * as dotenv from "dotenv";
import axios from 'axios';
import { MarketsByToken } from './types.js';
import { Config } from './config/config.js';
import { logInfo, logError, logDebug, logWarn } from './utils/logger.js';
dotenv.config();

// Function to send updates to the frontend server
async function sendUpdate(eventName: string, data: any) {
    try {
        await axios.post('http://localhost:3001/update', {
            eventName,
            data
        });
    } catch (error: any) {
        logError('Failed to send update to frontend', { 
            error: error instanceof Error ? error : new Error(error?.message || String(error))
        });
    }
}

export interface SubscriptionConfig {
    DEX_ADDRESSES: string[];
    TRANSFER_TOPIC: string;
    SWAP_TOPIC: string;
}

export class EnhancedWebSocketManager {
    private ws!: WebSocket;
    private config: Config;
    private arbitrage: Arbitrage;
    private marketsByToken: MarketsByToken;
    private metrics: any = {};
    private reconnectAttempts: number = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private readonly RECONNECT_DELAY = 5000; // 5 seconds

    constructor(
        wsUrl: string,
        config: Config,
        arbitrage: Arbitrage,
        marketsByToken: MarketsByToken
    ) {
        this.config = config;
        this.arbitrage = arbitrage;
        this.marketsByToken = marketsByToken;
        this.initializeWebSocket(wsUrl);
    }

    private initializeWebSocket(wsUrl: string) {
        logInfo('Initializing WebSocket connection...', { wsUrl });
        
        this.ws = new WebSocket(wsUrl, {
            headers: {
                'Origin': 'mev-bot'
            },
            handshakeTimeout: 10000
        });

        this.ws.on('open', () => {
            logInfo('WebSocket connection established');
            this.reconnectAttempts = 0;
            this.subscribeToEvents();
        });

        this.ws.on('message', async (data: string) => {
            try {
                const message = JSON.parse(data);
                logDebug('Received WebSocket message', { 
                    method: message.method,
                    id: message.id,
                    params: message.params 
                });

                // Handle subscription confirmations
                if (message.method === 'eth_subscription') {
                    await this.handleSubscriptionMessage(message.params.result);
                } else if (message.id) {
                    // Log subscription responses
                    logInfo('Subscription response received', {
                        id: message.id,
                        result: message.result
                    });
                }
            } catch (error: any) {
                logError('Error processing WebSocket message', { 
                    error: error instanceof Error ? error : new Error(error?.message || String(error)),
                    data: data.toString()
                });
            }
        });

        this.ws.on('close', (code: number, reason: string) => {
            logWarn('WebSocket connection closed', {
                code,
                reason: reason.toString()
            });
            this.handleReconnection(wsUrl);
        });

        this.ws.on('error', (error: any) => {
            logError('WebSocket error', { 
                error: error instanceof Error ? error : new Error(error?.message || String(error))
            });
            this.handleReconnection(wsUrl);
        });

        // Add ping/pong to keep connection alive
        setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
                logDebug('Sent ping to keep connection alive');
            }
        }, 30000); // Send ping every 30 seconds

        this.ws.on('pong', () => {
            logDebug('Received pong from server');
        });
    }

    private subscribeToEvents() {
        logInfo('Subscribing to events...');
        
        // Subscribe to new heads (blocks)
        const newHeadsSubscription = {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_subscribe',
            params: ['newHeads']
        };
        
        // Subscribe to logs for transfer events
        const transferSubscription = {
            jsonrpc: '2.0',
            id: 2,
            method: 'eth_subscribe',
            params: [
                'logs',
                {
                    topics: [this.config.TRANSFER_TOPIC],
                    address: this.config.DEX_ADDRESSES
                }
            ]
        };

        // Subscribe to logs for swap events
        const swapSubscription = {
            jsonrpc: '2.0',
            id: 3,
            method: 'eth_subscribe',
            params: [
                'logs',
                {
                    topics: [this.config.SWAP_TOPIC],
                    address: this.config.DEX_ADDRESSES
                }
            ]
        };

        // Send subscriptions with error handling
        try {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(newHeadsSubscription));
                logInfo('Sent newHeads subscription');
                
                this.ws.send(JSON.stringify(transferSubscription));
                logInfo('Sent transfer events subscription');
                
                this.ws.send(JSON.stringify(swapSubscription));
                logInfo('Sent swap events subscription');

                logInfo('Successfully sent all subscription requests', {
                    subscriptionTypes: ['newHeads', 'transfer', 'swap'],
                    dexAddresses: this.config.DEX_ADDRESSES
                });
            } else {
                logError('WebSocket not open when trying to subscribe', {
                    readyState: this.ws.readyState
                });
            }
        } catch (error: any) {
            logError('Error sending subscriptions', {
                error: error instanceof Error ? error : new Error(error?.message || String(error))
            });
        }
    }

    private async handleSubscriptionMessage(event: any) {
        logDebug('Processing subscription message', { 
            event,
            eventType: event.topics ? 'log' : 'newHeads'
        });
        
        // Handle newHeads subscription
        if (!event.topics) {
            logInfo('New block received', {
                blockNumber: parseInt(event.number, 16),
                timestamp: parseInt(event.timestamp, 16)
            });
            return;
        }
        
        // Check if the event is related to our monitored DEXes
        if (!this.config.DEX_ADDRESSES.some(address => 
            event.address && event.address.toLowerCase() === address.toLowerCase()
        )) {
            return;
        }

        // Process transfer events
        if (event.topics && event.topics[0] === this.config.TRANSFER_TOPIC) {
            await this.handleTransferEvent(event);
        }

        // Process swap events
        if (event.topics && event.topics[0] === this.config.SWAP_TOPIC) {
            await this.handleSwapEvent(event);
        }
    }

    private async handleTransferEvent(event: any) {
        try {
            logDebug('Processing transfer event', { 
                txHash: event.transactionHash,
                address: event.address
            });

            // Update reserves for the affected market
            const market = await this.findMarketByAddress(event.address);
            if (market) {
                await market.updateReserves();
                logDebug('Updated reserves after transfer', {
                    marketAddress: event.address
                });

                // Check for arbitrage opportunities
                const opportunities = await this.arbitrage.evaluateMarkets(this.marketsByToken);
                if (opportunities.length > 0) {
                    logInfo('Found arbitrage opportunities after transfer', {
                        count: opportunities.length,
                        maxProfit: opportunities[0].profit.toString()
                    });
                    await this.arbitrage.takeCrossedMarkets(opportunities, event.blockNumber, 3);
                }
            }
        } catch (error: any) {
            logError('Error handling transfer event', { 
                error: error instanceof Error ? error : new Error(error?.message || String(error)),
                txHash: event.transactionHash 
            });
        }
    }

    private async handleSwapEvent(event: any) {
        try {
            logDebug('Processing swap event', { 
                txHash: event.transactionHash,
                address: event.address
            });

            // Update reserves for the affected market
            const market = await this.findMarketByAddress(event.address);
            if (market) {
                await market.updateReserves();
                logDebug('Updated reserves after swap', {
                    marketAddress: event.address
                });

                // Check for arbitrage opportunities
                const opportunities = await this.arbitrage.evaluateMarkets(this.marketsByToken);
                if (opportunities.length > 0) {
                    logInfo('Found arbitrage opportunities after swap', {
                        count: opportunities.length,
                        maxProfit: opportunities[0].profit.toString()
                    });
                    await this.arbitrage.takeCrossedMarkets(opportunities, event.blockNumber, 3);
                }
            }
        } catch (error: any) {
            logError('Error handling swap event', { 
                error: error instanceof Error ? error : new Error(error?.message || String(error)),
                txHash: event.transactionHash 
            });
        }
    }

    private async findMarketByAddress(address: string): Promise<UniswapV2EthPair | null> {
        for (const markets of Object.values(this.marketsByToken)) {
            for (const market of markets) {
                if (market.marketAddress.toLowerCase() === address.toLowerCase()) {
                    return market as UniswapV2EthPair;
                }
            }
        }
        return null;
    }

    private handleReconnection(wsUrl: string) {
        if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            logWarn('Attempting to reconnect', { 
                attempt: this.reconnectAttempts, 
                maxAttempts: this.MAX_RECONNECT_ATTEMPTS 
            });
            setTimeout(() => {
                this.initializeWebSocket(wsUrl);
            }, this.RECONNECT_DELAY * this.reconnectAttempts);
        } else {
            logError('Max reconnection attempts reached. Please check the connection and restart the application.');
            process.exit(1);
        }
    }

    public updateMetrics(newMetrics: any) {
        this.metrics = { ...this.metrics, ...newMetrics };
    }

    public getMetrics() {
        return this.metrics;
    }
}

// Example usage
const config: SubscriptionConfig = {
    DEX_ADDRESSES: [
        '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
        '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'  // Sushiswap Router
    ],
    TRANSFER_TOPIC: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    SWAP_TOPIC: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
};