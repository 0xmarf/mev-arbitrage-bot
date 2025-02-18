import { expect } from "chai";
import { BigNumber, providers } from "ethers";
import UniswapV2EthPair from "../src/UniswapV2EthPair";
import { EthMarket } from "../src/EthMarket";
import { JsonRpcProvider } from '@ethersproject/providers';


describe("UniswapV2EthPair", () => {
    let market: UniswapV2EthPair;
    const mockAddress = "0x1234567890123456789012345678901234567890";
    const mockTokens = [
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333"
    ];
    beforeEach(() => {
        const provider = new JsonRpcProvider();
        market = new UniswapV2EthPair(mockAddress, mockTokens, "UniswapV2", "0.003", provider);
    });

    describe("getTokensOut", () => {
        it("should calculate correct output amount", async () => {
            // Set up test reserves
            await market.setReservesViaOrderedBalances([
                BigNumber.from("1000000"),
                BigNumber.from("1000000")
            ]);

            const inputAmount = BigNumber.from("1000");
            const expectedOutput = BigNumber.from("996"); // Calculated with 0.3% fee

            const result = await market.getTokensOut(
                mockTokens[0],
                mockTokens[1],
                inputAmount
            );

            expect(result.toString()).to.equal(expectedOutput.toString());
        });
    });

    describe("getBalance", () => {
        it("should return correct balance for token", async () => {
            const expectedBalance = BigNumber.from("1000000");
            await market.setReservesViaOrderedBalances([
                expectedBalance,
                BigNumber.from("2000000")
            ]);

            const balance = await market.getBalance(mockTokens[0]);
            expect(balance.toString()).to.equal(expectedBalance.toString());
        });
    });
});