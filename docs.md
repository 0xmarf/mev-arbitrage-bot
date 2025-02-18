Project Overview

This project is an Ethereum arbitrage bot designed to identify and execute profitable trades across decentralized exchanges (DEXes), specifically focusing on Uniswap V2 and its forks (like SushiSwap). The bot leverages Flashbots to submit transaction bundles, mitigating front-running risks and potentially increasing the chances of successful arbitrage execution. The code is written in TypeScript and uses the ethers.js library for Ethereum interaction, along with @flashbots/ethers-provider-bundle for Flashbots integration. The bot supports both standard JSON-RPC providers and WebSockets for real-time event monitoring.

Key Features:

Market Monitoring: The bot monitors multiple Uniswap V2-style DEXes for price discrepancies between token pairs (primarily ETH/ERC20 pairs). It can use both polling (via eth_call batching) and real-time event subscriptions (via WebSockets) to update market data.

Arbitrage Opportunity Detection: It employs a hybrid optimization strategy (combining analytical calculations and, potentially, numerical optimization) to identify profitable arbitrage opportunities. It considers liquidity, price impact, and trading fees.

Flash Loan Integration: The bot is designed to use Aave V3 flash loans to execute arbitrage trades without requiring initial capital.

Flashbots Bundling: It uses Flashbots to submit transaction bundles, protecting trades from front-running and MEV (Miner Extractable Value) competition.

Gas Price Optimization: It includes a GasPriceManager to dynamically adjust gas prices for optimal inclusion in blocks, considering both network conditions and competing bundles.

Circuit Breaker: A CircuitBreaker mechanism is implemented to temporarily halt operations if a certain number of failures occur within a defined time window, preventing excessive gas waste on failed transactions.

Caching: A CacheService is included to store market data (volume, market cap, liquidity), reducing redundant RPC calls and improving performance.

Logging: Extensive logging is incorporated using winston, providing detailed information about the bot's operations, errors, and arbitrage opportunities.

Modularity: The code is structured into services, utilities, and CFMM (Constant Function Market Maker) implementations, promoting maintainability and extensibility.

Test Coverage: Unit tests are provided for core components, including the Arbitrage class and the UniswapV2EthPair market implementation.

Deployment Script: A deploy.ts script using Hardhat is provided for easy deployment of the BundleExecutor and FlashLoanExecutor contracts.

File Summary and Interactions

Here's a breakdown of the files and how they relate to each other:

1. Smart Contracts (contracts/)

interfaces/: Defines interfaces for interacting with external contracts.

IERC20.sol: Standard ERC20 token interface.

IUniswapV2Callee.sol: Interface for contracts that receive calls from Uniswap V2 pairs.

IUniswapV2Factory.sol: Interface for Uniswap V2 factory contracts.

IUniswapV2Pair.sol: Interface for Uniswap V2 pair contracts.

UniswapV2Pair.sol: Duplicate of IUniswapV2Pair.sol. This is redundant and one of them should be removed.

libraries/: Contains utility libraries.

Math.sol: Provides mathematical functions (min, sqrt).

UQ112x112.sol: Handles fixed-point arithmetic (UQ112x112 format).

BundleExecutor.sol: Executes bundles of transactions. It's designed to be called by the FlashLoanExecutor and handles the atomic execution of trades across multiple DEXes. It also handles repaying flash loans and sending profit to the designated address. This is a critical contract for ensuring atomicity. It has reentrancy protection via the inUse mapping.

FlashLoanExecutor.sol: Initiates Aave V3 flash loans and calls the BundleExecutor to execute the arbitrage. It inherits from Aave's FlashLoanSimpleReceiverBase to receive the flash loan and must implement executeOperation.

TestToken.sol: A simple ERC20 token for testing.

UniswapFlashQuery.sol: Provides functions for efficiently fetching data (reserves, pairs) from Uniswap V2-like factories.

UniswapV2Factory.sol: A standard Uniswap V2 factory contract (likely used for testing/local deployment).

UniswapV2Pair.sol: A standard Uniswap V2 pair contract (likely used for testing/local deployment).

WETH9.sol: Implements the Wrapped Ether (WETH) contract.

2. Scripts (scripts/)

deploy.ts: A Hardhat script for deploying the BundleExecutor and FlashLoanExecutor contracts.

3. Source Code (src/)

cfmm/: Contains implementations of Constant Function Market Makers (CFMMs).

CFMM.ts: Defines the CFMM interface and provides a UniswapV2CFMM class implementing the Uniswap V2 constant product formula.

config/: Holds configuration files.

config.ts: Defines the main configuration parameters for the bot, including network settings, gas settings, and DEX addresses.

thresholds.js: Defines thresholds for market filtering (liquidity, volume, market cap).

thresholds.ts: TypeScript version of thresholds.js, providing type safety.

optimization/: Contains optimization algorithms.

