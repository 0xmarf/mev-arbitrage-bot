import { EventEmitter } from 'events';
import { providers, Wallet } from 'ethers';

export interface IMevShareConfig {
  authSigner: Wallet;
  provider: providers.JsonRpcProvider;
  hintPreferences?: {
    calldata?: boolean;
    logs?: boolean;
    function_selector?: boolean;
    contracts?: string[];
  };
}

export class MockMevShareService extends EventEmitter {
  private isConnected: boolean = false;
  private config: IMevShareConfig;

  constructor(config: IMevShareConfig) {
    super();
    this.config = config;
  }

  public async connect(): Promise<void> {
    this.isConnected = true;
  }

  public async sendBundle(bundle: any): Promise<string> {
    if (!this.isConnected) {
      throw new Error('Not connected to MEV-Share');
    }

    // For testing, just return a mock bundle hash
    return '0x' + '1'.repeat(64);
  }

  public async stop(): Promise<void> {
    this.isConnected = false;
  }
} 