"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_THRESHOLDS = void 0;
const { ethers } = require("ethers");

exports.DEFAULT_THRESHOLDS = {
    // Set minimum liquidity to 2 ETH for more opportunities
    MIN_LIQUIDITY_ETH: ethers.utils.parseEther("2.0"),
    // Set minimum 24h volume to 0.5 ETH
    MIN_VOLUME_24H: ethers.utils.parseEther("0.5"),
    // Set minimum market cap to 25 ETH as requested
    MIN_MARKET_CAP: ethers.utils.parseEther("25.0"),
    // Set to a very high number to effectively remove the limit
    MAX_PAIRS: 1000000
};
