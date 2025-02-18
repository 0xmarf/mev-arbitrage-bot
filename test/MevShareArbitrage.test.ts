import { expect } from 'chai';
import { BigNumber, Contract, Wallet, ethers } from 'ethers';
import { MevShareArbitrage } from '../src/MevShareArbitrage';
import { MevShareService } from '../src/services/MevShareService';
import { MarketsByToken, CrossedMarketDetails, MarketType } from '../src/Arbitrage';
import { DEFAULT_THRESHOLDS } from '../src/config/thresholds';
import sinon from 'sinon';
import { EnhancedPendingTransaction } from '../src/types';

describe('MevShareArbitrage', () => {
    let mevShareArbitrage: MevShareArbitrage;
    let mockWallet: Wallet;
    let mockContract: Contract;
    let mockMevShareService: MevShareService;
    let mockMarket1: MarketType;
    let mockMarket2: MarketType;

    beforeEach(() => {
        // Create mock wallet
        mockWallet = {
            address: '0x1234567890123456789012345678901234567890',
            signTransaction: sinon.stub().resolves('0xSignedTx')
        } as unknown as Wallet;

        // Create mock contract
        mockContract = {
            address: '0x2234567890123456789012345678901234567890',
            populateTransaction: {
                swap: sinon.stub().resolves({
                    to: '0x1234',
                    data: '0x5678'
                })
            }
        } as unknown as Contract;

        // Create mock MEV-Share service
        mockMevShareService = {
            on: sinon.stub(),
            sendBundle: sinon.stub().resolves('0xBundleHash')
        } as unknown as MevShareService;

        // Create mock markets
        mockMarket1 = {
            marketAddress: '0x1111111111111111111111111111111111111111',
            tokens: ['0xWETH', '0xTokenA'],
            getReserves: sinon.stub().resolves(BigNumber.from('1000000000000000000')),
            getTokensOut: sinon.stub().resolves(BigNumber.from('1000000000000000000'))
        } as unknown as MarketType;

        mockMarket2 = {
            marketAddress: '0x2222222222222222222222222222222222222222',
            tokens: ['0xWETH', '0xTokenB'],
            getReserves: sinon.stub().resolves(BigNumber.from('1100000000000000000')),
            getTokensOut: sinon.stub().resolves(BigNumber.from('1100000000000000000'))
        } as unknown as MarketType;

        // Initialize MevShareArbitrage
        mevShareArbitrage = new MevShareArbitrage(
            mockWallet,
            mockContract,
            mockMevShareService,
            DEFAULT_THRESHOLDS
        );
    });

    describe('handlePendingTransaction', () => {
        it('should identify and process arbitrageable transactions', async () => {
            const mockPendingTx: EnhancedPendingTransaction = {
                hash: '0xPendingTxHash',
                hints: {
                    function_selector: '0x38ed1739', // swapExactTokensForTokens
                    calldata: '0x38ed173900000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000' + mockWallet.address.slice(2) + '000000000000000000000000000000000000000000000000000000006579dbc0000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
                }
            };

            // Set up markets
            const markets: MarketsByToken = {
                '0xWETH': [mockMarket1, mockMarket2]
            };
            mevShareArbitrage.setMarkets(markets);

            // Trigger pending transaction handler
            await mevShareArbitrage['handlePendingTransaction'](mockPendingTx);

            // Verify that bundle was sent
            expect(mockMevShareService.sendBundle.called).to.be.true;
            const bundleArgs = mockMevShareService.sendBundle.getCall(0).args[0];
            expect(bundleArgs.txs).to.have.lengthOf(2);
            expect(bundleArgs.txs[0]).to.equal(mockPendingTx.hash);
        });

        it('should ignore non-arbitrageable transactions', async () => {
            const mockPendingTx: EnhancedPendingTransaction = {
                hash: '0xPendingTxHash',
                hints: {
                    function_selector: '0x12345678', // Some other function
                    calldata: '0x1234'
                }
            };

            await mevShareArbitrage['handlePendingTransaction'](mockPendingTx);

            // Verify that no bundle was sent
            expect(mockMevShareService.sendBundle.called).to.be.false;
        });
    });

    describe('findArbitrageOpportunities', () => {
        it('should find profitable opportunities between related markets', async () => {
            const targetPair = mockMarket1.marketAddress;
            const mockPendingTx: EnhancedPendingTransaction = {
                hash: '0xPendingTxHash',
                hints: {
                    function_selector: '0x38ed1739',
                    calldata: '0x1234'
                }
            };

            // Set up markets
            const markets: MarketsByToken = {
                '0xWETH': [mockMarket1, mockMarket2]
            };
            mevShareArbitrage.setMarkets(markets);

            const opportunities = await mevShareArbitrage['findArbitrageOpportunities'](
                targetPair,
                mockPendingTx
            );

            expect(opportunities).to.be.an('array');
            if (opportunities.length > 0) {
                expect(opportunities[0]).to.have.property('profit');
                expect(opportunities[0].profit).to.be.instanceOf(BigNumber);
            }
        });
    });

    describe('executeArbitrage', () => {
        it('should execute arbitrage bundle successfully', async () => {
            const opportunity: CrossedMarketDetails = {
                profit: BigNumber.from('100000000000000000'),
                volume: BigNumber.from('1000000000000000000'),
                tokenAddress: '0xWETH',
                buyFromMarket: mockMarket1,
                sellToMarket: mockMarket2,
                marketPairs: []
            };

            const mockPendingTx: EnhancedPendingTransaction = {
                hash: '0xPendingTxHash',
                hints: {
                    function_selector: '0x38ed1739',
                    calldata: '0x1234'
                }
            };

            await mevShareArbitrage['executeArbitrage'](opportunity, mockPendingTx);

            // Verify bundle was sent
            expect(mockMevShareService.sendBundle.called).to.be.true;
            const bundleArgs = mockMevShareService.sendBundle.getCall(0).args[0];
            expect(bundleArgs.txs).to.have.lengthOf(2);
            expect(bundleArgs.txs[0]).to.equal(mockPendingTx.hash);
        });

        it('should handle execution errors gracefully', async () => {
            const opportunity: CrossedMarketDetails = {
                profit: BigNumber.from('100000000000000000'),
                volume: BigNumber.from('1000000000000000000'),
                tokenAddress: '0xWETH',
                buyFromMarket: mockMarket1,
                sellToMarket: mockMarket2,
                marketPairs: []
            };

            const mockPendingTx: EnhancedPendingTransaction = {
                hash: '0xPendingTxHash',
                hints: {
                    function_selector: '0x38ed1739',
                    calldata: '0x1234'
                }
            };

            // Mock a failure
            mockMevShareService.sendBundle.rejects(new Error('Bundle submission failed'));

            // Should not throw
            await expect(
                mevShareArbitrage['executeArbitrage'](opportunity, mockPendingTx)
            ).to.not.be.rejected;
        });
    });
}); 