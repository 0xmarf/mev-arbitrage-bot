import { BigNumber } from 'ethers';

export interface Config {
    DEX_ADDRESSES: string[];
    TRANSFER_TOPIC: string;
    SWAP_TOPIC: string;
    GAS_SETTINGS: {
        MAX_GAS_PRICE: BigNumber;
        MIN_PROFIT_MULTIPLIER: number;
        PRIORITY_GAS_PRICE: BigNumber;
    };
    NETWORK: {
        CHAIN_ID: number;
        BLOCK_TIME: number;
        MAX_BLOCKS_TO_WAIT: number;
    };
}

export const DEFAULT_CONFIG: Config = {
    DEX_ADDRESSES: [
        '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
        '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'  // Sushiswap Router
    ],
    TRANSFER_TOPIC: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    SWAP_TOPIC: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
    GAS_SETTINGS: {
        MAX_GAS_PRICE: BigNumber.from('500000000000'), // 500 gwei
        MIN_PROFIT_MULTIPLIER: 1.1, // 10% minimum profit after gas
        PRIORITY_GAS_PRICE: BigNumber.from('2000000000') // 2 gwei
    },
    NETWORK: {
        CHAIN_ID: 1, // Ethereum mainnet
        BLOCK_TIME: 12, // seconds
        MAX_BLOCKS_TO_WAIT: 2
    }
}; 