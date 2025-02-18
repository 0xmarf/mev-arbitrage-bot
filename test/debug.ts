import { HardhatRuntimeEnvironment } from 'hardhat/types';
import * as hre from 'hardhat';
import { JsonRpcProvider } from '@ethersproject/providers';
import { UniswapV2EthPair } from "../src/UniswapV2EthPair";
import { logInfo, logError } from '../src/utils/logger';

async function main() {
  const provider = new JsonRpcProvider('https://eth-mainnet.g.alchemy.com/v2/jpWIUdqC9uBZm_8nb1t0hgYf9jCbh3Wi');
  const factoryAddresses = ['0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'];

  try {
    const markets = await UniswapV2EthPair.getUniswapMarketsByToken(provider, factoryAddresses, UniswapV2EthPair.impactAndFeeFuncs);
    logInfo("Markets retrieved successfully", {
      totalMarkets: Object.values(markets.marketsByToken).flat().length,
      totalTokens: Object.keys(markets.marketsByToken).length
    });
  } catch (error) {
    logError("Error retrieving markets", {
      error: error instanceof Error ? error : new Error(String(error))
    });
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    logError("Fatal error in debug script", {
      error: error instanceof Error ? error : new Error(String(error))
    });
    process.exit(1);
  });