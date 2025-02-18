import { ethers, BigNumber } from 'ethers';

// Function to fetch WETH balance
async function fetchWETHBalance(address: string): Promise<BigNumber> {
  const maxRetries = 3;
  let attempt = 0;
  const provider = new ethers.providers.JsonRpcProvider('https://eth-mainnet.g.alchemy.com/v2/jpWIUdqC9uBZm_8nb1t0hgYf9jCbh3Wi');

  while (attempt < maxRetries) {
    try {
      const balance = await provider.call({
        to: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        data: ethers.utils.hexlify(ethers.utils.concat([
          ethers.utils.id('balanceOf(address)').slice(0, 10),
          ethers.utils.defaultAbiCoder.encode(['address'], [address])
        ]))
      });
      return BigNumber.from(balance);
    } catch (error: any) {
      if (error.code === 'SERVER_ERROR' && error.serverError.code === 'EADDRNOTAVAIL') {
        console.error(`Attempt ${attempt + 1} failed: ${error.message}`);
        attempt++;
        await new Promise(resolve => setTimeout(resolve, 1000)); // wait 1 second before retrying
      } else {
        throw error;
      }
    }
  }
  throw new Error('Failed to fetch WETH balance after multiple attempts');
}

// Test the fetchWETHBalance function
async function testFetchWETHBalance() {
  const testAddress = '0x2fe16Dd18bba26e457B7dD2080d5674312b026a2'; // Replace with a valid Ethereum address

  try {
    const balance = await fetchWETHBalance(testAddress);
    console.log(`WETH Balance of ${testAddress}: ${ethers.utils.formatEther(balance)} WETH`);
  } catch (error: any) {
    console.error('Error fetching WETH balance:', error.message);
  }
}

testFetchWETHBalance();
