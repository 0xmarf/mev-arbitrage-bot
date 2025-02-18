"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Arbitrage_1 = require("../src/Arbitrage");
const addresses_1 = require("../src/addresses");
const ethers_1 = require("ethers");
const utils_1 = require("../src/utils");
const chai = require("chai");
const expect = chai.expect;

const MARKET_ADDRESS = "0x0000000000000000000000000000000000000001";
const TOKEN_ADDRESS = "0x000000000000000000000000000000000000000a";
const PROTOCOL_NAME = "TEST";

// Mock UniswapV2EthPair class
class MockUniswapV2EthPair {
    constructor(marketAddress, tokens, protocol) {
        this.marketAddress = marketAddress;
        this.tokens = tokens;
        this.protocol = protocol;
        this._reserves = {
            tokenA: ethers_1.BigNumber.from(0),
            tokenB: ethers_1.BigNumber.from(0)
        };
    }

    setReservesViaOrderedBalances([tokenAAmount, tokenBAmount]) {
        this._reserves = {
            tokenA: tokenAAmount,
            tokenB: tokenBAmount
        };
    }

    async getReserves(tokenAddress) {
        return tokenAddress === this.tokens[0] ? this._reserves.tokenA : this._reserves.tokenB;
    }

    async getPriceImpact(tokenAddress, amount) {
        // Not used anymore, but keeping for compatibility
        return ethers_1.BigNumber.from("100000000000000");
    }

    async getTradingFee() {
        return ethers_1.BigNumber.from("100000000000000");
    }

    async getTokensOut(tokenIn, tokenOut, amountIn) {
        const reserveIn = await this.getReserves(tokenIn);
        const reserveOut = await this.getReserves(tokenOut);
        
        // Using the constant product formula: x * y = k
        // (x + dx)(y - dy) = k
        // where dx is amountIn and dy is amountOut
        const amountInWithFee = amountIn.mul(997); // 0.3% fee
        const numerator = amountInWithFee.mul(reserveOut);
        const denominator = reserveIn.mul(1000).add(amountInWithFee);
        return numerator.div(denominator);
    }

    async getTokensIn(tokenIn, tokenOut, amountOut) {
        const reserveIn = await this.getReserves(tokenIn);
        const reserveOut = await this.getReserves(tokenOut);
        
        // Using the constant product formula: x * y = k
        // (x + dx)(y - dy) = k
        // where dx is amountIn and dy is amountOut
        // Solving for dx: dx = (y * dx) / (x - dx/0.997)
        const numerator = reserveIn.mul(amountOut).mul(1000);
        const denominator = (reserveOut.sub(amountOut)).mul(997);
        return numerator.div(denominator);
    }

    async getLiquidity() {
        return this._reserves.tokenB; // Return WETH liquidity
    }
}

describe('Arbitrage', function () {
    let arbitrage;
    let marketsByToken;
    
    beforeEach(() => {
        // Create mock markets
        const market1 = new MockUniswapV2EthPair(MARKET_ADDRESS, [TOKEN_ADDRESS, addresses_1.WETH_ADDRESS], PROTOCOL_NAME);
        const market2 = new MockUniswapV2EthPair(MARKET_ADDRESS, [TOKEN_ADDRESS, addresses_1.WETH_ADDRESS], PROTOCOL_NAME);
        
        // Group markets by token
        marketsByToken = {
            [TOKEN_ADDRESS]: [market1, market2]
        };

        // Initialize Arbitrage instance with mock parameters
        arbitrage = new Arbitrage_1.Arbitrage(
            null, // wallet
            null, // flashbotsProvider
            null, // bundleExecutor
            {
                maxFailedTxs: 3,
                timeWindowMs: 60000,
                cooldownMs: 60000,
                profitThreshold: ethers_1.BigNumber.from("10000000000000000"), // 0.01 ETH
                maxGasPrice: ethers_1.BigNumber.from("100000000000"), // 100 gwei
                minLiquidity: ethers_1.BigNumber.from("1000000000000000000") // 1 ETH
            },
            null // wsManager
        );
    });

    it('Should find crossed markets with price difference', async function () {
        // Set reserves to create a clear price difference
        // Market 1: 1 TOKEN = 2 WETH (expensive)
        // Market 2: 1 TOKEN = 1 WETH (cheaper)
        const market1Reserves = [
            ethers_1.utils.parseEther("100"),  // 100 TOKEN
            ethers_1.utils.parseEther("200")   // 200 WETH
        ];
        const market2Reserves = [
            ethers_1.utils.parseEther("100"),  // 100 TOKEN
            ethers_1.utils.parseEther("100")   // 100 WETH
        ];
        
        marketsByToken[TOKEN_ADDRESS][0].setReservesViaOrderedBalances(market1Reserves);
        marketsByToken[TOKEN_ADDRESS][1].setReservesViaOrderedBalances(market2Reserves);
        
        const arbitrageOpportunities = await arbitrage.evaluateMarkets(marketsByToken);
        expect(arbitrageOpportunities).to.be.an('array');
        expect(arbitrageOpportunities.length).to.be.greaterThan(0);
        
        const bestOpportunity = arbitrageOpportunities[0];
        expect(bestOpportunity.profit.gt(0)).to.be.true;
        expect(bestOpportunity.volume.gt(0)).to.be.true;
    });

    it('Should not find crossed markets when prices are equal', async function () {
        // Set equal reserves so there's no profitable opportunity
        const equalReserves = [
            ethers_1.utils.parseEther("100"),  // 100 TOKEN
            ethers_1.utils.parseEther("100")   // 100 WETH - same price in both markets
        ];
        
        marketsByToken[TOKEN_ADDRESS][0].setReservesViaOrderedBalances(equalReserves);
        marketsByToken[TOKEN_ADDRESS][1].setReservesViaOrderedBalances(equalReserves);
        
        const arbitrageOpportunities = await arbitrage.evaluateMarkets(marketsByToken);
        expect(arbitrageOpportunities).to.be.an('array');
        expect(arbitrageOpportunities.length).to.equal(0);
    });
});