HybridOptimizer.ts: Implements a hybrid optimization strategy combining analytical solutions (for Uniswap V2) with a numerical optimization method (L-BFGS-B) for more complex scenarios.

services/: Provides services for interacting with external components.

CacheService.ts: Implements a file-based caching mechanism for market data.

MevShareService.ts: Provides a service for interacting with Flashbots, including submitting bundles and simulating transactions.

MulticallService.ts: Provides a service for efficiently making multiple contract calls in a single batch.

utils/: Contains utility functions.

CircuitBreaker.ts: Implements a circuit breaker to pause the bot if failures exceed a threshold.

GasPriceManager.ts: Calculates optimal gas prices for transactions.

logger.ts: Provides logging functionality with different log levels and context.

UtilityFunction.ts A utility function to help calculate optimal arbitrage

abi.ts: Exports contract ABIs (Application Binary Interfaces) for interacting with the smart contracts.

addresses.ts: Exports constant addresses for various contracts, including Uniswap and Sushiswap factories and WETH.

Arbitrage.ts: The core logic of the arbitrage bot. This class orchestrates the entire process: finding markets, evaluating opportunities, creating bundles, and submitting them to Flashbots.

eth_calls.ts: Provides a utility function for batching Ethereum calls.

EthMarket.ts: Defines the EthMarket interface, which represents a generic Ethereum market (DEX). It also includes an abstract EthMarket class.

index.ts: The main entry point for the bot using standard JSON-RPC.

index.mevshare.ts: The main entry point for the bot using MEV-Share.

index.websocket.ts: The main entry point for the bot using WebSockets.

multihop.js: (Incomplete/Unused) Logic for multi-hop arbitrage.

types.ts: Defines TypeScript types and interfaces used throughout the project.

UniswapV2EthPair.ts: Implements the EthMarket interface for Uniswap V2 pairs, providing methods to get reserves, calculate price impact, and generate calldata for swaps.

utils.ts: Provides utility functions, including bigNumberToDecimal and getDefaultRelaySigningKey.

websocketmanager.ts: Manages WebSocket connections and subscriptions for real-time market data updates.

4. Tests (test/)

Contains unit tests for various components of the bot.

5. Typechain Types (typechain-types/)

Automatically generated TypeScript bindings for the smart contracts.

6. Configuration Files

.eslintrc.js: ESLint configuration.

.gitignore: Files and folders to ignore in Git.

hardhat.config.cjs: Hardhat configuration (CommonJS).

hardhat.config.ts: Hardhat configuration (TypeScript).

jasmine.json: Jasmine configuration (deprecated).

package.json: Project metadata and dependencies.

README.md: Project documentation.

tsconfig.json: TypeScript compiler configuration.

tsconfig.websocket.json: TypeScript compiler configuration for WebSocket version.

Key Interactions and Data Flow

Initialization:

The index.ts or index.websocket.ts script is executed.

Environment variables are loaded.

Ethereum provider and wallets are initialized.

FlashbotsBundleProvider is created for Flashbots interaction.

Arbitrage instance is created.

UniswapV2EthPair.getUniswapMarketsByToken is called to fetch and filter Uniswap V2 and SushiSwap markets.

Markets are grouped by token.

EnhancedWebSocketManager is initialized (for index.websocket.ts).

Market Monitoring (Polling - index.ts):

The provider.on('block', ...) listener triggers on each new block.

updateReserves (or UniswapV2EthPair.updateReservesWithMulticall in the WebSocket version) is called to fetch the latest reserves for all monitored markets.

arbitrage.evaluateMarkets is called to identify arbitrage opportunities.

Market Monitoring (WebSockets - index.websocket.ts):

The EnhancedWebSocketManager establishes a WebSocket connection to an Ethereum node.

It subscribes to newHeads (new blocks) and logs (events) for relevant contracts and topics (Transfer and Swap).

When a new block event (newHeads) is received, the updateReserves function is called.

When a relevant log event (logs) is received, the handleSubscriptionMessage function is called.

handleSubscriptionMessage checks if the event is a Transfer or Swap event from a monitored DEX.

If relevant, it calls the appropriate handler (handleTransferEvent or handleSwapEvent). These currently just log the event, but this is where you'd integrate with the Arbitrage class to trigger re-evaluation and potential bundle submission.

Arbitrage Opportunity Detection (Arbitrage.evaluateMarkets):

Iterates through the marketsByToken to find potential arbitrage opportunities.

Calls getReservesByToken on each market to update the reserves.

For each pair of markets that share a token, it calculates the potential profit from buying on one market and selling on the other.

If the profit exceeds the configured minProfitThreshold, it creates a CrossedMarketDetails object.

The opportunities are sorted by profitability.

Arbitrage Execution (Arbitrage.takeCrossedMarkets):

Iterates through the identified arbitrage opportunities.

