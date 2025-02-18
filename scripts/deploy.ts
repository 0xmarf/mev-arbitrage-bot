import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // AAVE V3 Pool Addresses Provider on Mainnet
  const AAVE_POOL_ADDRESSES_PROVIDER = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";
  
  // Deploy a mock bundle executor for testing
  const BundleExecutor = await ethers.getContractFactory("FlashBotsMultiCall");
  const bundleExecutor = await BundleExecutor.deploy(deployer.address);
  await bundleExecutor.waitForDeployment();
  console.log("BundleExecutor deployed to:", await bundleExecutor.getAddress());

  // Deploy FlashLoanExecutor
  const FlashLoanExecutor = await ethers.getContractFactory("FlashLoanExecutor");
  const flashLoanExecutor = await FlashLoanExecutor.deploy(
    AAVE_POOL_ADDRESSES_PROVIDER,
    await bundleExecutor.getAddress()
  );
  await flashLoanExecutor.waitForDeployment();
  console.log("FlashLoanExecutor deployed to:", await flashLoanExecutor.getAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 