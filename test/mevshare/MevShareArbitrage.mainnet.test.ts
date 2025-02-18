import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Wallet, BigNumber } from "ethers";
import { MevShareArbitrage } from "../../src/MevShareArbitrage";
import { MockMevShareService } from "./MockMevShareService";
import { DEFAULT_THRESHOLDS } from "../../src/config/thresholds";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import UniswapV2EthPair from "../../src/UniswapV2EthPair";

// Real mainnet addresses
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// Uniswap V2 and Sushiswap factory addresses
const UNISWAP_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const SUSHISWAP_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";

describe("MevShareArbitrage Mainnet Fork", () => {
  let bundleExecutor: Contract;
  let owner: SignerWithAddress;
  let wallet: Wallet;
  let mevShareService: MockMevShareService;
  let arbitrage: MevShareArbitrage;
  let weth: Contract;
  let usdc: Contract;
  let dai: Contract;

  before(async () => {
    [owner] = await ethers.getSigners();
    
    // Connect to existing mainnet contracts
    weth = await ethers.getContractAt("WETH9", WETH);
    usdc = await ethers.getContractAt("IERC20", USDC);
    dai = await ethers.getContractAt("IERC20", DAI);

    // Deploy BundleExecutor
    const BundleExecutor = await ethers.getContractFactory("BundleExecutor");
    bundleExecutor = await BundleExecutor.deploy(WETH);
    await bundleExecutor.deployed();

    // Create test wallet with some ETH
    wallet = new ethers.Wallet(ethers.utils.randomBytes(32), ethers.provider);
    await owner.sendTransaction({
      to: wallet.address,
      value: ethers.utils.parseEther("10")
    });

    // Initialize MEV-Share service mock
    mevShareService = new MockMevShareService({
      authSigner: wallet,
      provider: ethers.provider,
      hintPreferences: {
        calldata: true,
        logs: true,
        function_selector: true,
        contracts: [WETH, USDC, DAI]
      }
    });

    // Initialize arbitrage instance
    arbitrage = new MevShareArbitrage(
      wallet,
      bundleExecutor,
      mevShareService as any,
      DEFAULT_THRESHOLDS
    );

    // Initialize real markets
    const { marketsByToken } = await UniswapV2EthPair.getUniswapMarketsByToken(
      ethers.provider,
      [UNISWAP_FACTORY, SUSHISWAP_FACTORY],
      UniswapV2EthPair.ImpactAndFeeFuncs
    );

    arbitrage.setMarkets(marketsByToken);
  });

  describe("Real DEX Arbitrage Detection", () => {
    it("should identify arbitrage opportunities between Uniswap and Sushiswap", async () => {
      // Create a real swap transaction on Uniswap V2
      const swapAmount = ethers.utils.parseEther("10"); // 10 ETH
      const mockTx = {
        hash: "0x" + "1".repeat(64),
        hints: {
          function_selector: "0x7ff36ab5", // swapExactETHForTokens
          calldata: ethers.utils.defaultAbiCoder.encode(
            ["uint256", "address[]", "address", "uint256"],
            [
              0, // minimum amount out
              [WETH, USDC], // path
              wallet.address,
              Math.floor(Date.now() / 1000) + 3600 // deadline
            ]
          ),
          contracts: [WETH, USDC]
        }
      };

      const processPromise = new Promise((resolve) => {
        arbitrage.on("arbitrageOpportunity", (opportunity) => {
          console.log("Found arbitrage opportunity:", {
            profitAmount: ethers.utils.formatEther(opportunity.profitAmount),
            tokenAddress: opportunity.tokenAddress,
            marketsCount: opportunity.markets.length
          });
          resolve(true);
        });
      });

      await mevShareService.emit("pendingTransaction", mockTx);
      await processPromise;
    });

    it("should identify arbitrage opportunities in multi-token paths", async () => {
      const mockTx = {
        hash: "0x" + "2".repeat(64),
        hints: {
          function_selector: "0x38ed1739", // swapExactTokensForTokens
          calldata: ethers.utils.defaultAbiCoder.encode(
            ["uint256", "uint256", "address[]", "address", "uint256"],
            [
              ethers.utils.parseUnits("1000", 6), // 1000 USDC
              0, // minimum amount out
              [USDC, WETH, DAI], // path
              wallet.address,
              Math.floor(Date.now() / 1000) + 3600 // deadline
            ]
          ),
          contracts: [USDC, WETH, DAI]
        }
      };

      const processPromise = new Promise((resolve) => {
        arbitrage.on("arbitrageOpportunity", (opportunity) => {
          console.log("Found multi-token arbitrage opportunity:", {
            profitAmount: ethers.utils.formatEther(opportunity.profitAmount),
            tokenAddress: opportunity.tokenAddress,
            marketsCount: opportunity.markets.length
          });
          resolve(true);
        });
      });

      await mevShareService.emit("pendingTransaction", mockTx);
      await processPromise;
    });

    it("should calculate accurate profit estimates using real reserves", async () => {
      // Get real reserves from Uniswap and Sushiswap
      const uniswapMarkets = await UniswapV2EthPair.getUniswapMarketsByToken(
        ethers.provider,
        [UNISWAP_FACTORY],
        UniswapV2EthPair.ImpactAndFeeFuncs
      );

      const sushiswapMarkets = await UniswapV2EthPair.getUniswapMarketsByToken(
        ethers.provider,
        [SUSHISWAP_FACTORY],
        UniswapV2EthPair.ImpactAndFeeFuncs
      );

      // Log real market states
      for (const [token, markets] of Object.entries(uniswapMarkets.marketsByToken)) {
        for (const market of markets) {
          const reserves = await Promise.all([
            market.getReserves(market.tokens[0]),
            market.getReserves(market.tokens[1])
          ]);
          console.log(`Market ${market.marketAddress} reserves:`, {
            token0: market.tokens[0],
            token1: market.tokens[1],
            reserve0: ethers.utils.formatEther(reserves[0]),
            reserve1: ethers.utils.formatEther(reserves[1])
          });
        }
      }

      // Create a mock transaction that should trigger arbitrage calculation
      const mockTx = {
        hash: "0x" + "3".repeat(64),
        hints: {
          function_selector: "0x7ff36ab5", // swapExactETHForTokens
          calldata: ethers.utils.defaultAbiCoder.encode(
            ["uint256", "address[]", "address", "uint256"],
            [
              0,
              [WETH, USDC],
              wallet.address,
              Math.floor(Date.now() / 1000) + 3600
            ]
          ),
          contracts: [WETH, USDC]
        }
      };

      const processPromise = new Promise((resolve) => {
        arbitrage.on("arbitrageOpportunity", (opportunity) => {
          console.log("Found arbitrage opportunity with real reserves:", {
            profitAmount: ethers.utils.formatEther(opportunity.profitAmount),
            tokenAddress: opportunity.tokenAddress,
            marketsCount: opportunity.markets.length
          });
          expect(opportunity.profitAmount).to.be.gt(0);
          resolve(true);
        });
      });

      await mevShareService.emit("pendingTransaction", mockTx);
      await processPromise;
    });
  });
}); 