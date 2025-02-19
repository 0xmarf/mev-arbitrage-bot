

# 🚀 Simple Arbitrage Bot with Flashbots Integration

A mechanical system for discovering, evaluating, and executing arbitrage opportunities on Ethereum using Flashbots bundles. While this implementation may not be immediately profitable due to its public nature, it serves as an excellent educational resource for understanding Flashbots integration.

## 📋 Prerequisites

- Node.js and npm installed
- Access to an Ethereum RPC endpoint
- Basic understanding of DeFi and arbitrage concepts

## 🔑 Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `ETHEREUM_RPC_URL` | Ethereum RPC endpoint (different from Flashbots RPC) | Yes | - |
| `PRIVATE_KEY` | Private key for transaction submission | Yes | - |
| `FLASHBOTS_RELAY_SIGNING_KEY` | Key for signing Flashbots payloads | No | Random key |
| `HEALTHCHECK_URL` | URL for monitoring successful bundle submissions | No | - |
| `MINER_REWARD_PERCENTAGE` | Percentage of profits allocated to miners (0-100) | No | 80 |

## 🛠 Setup Instructions

1. Generate a new bot wallet and extract the private key:
```bash
# Example using ethers.js
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
```

2. Deploy the `BundleExecutor.sol` contract:
   - Use a secure account for deployment
   - Pass the new bot wallet address as a constructor argument

3. Fund the deployed `BundleExecutor` with WETH

## ⚡ Quick Start

1. Install dependencies:
```bash
npm install
```

2. Start the bot:
```bash
PRIVATE_KEY=your_private_key \
BUNDLE_EXECUTOR_ADDRESS=your_deployed_address \
FLASHBOTS_RELAY_SIGNING_KEY=your_signing_key \
npm run start
```

## ⚠️ Security Considerations

- Keep both the bot wallet and `BundleExecutor` owner private keys secure
- While the contract includes safety measures, unauthorized access to private keys could result in fund loss
- Regularly monitor the contract's WETH balance and activity

## 📚 Additional Resources

- [Flashbots Searcher FAQ](https://docs.flashbots.net/flashbots-auction/searchers/faq)
- [Flashbots Documentation](https://docs.flashbots.net/)
- [MEV Documentation](https://ethereum.org/en/developers/docs/mev/)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

*Note: This is an educational tool and should not be considered production-ready without additional security reviews and optimizations.*
