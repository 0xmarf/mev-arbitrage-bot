class TestLogger {
  private static formatMessage(type: string, data: any): string {
    return `[${type}] ${JSON.stringify(data, null, 2)}`;
  }

  marketUpdate(market: any) {
    console.log(TestLogger.formatMessage('MARKET_UPDATE', {
      market: {
        address: market.address,
        token0: market.token0,
        token1: market.token1,
        reserves0: market.reserves0?.toString(),
        reserves1: market.reserves1?.toString(),
        isActive: true,
        lastUpdate: new Date().toISOString()
      }
    }));
  }

  transaction(hash: string, transactionType: string, status: string, profit?: string) {
    console.log(TestLogger.formatMessage('TRANSACTION', {
      hash,
      transactionType,
      status,
      profit
    }));
  }

  error(error: Error, context?: any) {
    console.error(TestLogger.formatMessage('ERROR', {
      message: error.message,
      stack: error.stack,
      context
    }));
  }

  info(message: string, data?: any) {
    console.log(TestLogger.formatMessage('INFO', {
      message,
      data
    }));
  }

  close() {
    // No-op for test logger
  }
}

const logger = new TestLogger();
export default logger; 