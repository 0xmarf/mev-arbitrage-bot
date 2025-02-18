import { providers } from "ethers";

async function batchEthCalls(provider: providers.JsonRpcProvider, calls: providers.TransactionRequest[]) {
    const batchedCalls = calls.map((call) => provider.send("eth_call", [call, "latest"]));
    const results = await Promise.all(batchedCalls);
    return results;
}

export { batchEthCalls };