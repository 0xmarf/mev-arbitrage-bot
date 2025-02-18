#!/bin/bash

# Compile contracts
echo "Compiling contracts..."
NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx hardhat compile

# Run MEV-Share tests
echo "Running MEV-Share mainnet fork tests..."
NODE_ENV=test NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx hardhat test test/mevshare/MevShareArbitrage.mainnet.test.ts --network hardhat 