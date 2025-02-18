const { expect } = require("chai");
const { ethers } = require("hardhat");
const { WETH_ADDRESS } = require("../src/addresses");
const UniswapV2EthPair = require("../src/UniswapV2EthPair").default;
const { Arbitrage, calculateOptimalVolume } = require("../src/Arbitrage");
const { BigNumber } = require("ethers");

describe("Testnet Arbitrage", function() {
    let bundleExecutor;
    let owner;
    let weth;
    let token;
    let uniswapFactory;
    let sushiswapFactory;
    let uniswapPair;
    let sushiswapPair;
    let initialWethBalance;
    let initialTokenBalance;

    // Increase timeout for testnet operations
    this.timeout(60000);

    before(async function() {
        // Get signers
        [owner] = await ethers.getSigners();

        // Deploy test ERC20 token
        const TestToken = await ethers.getContractFactory("TestToken");
        token = await TestToken.deploy("Test Token", "TEST", ethers.utils.parseEther("1000000"));
        await token.deployed();

        // Deploy WETH if on testnet
        const WETH9 = await ethers.getContractFactory("WETH9");
        weth = await WETH9.deploy();
        await weth.deployed();

        // Deploy Uniswap and Sushiswap factories and routers
        const UniswapV2Factory = await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory");
        uniswapFactory = await UniswapV2Factory.deploy(owner.address);
        await uniswapFactory.deployed();

        sushiswapFactory = await UniswapV2Factory.deploy(owner.address);
        await sushiswapFactory.deployed();

        // Create pairs
        await uniswapFactory.createPair(weth.address, token.address);
        await sushiswapFactory.createPair(weth.address, token.address);

        const uniswapPairAddress = await uniswapFactory.getPair(weth.address, token.address);
        const sushiswapPairAddress = await sushiswapFactory.getPair(weth.address, token.address);

        // Get the pair contracts
        const UniswapV2Pair = await ethers.getContractFactory("UniswapV2Pair");
        uniswapPair = await UniswapV2Pair.attach(uniswapPairAddress);
        sushiswapPair = await UniswapV2Pair.attach(sushiswapPairAddress);

        // Deploy BundleExecutor
        const BundleExecutor = await ethers.getContractFactory("BundleExecutor");
        bundleExecutor = await BundleExecutor.deploy(weth.address);
        await bundleExecutor.deployed();

        // Store initial balances
        initialWethBalance = ethers.utils.parseEther("10");
        initialTokenBalance = ethers.utils.parseEther("10");

        // Get some WETH first
        await weth.deposit({ value: initialWethBalance });

        // Approve tokens for BundleExecutor
        await weth.approve(bundleExecutor.address, ethers.constants.MaxUint256);
        await token.approve(bundleExecutor.address, ethers.constants.MaxUint256);
        await token.approve(uniswapPair.address, ethers.constants.MaxUint256);
        await token.approve(sushiswapPair.address, ethers.constants.MaxUint256);

        // Send initial balance to BundleExecutor
        await weth.transfer(bundleExecutor.address, ethers.utils.parseEther("2"));
        await token.transfer(bundleExecutor.address, ethers.utils.parseEther("2"));
    });

    describe("Setup and Initialization", function() {
        it("Should verify initial contract deployment", async function() {
            expect(await bundleExecutor.WETH()).to.equal(weth.address);
            expect(await uniswapPair.factory()).to.equal(uniswapFactory.address);
            expect(await sushiswapPair.factory()).to.equal(sushiswapFactory.address);
        });

        it("Should verify initial token approvals", async function() {
            const wethAllowance = await weth.allowance(owner.address, bundleExecutor.address);
            const tokenAllowance = await token.allowance(owner.address, bundleExecutor.address);
            expect(wethAllowance).to.equal(ethers.constants.MaxUint256);
            expect(tokenAllowance).to.equal(ethers.constants.MaxUint256);
        });

        it("Should verify initial balances", async function() {
            const bundleWethBalance = await weth.balanceOf(bundleExecutor.address);
            const bundleTokenBalance = await token.balanceOf(bundleExecutor.address);
            expect(bundleWethBalance).to.be.gt(0);
            expect(bundleTokenBalance).to.be.gt(0);
        });
    });

    describe("Liquidity Setup", function() {
        it("Should setup initial liquidity with price difference", async function() {
            // Get some WETH
            await weth.deposit({ value: ethers.utils.parseEther("3000") });
            
            // Setup Uniswap liquidity
            const uniWethAmount = ethers.utils.parseEther("1000");
            const uniTokenAmount = ethers.utils.parseEther("1000");
            
            await token.transfer(uniswapPair.address, uniTokenAmount);
            await weth.transfer(uniswapPair.address, uniWethAmount);
            await uniswapPair.mint(owner.address);

            // Setup Sushiswap liquidity with different ratio
            const sushiWethAmount = ethers.utils.parseEther("2000");
            const sushiTokenAmount = ethers.utils.parseEther("1000");
            
            await token.transfer(sushiswapPair.address, sushiTokenAmount);
            await weth.transfer(sushiswapPair.address, sushiWethAmount);
            await sushiswapPair.mint(owner.address);

            // Sync reserves
            await uniswapPair.sync();
            await sushiswapPair.sync();

            // Verify reserves
            const [uniReserve0, uniReserve1] = await uniswapPair.getReserves();
            const [sushiReserve0, sushiReserve1] = await sushiswapPair.getReserves();

            expect(uniReserve0).to.be.gt(0);
            expect(uniReserve1).to.be.gt(0);
            expect(sushiReserve0).to.be.gt(0);
            expect(sushiReserve1).to.be.gt(0);

            // Verify price difference
            const uniPrice = uniReserve0.mul(ethers.constants.WeiPerEther).div(uniReserve1);
            const sushiPrice = sushiReserve0.mul(ethers.constants.WeiPerEther).div(sushiReserve1);
            expect(uniPrice).to.not.equal(sushiPrice);
        });

        it("Should verify K invariant after liquidity setup", async function() {
            const [uniReserve0, uniReserve1] = await uniswapPair.getReserves();
            const [sushiReserve0, sushiReserve1] = await sushiswapPair.getReserves();

            const uniK = uniReserve0.mul(uniReserve1);
            const sushiK = sushiReserve0.mul(sushiReserve1);

            expect(uniK).to.be.gt(0);
            expect(sushiK).to.be.gt(0);
        });
    });

    describe("Flash Swap Execution", function() {
        it("Should calculate optimal flash swap volume", async function() {
            const [reserve0, reserve1] = await uniswapPair.getReserves();
            const token0 = await uniswapPair.token0();
            const isWethToken0 = token0.toLowerCase() === weth.address.toLowerCase();
            
            // Use 0.1% of reserves for testing
            const baseReserve = isWethToken0 ? reserve0 : reserve1;
            const volume = baseReserve.mul(1).div(1000);
            
            expect(volume).to.be.gt(0);
            expect(volume).to.be.lt(baseReserve);
        });

        it("Should execute arbitrage bundle with proper error handling", async function() {
            // Setup approvals
            await token.approve(uniswapPair.address, ethers.constants.MaxUint256);
            await token.approve(sushiswapPair.address, ethers.constants.MaxUint256);
            await token.approve(bundleExecutor.address, ethers.constants.MaxUint256);
            await weth.approve(uniswapPair.address, ethers.constants.MaxUint256);
            await weth.approve(sushiswapPair.address, ethers.constants.MaxUint256);
            await weth.approve(bundleExecutor.address, ethers.constants.MaxUint256);

            // Get initial balances
            const initialWethBalance = await weth.balanceOf(bundleExecutor.address);
            const initialTokenBalance = await token.balanceOf(bundleExecutor.address);

            // Calculate flash swap parameters
            const [reserve0, reserve1] = await uniswapPair.getReserves();
            const token0 = await uniswapPair.token0();
            const isWethToken0 = token0.toLowerCase() === weth.address.toLowerCase();
            
            const baseReserve = isWethToken0 ? reserve0 : reserve1;
            const borrowAmount = baseReserve.mul(1).div(1000);
            const repayAmount = borrowAmount.mul(1000).div(997).add(1);

            // Calculate expected output from Sushiswap
            const [sushiReserve0, sushiReserve1] = await sushiswapPair.getReserves();
            const sushiReserveIn = isWethToken0 ? sushiReserve1 : sushiReserve0;
            const sushiReserveOut = isWethToken0 ? sushiReserve0 : sushiReserve1;
            const sushiAmountInWithFee = borrowAmount.mul(997);
            const numerator = sushiAmountInWithFee.mul(sushiReserveOut);
            const denominator = sushiReserveIn.mul(1000).add(sushiAmountInWithFee);
            const expectedOutput = numerator.div(denominator);
            const safeExpectedOutput = expectedOutput.mul(99).div(100);

            // Verify the trade would be profitable
            expect(safeExpectedOutput).to.be.gt(repayAmount);

            // Execute flash swap
            const flashSwapPayload = uniswapPair.interface.encodeFunctionData("swap", [
                isWethToken0 ? borrowAmount : 0,
                isWethToken0 ? 0 : borrowAmount,
                bundleExecutor.address,
                ethers.utils.defaultAbiCoder.encode(
                    ['uint256', 'uint256', 'address'],
                    [repayAmount, safeExpectedOutput, sushiswapPair.address]
                )
            ]);

            try {
                const tx = await bundleExecutor.executeOperation(
                    [uniswapPair.address],
                    [flashSwapPayload],
                    [false],
                    [0],
                    { gasPrice: ethers.utils.parseEther("0.000000002"), gasLimit: 1000000 }
                );
                
                const receipt = await tx.wait();
                expect(receipt.status).to.equal(1);

                // Verify final balances
                const finalWethBalance = await weth.balanceOf(bundleExecutor.address);
                const finalTokenBalance = await token.balanceOf(bundleExecutor.address);

                // Check for profit
                const profit = finalWethBalance.sub(initialWethBalance);
                expect(profit).to.be.gt(0);

            } catch (error) {
                console.error("Flash swap execution failed:", error);
                throw error;
            }
        });
    });

    describe("Edge Cases and Error Handling", function() {
        it("Should handle zero amount flash swaps", async function() {
            const flashSwapPayload = uniswapPair.interface.encodeFunctionData("swap", [
                0, 0, bundleExecutor.address,
                ethers.utils.defaultAbiCoder.encode(
                    ['uint256', 'uint256', 'address'],
                    [0, 0, sushiswapPair.address]
                )
            ]);

            await expect(
                bundleExecutor.executeOperation(
                    [uniswapPair.address],
                    [flashSwapPayload],
                    [false],
                    [0]
                )
            ).to.be.revertedWith("Insufficient tokens received");
        });

        it("Should handle invalid target addresses", async function() {
            await expect(
                bundleExecutor.executeOperation(
                    [ethers.constants.AddressZero],
                    ["0x"],
                    [false],
                    [0]
                )
            ).to.be.reverted;
        });

        it("Should verify K invariant is maintained after swaps", async function() {
            const [initialReserve0, initialReserve1] = await uniswapPair.getReserves();
            const initialK = initialReserve0.mul(initialReserve1);

            // Execute a small swap
            const token0 = await uniswapPair.token0();
            const isWethToken0 = token0.toLowerCase() === weth.address.toLowerCase();
            const smallAmount = ethers.utils.parseEther("0.1");

            await weth.deposit({ value: smallAmount });
            await weth.transfer(uniswapPair.address, smallAmount);
            await uniswapPair.swap(
                isWethToken0 ? 0 : smallAmount.div(2),
                isWethToken0 ? smallAmount.div(2) : 0,
                owner.address,
                "0x"
            );

            const [finalReserve0, finalReserve1] = await uniswapPair.getReserves();
            const finalK = finalReserve0.mul(finalReserve1);

            // K should not decrease (it might increase slightly due to fees)
            expect(finalK).to.be.gte(initialK);
        });
    });
}); 