import { Contract, providers, utils, BigNumber } from 'ethers';
import logger from '../utils/logger';

// Multicall2 ABI - only the methods we need
const MULTICALL2_ABI = [
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) public view returns (tuple(bool success, bytes returnData)[])'
];

// Standard ERC20 methods we'll be calling
const TOKEN_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)'
];

export interface MulticallRequest {
  target: string;
  interface: utils.Interface;
  methodName: string;
  params: any[];
}

export class MulticallService {
  private multicallContract: Contract;
  private readonly MULTICALL2_ADDRESS = '0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696'; // Ethereum Mainnet
  private readonly BATCH_SIZE = 500; // Maximum number of calls to batch together

  constructor(provider: providers.Provider) {
    this.multicallContract = new Contract(
      this.MULTICALL2_ADDRESS,
      MULTICALL2_ABI,
      provider
    );
  }

  private chunkCalls(calls: MulticallRequest[]): MulticallRequest[][] {
    const chunks: MulticallRequest[][] = [];
    for (let i = 0; i < calls.length; i += this.BATCH_SIZE) {
      chunks.push(calls.slice(i, i + this.BATCH_SIZE));
    }
    return chunks;
  }

  public async multicall(requests: MulticallRequest[]): Promise<(any[] | null)[]> {
    try {
      const chunks = this.chunkCalls(requests);
      const allResults: (any[] | null)[] = [];

      for (const chunk of chunks) {
        const callData = chunk.map(req => ({
          target: req.target,
          callData: req.interface.encodeFunctionData(req.methodName, req.params)
        }));

        const results = await this.multicallContract.tryAggregate(false, callData);

        for (let i = 0; i < results.length; i++) {
          const [success, returnData] = results[i];
          if (!success) {
            allResults.push(null);
            continue;
          }

          try {
            const decodedResult = chunk[i].interface.decodeFunctionResult(
              chunk[i].methodName,
              returnData
            );
            allResults.push(Array.isArray(decodedResult) ? decodedResult : [decodedResult]);
          } catch (error) {
            logger.error('Error decoding multicall result', { error: error as Error });
            allResults.push(null);
          }
        }
      }

      return allResults;
    } catch (error) {
      logger.error('Multicall failed', { error: error as Error });
      throw error;
    }
  }

  public async getTokenData(tokenAddresses: string[]): Promise<Map<string, { balance: BigNumber, totalSupply: BigNumber } | null>> {
    const requests: MulticallRequest[] = [];
    const tokenInterface = new utils.Interface(TOKEN_ABI);

    for (const address of tokenAddresses) {
      // Add balanceOf call
      requests.push({
        target: address,
        interface: tokenInterface,
        methodName: 'balanceOf',
        params: [this.MULTICALL2_ADDRESS]
      });

      // Add totalSupply call
      requests.push({
        target: address,
        interface: tokenInterface,
        methodName: 'totalSupply',
        params: []
      });
    }

    const results = await this.multicall(requests);
    const tokenData = new Map();

    for (let i = 0; i < tokenAddresses.length; i++) {
      const balanceResult = results[i * 2];
      const supplyResult = results[i * 2 + 1];

      if (!balanceResult || !supplyResult) {
        tokenData.set(tokenAddresses[i], null);
        continue;
      }

      tokenData.set(tokenAddresses[i], {
        balance: balanceResult[0],
        totalSupply: supplyResult[0]
      });
    }

    return tokenData;
  }
} 