For each opportunity:

Calls executeArbitrageTrade.

executeArbitrageTrade:

Prepares the necessary calldata for the trades (buy and sell).

Calculates the miner reward.

Creates a Flashbots bundle containing the user's original transaction (from the event) and the arbitrage transaction.

Simulates the bundle using flashbotsProvider.simulate.

If profitable, submits the bundle using flashbotsProvider.sendBundle.

Retries submission if necessary (up to MAX_RETRIES).

Gas Price Optimization (GasPriceManager):

The GasPriceManager is used to calculate an optimal gas price for the bundle.

It maintains a history of recent base fees.

It considers a configured priority fee and a minimum profit multiplier.

Circuit Breaker (CircuitBreaker):

The CircuitBreaker is used to prevent excessive failed transactions.

recordFailure is called when a transaction fails.

isTripped is checked before submitting a bundle. If tripped, the bot stops submitting bundles for a configured cooldown period.

recordSuccess is called when a transaction succeeds, resetting the failure count.

Areas for Improvement/Further Development

Complete Multi-Hop Arbitrage: The multihop.js file contains the beginnings of multi-hop arbitrage logic, but it's not fully integrated into the main bot's execution flow. This would be a significant enhancement, as it would allow the bot to find more complex arbitrage opportunities.

More Sophisticated Utility Function: The SimpleArbitrageUtility is a very basic example. A more realistic utility function would consider factors like risk tolerance, slippage, and the probability of the arbitrage opportunity still being available by the time the bundle is mined.

Dynamic Fee Calculation: The getTradingFee method in UniswapV2EthPair currently returns a hardcoded value. This should be fetched dynamically from the contract, as some pairs might have different fees.

Price Impact Calculation: The current getPriceImpact is a very basic estimate. A more accurate calculation would consider the shape of the AMM curve.

Error Handling: While there's some basic error handling, it could be made more robust. For example, specific errors from the Ethereum provider or Flashbots provider could be handled differently. More detailed logging of errors would also be beneficial.

Backrunning Logic: The current code assumes that the bot will backrun the user's transaction. Adding logic to frontrun or sandwich the transaction could be explored.

Transaction Decoding: The extractTargetPair function in MevShareArbitrage currently assumes a specific structure for Uniswap V2 swap transactions. A more robust solution would use a library like ethers-decode-input to decode arbitrary transaction data.

MEV-Share Hints: The code includes placeholders for MEV-Share hints, but a more complete implementation would involve analyzing the pending transaction to extract relevant information and use it to optimize the arbitrage strategy.

Concurrency Control: The use of p-limit is a good start, but more sophisticated concurrency control might be needed to handle a large number of markets and prevent rate limiting by the Ethereum provider.

State Management: The pendingExecutions mapping in FlashLoanExecutor.sol is not used. This suggests an incomplete feature, possibly related to tracking the state of pending arbitrage attempts. This should be implemented or removed.

Testing: The provided tests are a good starting point, but more comprehensive testing is needed, including edge cases and failure scenarios. Consider using a testing framework that supports asynchronous tests more directly (like Jest).

Configuration: The config.ts file is a good start, but consider using a more robust configuration management system (e.g., a .env file with a library like dotenv) to manage sensitive information like private keys and API keys.

Code Duplication: There is some code duplication, particularly in the interface definitions. These should be consolidated.

UniswapFlashQuery.sol: This contract is marked as abstract, but it doesn't have any abstract methods. It should likely be a regular contract.

Gas Optimization: The code includes some basic gas optimization considerations (e.g., using immutable for constants), but further optimization is possible. For example, using calldata instead of memory where appropriate, and optimizing the order of operations in the smart contracts.

Security Audits: Before deploying any bot to mainnet, it's crucial to conduct thorough security audits of both the smart contracts and the off-chain code.

Deployment and Execution

Environment Setup: Ensure you have Node.js and npm installed. Install dependencies using npm install.

Configuration: Create a .env file in the root directory and set the required environment variables (see README.md and index.ts).

Deployment: Use the deploy.ts script with Hardhat (npx hardhat run scripts/deploy.ts --network <network>) to deploy the BundleExecutor and FlashLoanExecutor contracts. Record the deployed address of BundleExecutor.

Funding: Send ETH and any required ERC20 tokens to the deployed BundleExecutor contract.

Execution:

For standard JSON-RPC: Run npm run start.

For WebSocket connection: Run npm run start:ws.

For MEV-Share: Run npm run start:mevshare.

The run-test.sh script uses the hardhat network for testing.

Overall, this codebase provides a solid foundation for an Ethereum arbitrage bot using Flashbots. However, it's crucial to understand that arbitrage is a highly competitive field, and significant effort is required to develop a bot that can consistently generate profit. The areas for improvement listed above highlight some of the key considerations for building a more robust and competitive system.

