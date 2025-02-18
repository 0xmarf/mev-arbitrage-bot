// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@aave/core-v3/contracts/interfaces/IPool.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";

interface IBundleExecutor {
    function uniswapWeth(
        uint256 _wethAmountToFirstMarket,
        uint256 _ethAmountToCoinbase,
        address[] calldata _targets,
        bytes[] calldata _payloads
    ) external payable;
}

contract FlashLoanExecutor is FlashLoanSimpleReceiverBase, Ownable {
    address public bundleExecutor;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    
    struct ExecutionData {
        address[] targets;
        bytes[] payloads;
        uint256 minerReward;
    }
    
    mapping(address => ExecutionData) private pendingExecutions;

    constructor(
        address _addressProvider,
        address _bundleExecutor
    ) FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider)) {
        _transferOwnership(_msgSender());
        bundleExecutor = _bundleExecutor;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Decode execution parameters
        (
            address[] memory targets,
            bytes[] memory payloads,
            uint256 minerReward
        ) = abi.decode(params, (address[], bytes[], uint256));

        // Approve WETH spending by bundle executor
        IERC20(WETH).approve(bundleExecutor, amount);

        // Execute the arbitrage through bundle executor
        bool success = false;
        try IBundleExecutor(bundleExecutor).uniswapWeth(
            amount,
            minerReward,
            targets,
            payloads
        ) {
            // Verify we have enough to repay the flash loan
            uint256 amountToRepay = amount + premium;
            require(
                IERC20(asset).balanceOf(address(this)) >= amountToRepay,
                "Insufficient balance to repay flash loan"
            );

            // Approve repayment
            IERC20(asset).approve(address(POOL), amountToRepay);
            
            success = true;
        } catch (bytes memory reason) {
            emit ExecutionFailed(reason);
        }
        return success;
    }

    function executeFlashLoan(
        uint256 amount,
        address[] calldata targets,
        bytes[] calldata payloads,
        uint256 minerReward
    ) external onlyOwner {
        // Prepare execution data
        bytes memory params = abi.encode(targets, payloads, minerReward);
        
        // Request flash loan from Aave
        POOL.flashLoanSimple(
            address(this),
            WETH,
            amount,
            params,
            0 // referral code
        );
    }

    function updateBundleExecutor(address _newExecutor) external onlyOwner {
        require(_newExecutor != address(0), "Invalid executor address");
        bundleExecutor = _newExecutor;
    }

    // Emergency functions
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }

    function rescueETH() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }

    // Events
    event ExecutionFailed(bytes reason);
    
    // Receive function to accept ETH
    receive() external payable {}
}