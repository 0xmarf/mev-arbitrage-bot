import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Wallet, BigNumber } from "ethers";
import { MevShareArbitrage } from "../../src/MevShareArbitrage";
import { MevShareService } from "../../src/services/MevShareService";
import { DEFAULT_THRESHOLDS } from "../../src/config/thresholds";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { MockMarket } from "./MockMarket";

describe("MevShareArbitrage", () => {
  let bundleExecutor: Contract;
  let owner: SignerWithAddress;
  let wallet: Wallet;
  let mevShareService: MevShareService;
  let arbitrage: MevShareArbitrage;
  let weth: Contract;
  let token0: Contract;
  let token1: Contract;
  let mockMarket1: MockMarket;
  let mockMarket2: MockMarket;

  beforeEach(async () => {
    [owner] = await ethers.getSigners();
    
    // Deploy test tokens
    const TestToken = await ethers.getContractFactory("TestToken");
    token0 = await TestToken.deploy();
    token1 = await TestToken.deploy();
    await token0.deployed();
    await token1.deployed();
    
    // Deploy WETH mock
    const WETHMock = await ethers.getContractFactory("WETH9");
    weth = await WETHMock.deploy();
    await weth.deployed();

    // Deploy BundleExecutor
    const BundleExecutor = await ethers.getContractFactory("BundleExecutor");
    bundleExecutor = await BundleExecutor.deploy(weth.address);
    await bundleExecutor.deployed();

    // Create test wallet
    wallet = new ethers.Wallet(ethers.utils.randomBytes(32), ethers.provider);
    
    // Fund the wallet with ETH
    await owner.sendTransaction({
      to: wallet.address,
      value: ethers.utils.parseEther("10")
    });

    // Initialize MEV-Share service
    mevShareService = new MevShareService({
      authSigner: wallet,
      provider: ethers.provider,
      hintPreferences: {
        calldata: true,
        logs: true,
        function_selector: true,
        contracts: [token0.address, token1.address, weth.address]
      }
    });

    // Initialize arbitrage instance
    arbitrage = new MevShareArbitrage(
      wallet,
      bundleExecutor,
      mevShareService,
      DEFAULT_THRESHOLDS
    );

    // Deploy Uniswap V2 pairs for testing
    const UniswapV2Pair = await ethers.getContractFactory("UniswapV2Pair");
    const pair1 = await UniswapV2Pair.deploy();
    const pair2 = await UniswapV2Pair.deploy();
    await pair1.deployed();
    await pair2.deployed();

    // Initialize mock markets
    mockMarket1 = new MockMarket(
      pair1.address,
      [token0.address, token1.address],
      "Uniswap V2",
      pair1
    );

    mockMarket2 = new MockMarket(
      pair2.address,
      [token0.address, weth.address],
      "Uniswap V2",
      pair2
    );

    // Set initial reserves
    await mockMarket1.setReserves(
      ethers.utils.parseEther("100"),
      ethers.utils.parseEther("200")
    );
    await mockMarket2.setReserves(
      ethers.utils.parseEther("100"),
      ethers.utils.parseEther("150")
    );
  });

  describe("MEV-Share Transaction Processing", () => {
    it("should identify and process swap transactions", async () => {
      const mockMarkets = {
        [token0.address]: [mockMarket1, mockMarket2]
      };
      arbitrage.setMarkets(mockMarkets);

      const swapAmount = ethers.utils.parseEther("1");
      const mockTx = {
        hash: "0x123",
        hints: {
          function_selector: "0x38ed1739", // swapExactTokensForTokens
          calldata: ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "address[]", "address", "uint256"],
            [
              swapAmount,
              0,
              [token0.address, token1.address],
              wallet.address,
              Math.floor(Date.now() / 1000) + 3600
            ]
          ),
          contracts: [token0.address, token1.address]
        }
      };

      const processPromise = new Promise((resolve) => {
        arbitrage.on("arbitrageOpportunity", (opportunity) => {
          expect(opportunity.profitAmount).to.be.gt(0);
          expect(opportunity.markets).to.have.lengthOf(2);
          resolve(true);
        });
      });

      await mevShareService.emit("pendingTransaction", mockTx);
      await processPromise;
    });

    it("should handle multi-hop swaps", async () => {
      const mockMarkets = {
        [token0.address]: [mockMarket1],
        [token1.address]: [mockMarket2]
      };
      arbitrage.setMarkets(mockMarkets);

      const swapAmount = ethers.utils.parseEther("1");
      const mockTx = {
        hash: "0x123",
        hints: {
          function_selector: "0x38ed1739",
          calldata: ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "address[]", "address", "uint256"],
            [
              swapAmount,
              0,
              [token0.address, token1.address, weth.address],
              wallet.address,
              Math.floor(Date.now() / 1000) + 3600
            ]
          ),
          contracts: [token0.address, token1.address, weth.address]
        }
      };

      const processPromise = new Promise((resolve) => {
        arbitrage.on("arbitrageOpportunity", (opportunity) => {
          expect(opportunity.profitAmount).to.be.gt(0);
          expect(opportunity.markets).to.have.lengthOf(3);
          resolve(true);
        });
      });

      await mevShareService.emit("pendingTransaction", mockTx);
      await processPromise;
    });

    it("should calculate correct profit for arbitrage opportunities", async () => {
      const mockMarkets = {
        [token0.address]: [mockMarket1, mockMarket2]
      };
      arbitrage.setMarkets(mockMarkets);

      // Create price discrepancy between markets
      await mockMarket1.setReserves(
        ethers.utils.parseEther("100"),
        ethers.utils.parseEther("200")
      );
      await mockMarket2.setReserves(
        ethers.utils.parseEther("100"),
        ethers.utils.parseEther("180")
      );

      const swapAmount = ethers.utils.parseEther("1");
      const mockTx = {
        hash: "0x123",
        hints: {
          function_selector: "0x38ed1739",
          calldata: ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "address[]", "address", "uint256"],
            [
              swapAmount,
              0,
              [token0.address, token1.address],
              wallet.address,
              Math.floor(Date.now() / 1000) + 3600
            ]
          ),
          contracts: [token0.address, token1.address]
        }
      };

      const processPromise = new Promise((resolve) => {
        arbitrage.on("arbitrageOpportunity", (opportunity) => {
          const expectedMinProfit = ethers.utils.parseEther("0.01"); // 0.01 ETH
          expect(opportunity.profitAmount).to.be.gt(expectedMinProfit);
          resolve(true);
        });
      });

      await mevShareService.emit("pendingTransaction", mockTx);
      await processPromise;
    });

    it("should ignore transactions with insufficient profit", async () => {
      const mockMarkets = {
        [token0.address]: [mockMarket1, mockMarket2]
      };
      arbitrage.setMarkets(mockMarkets);

      // Set reserves with minimal price difference
      await mockMarket1.setReserves(
        ethers.utils.parseEther("100"),
        ethers.utils.parseEther("200")
      );
      await mockMarket2.setReserves(
        ethers.utils.parseEther("100"),
        ethers.utils.parseEther("199.9")
      );

      const swapAmount = ethers.utils.parseEther("0.1");
      const mockTx = {
        hash: "0x123",
        hints: {
          function_selector: "0x38ed1739",
          calldata: ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "address[]", "address", "uint256"],
            [
              swapAmount,
              0,
              [token0.address, token1.address],
              wallet.address,
              Math.floor(Date.now() / 1000) + 3600
            ]
          ),
          contracts: [token0.address, token1.address]
        }
      };

      let opportunityFound = false;
      arbitrage.on("arbitrageOpportunity", () => {
        opportunityFound = true;
      });

      await mevShareService.emit("pendingTransaction", mockTx);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(opportunityFound).to.be.false;
    });
  });
}); 