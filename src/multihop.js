"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiHopArbitrage = void 0;
const ethers_1 = require("ethers");
const addresses_1 = require("./addresses");
class MultiHopArbitrage {
    async adjustGasPriceForTransaction(currentGasPrice, avgGasPrice, competingBundleGasPrice) {
        console.log(`Adjusting gas price: current=${currentGasPrice}, avg=${avgGasPrice}, competing=${competingBundleGasPrice}`);
        let adjustedGasPrice = currentGasPrice;
        if (avgGasPrice.gt(adjustedGasPrice)) {
            adjustedGasPrice = avgGasPrice;
        }
        if (competingBundleGasPrice.gt(adjustedGasPrice)) {
            adjustedGasPrice = competingBundleGasPrice;
        }
        // Add 10% to ensure priority
        const gasPriceIncreasePercentage = ethers_1.BigNumber.from(10);
        const additionalGasPrice = adjustedGasPrice.mul(gasPriceIncreasePercentage).div(100);
        adjustedGasPrice = adjustedGasPrice.add(additionalGasPrice);
        console.log(`Adjusted gas price: ${adjustedGasPrice}`);
        return adjustedGasPrice;
    }
    constructor(provider, flashLoanAddress, flashLoanAbi) {
        this.MAX_HOPS = 3; // Configurable maximum number of hops
        this.FLASH_LOAN_FEE = 0.0009; // 0.09% fee for most flash loan protocols
        this.provider = provider;
        this.flashLoanContract = new ethers_1.Contract(flashLoanAddress, flashLoanAbi, provider);
    }
    async findArbitrageOpportunities(marketsByToken, startToken = addresses_1.WETH_ADDRESS, maxPaths = 10) {
        const opportunities = [];
        const visited = new Set();
        // Start with paths from WETH or specified token
        await this.findPaths(startToken, startToken, [], [], ethers_1.BigNumber.from(0), visited, opportunities, marketsByToken, maxPaths);
        // Sort opportunities by expected profit
        return opportunities.sort((a, b) => b.expectedProfit.sub(a.expectedProfit).toNumber());
    }
    async findPaths(currentToken, targetToken, currentPath, tokenPath, currentAmount, visited, opportunities, marketsByToken, maxPaths, depth = 0) {
        // Base case: check if we've found a profitable cycle
        if (depth > 0 && currentToken === targetToken) {
            const profit = currentAmount.sub(ethers_1.BigNumber.from(10).pow(18)); // Assuming 1 ETH initial amount
            if (profit.gt(0)) {
                opportunities.push({
                    markets: [...currentPath],
                    tokens: [...tokenPath, currentToken],
                    expectedProfit: profit
                });
            }
            return;
        }
        // Stop if we've reached max depth or found enough opportunities
        if (depth >= this.MAX_HOPS || opportunities.length >= maxPaths) {
            return;
        }
        // Get all markets that include the current token
        const relevantMarkets = marketsByToken[currentToken] || [];
        for (const market of relevantMarkets) {
            // Find the other token in the market
            const otherToken = market.tokens[0] === currentToken ?
                market.tokens[1] : market.tokens[0];
            // Skip if we've visited this token (unless it's the target and we've made at least one hop)
            if (visited.has(otherToken) && (otherToken !== targetToken || depth === 0)) {
                continue;
            }
            // Calculate expected output amount
            let outputAmount;
            try {
                outputAmount = await market.getTokensOut(currentToken, otherToken, depth === 0 ? ethers_1.BigNumber.from(10).pow(18) : currentAmount // Start with 1 ETH
                );
                // Apply flash loan fee if using flash loan
                if (depth === 0) {
                    const flashLoanFee = outputAmount.mul(Math.floor(this.FLASH_LOAN_FEE * 10000)).div(10000);
                    outputAmount = outputAmount.sub(flashLoanFee);
                }
            }
            catch (error) {
                console.error(`Error calculating output amount: ${error}`);
                continue;
            }
            // Skip if output amount is zero or less
            if (outputAmount.lte(0)) {
                continue;
            }
            // Add to path and continue searching
            visited.add(otherToken);
            currentPath.push(market);
            tokenPath.push(currentToken);
            await this.findPaths(otherToken, targetToken, currentPath, tokenPath, outputAmount, visited, opportunities, marketsByToken, maxPaths, depth + 1);
            // Backtrack
            visited.delete(otherToken);
            currentPath.pop();
            tokenPath.pop();
        }
    }
    async executeArbitrage(path, flashbotsProvider, executor, minerRewardPercentage, blocksApi) {
        // Prepare flash loan data
        const flashLoanAmount = ethers_1.BigNumber.from(10).pow(18); // 1 ETH
        const flashLoanToken = path.tokens[0];
        // Prepare trade data for each hop
        const tradeData = await this.prepareTradeData(path);
        // Calculate miner reward
        const minerReward = path.expectedProfit.mul(minerRewardPercentage).div(100);
        // Prepare flash loan repayment
        const repaymentAmount = flashLoanAmount.add(flashLoanAmount.mul(Math.floor(this.FLASH_LOAN_FEE * 10000)).div(10000));
        // Build the flash loan transaction
        const flashLoanTx = await this.flashLoanContract.populateTransaction.flashLoan(flashLoanToken, flashLoanAmount, executor.address, this.encodeBundleExecutorCalldata(tradeData, minerReward, repaymentAmount));
        // Get and adjust gas price
        const { currentGasPrice, avgGasPrice } = await getGasPriceInfo(flashbotsProvider);
        const competingBundlesGasPrices = await monitorCompetingBundlesGasPrices(blocksApi);
        let competingBundleGasPrice = ethers_1.BigNumber.from(0);
        for (const price of competingBundlesGasPrices) {
            const currentPrice = ethers_1.BigNumber.from(price);
            if (currentPrice.gt(competingBundleGasPrice)) {
                competingBundleGasPrice = currentPrice;
            }
        }
        const adjustedGasPrice = await this.adjustGasPriceForTransaction(currentGasPrice, avgGasPrice, competingBundleGasPrice);
        if (adjustedGasPrice.lte(currentGasPrice)) {
            throw new Error("Adjusted gas price is not higher than the current gas price");
        }
        // Calculate gas limit based on number of hops
        const baseGas = ethers_1.BigNumber.from(150000); // Base gas for flash loan
        const gasPerHop = ethers_1.BigNumber.from(100000); // Additional gas per hop
        const estimatedGas = baseGas.add(gasPerHop.mul(path.markets.length));
        // Update flash loan transaction with adjusted gas price
        flashLoanTx.gasPrice = adjustedGasPrice;
        flashLoanTx.gasLimit = estimatedGas;
        // Sign and submit the bundle
        const signedTransaction = await executor.signTransaction(flashLoanTx);
        const bundle = [{
                signedTransaction,
                signer: executor,
                gas: estimatedGas.toNumber(),
            }];
        const blockNumber = await this.provider.getBlockNumber();
        // Submit bundle with timing parameters
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const bundleSubmission = await flashbotsProvider.sendBundle(bundle, blockNumber + 1, {
            minTimestamp: currentTimestamp,
            maxTimestamp: currentTimestamp + 60, // 1 minute max validity
        });
        return bundleSubmission.bundleHash;
    }
    async prepareTradeData(path) {
        const tradeData = [];
        for (let i = 0; i < path.markets.length; i++) {
            const market = path.markets[i];
            const tokenIn = path.tokens[i];
            const tokenOut = path.tokens[i + 1];
            const amountIn = i === 0 ?
                ethers_1.BigNumber.from(10).pow(18) : // Initial flash loan amount
                await path.markets[i - 1].getTokensOut(path.tokens[i - 1], tokenIn, ethers_1.BigNumber.from(10).pow(18));
            const swapData = await market.sellTokens(tokenIn, amountIn, i === path.markets.length - 1 ? this.flashLoanContract.address : path.markets[i + 1].marketAddress);
            tradeData.push({
                target: market.marketAddress,
                data: swapData,
                value: ethers_1.BigNumber.from(0)
            });
        }
        return tradeData;
    }
    encodeBundleExecutorCalldata(tradeData, minerReward, repaymentAmount) {
        // Implementation depends on your bundle executor contract
        // This should encode the trades and miner payment into a single call
        const abiCoder = new ethers.utils.AbiCoder();
        return abiCoder.encode(['address[]', 'bytes[]', 'uint256', 'uint256'], [
            tradeData.map(t => t.target),
            tradeData.map(t => t.data),
            minerReward,
            repaymentAmount
        ]);
    }
}
exports.MultiHopArbitrage = MultiHopArbitrage;
