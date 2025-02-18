//SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./interfaces/IERC20.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract BundleExecutor is Ownable {
    address public immutable WETH;
    
    event LogMessage(string message, uint256 value);
    event LogAddress(string message, address value);
    event LogError(string message);
    event CallInitiated(uint256 indexed index, address indexed target, bytes data);
    event CallCompleted(uint256 indexed index, address indexed target, bool success, bytes returnData);
    event SwapExecuted(address pair, uint256 amount0Out, uint256 amount1Out);
    event BalanceCheck(address token, uint256 balance);
    event FeeCalculation(uint256 amountIn, uint256 grossAmount, uint256 feeAmount);
    event FlashCallback(address sender, uint256 amount0, uint256 amount1, bytes data);
    event ReserveDeltas(address pair, int256 delta0, int256 delta1);

    struct ReservesData {
        uint112 reserve0;
        uint112 reserve1;
        uint32 blockTimestampLast;
    }

    mapping(address => bool) private inUse;
    mapping(address => ReservesData) private lastReserves;

    constructor(address _weth) {
        WETH = _weth;
    }

    function getReserveDeltas(address pair) internal returns (int256 delta0, int256 delta1) {
        // Get current reserves
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
        
        // Force reserves update to reflect any pending changes
        IUniswapV2Pair(pair).sync();
        
        // Get updated reserves
        (uint112 newReserve0, uint112 newReserve1,) = IUniswapV2Pair(pair).getReserves();
        
        // Calculate deltas
        delta0 = int256(uint256(newReserve0)) - int256(uint256(reserve0));
        delta1 = int256(uint256(newReserve1)) - int256(uint256(reserve1));
        
        emit ReserveDeltas(pair, delta0, delta1);
    }

    function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external {
        // --- CHECKS ---
        require((amount0 > 0 && amount1 == 0) || (amount0 == 0 && amount1 > 0), "Invalid amounts");
        require(msg.sender.code.length > 0, "Caller is not a contract");
        
        // Decode the data - now includes user tx hash and target pair
        (uint256 repayAmount, uint256 expectedOutput, address targetPair, bytes32 userTxHash) = 
            abi.decode(data, (uint256, uint256, address, bytes32));
            
        require(repayAmount > 0, "Invalid repay amount");
        require(expectedOutput > 0, "Invalid expected output");
        require(targetPair != address(0), "Invalid target pair");

        address token = amount0 > 0 ? IUniswapV2Pair(msg.sender).token0() : IUniswapV2Pair(msg.sender).token1();
        require(token != address(0), "Invalid token address");

        // Effects: mark the pair as in use to prevent reentrancy
        require(!inUse[msg.sender], "Pair already in use");
        inUse[msg.sender] = true;

        // Log initial state
        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;
        emit LogMessage("Borrowed amount", borrowedAmount);
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        emit BalanceCheck(token, balanceBefore);

        // Get reserve deltas from the target pair (user's transaction)
        (int256 delta0, int256 delta1) = getReserveDeltas(targetPair);

        // Calculate the optimal trade based on reserve deltas
        uint256 optimalAmount;
        if (delta0 > 0) {
            // Token0 was sold, Token1 was bought
            optimalAmount = uint256(delta0);
        } else {
            // Token1 was sold, Token0 was bought
            optimalAmount = uint256(delta1);
        }

        // --- INTERACTIONS ---
        address[] memory targets = new address[](1);
        bytes[] memory payloads = new bytes[](1);
        bool[] memory isWethTransfer = new bool[](1);
        uint256[] memory values = new uint256[](1);

        targets[0] = targetPair;
        payloads[0] = abi.encodeWithSelector(
            IUniswapV2Pair.swap.selector,
            delta0 > 0 ? optimalAmount : 0,  // amount0Out
            delta1 > 0 ? optimalAmount : 0,  // amount1Out
            address(this),
            new bytes(0)
        );
        isWethTransfer[0] = false;
        values[0] = 0;

        executeOperation(targets, payloads, isWethTransfer, values);

        // Post-interaction CHECK: verify token balance
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        emit BalanceCheck(token, balanceAfter);
        require(balanceAfter >= balanceBefore + expectedOutput, "Insufficient tokens received");

        // EFFECTS: Repay the flash swap
        require(IERC20(token).transfer(msg.sender, repayAmount), "Flash swap repayment failed");

        // Reset reentrancy guard
        inUse[msg.sender] = false;

        uint256 finalBalance = IERC20(token).balanceOf(address(this));
        emit LogMessage("Profit", finalBalance - balanceBefore);
    }

    function approveSpender(address spender) external onlyOwner {
        require(spender != address(0), "Invalid spender address");
        bool success = IERC20(WETH).approve(spender, type(uint256).max);
        require(success, "WETH approval failed");
        emit LogMessage("Approved WETH for spender", type(uint256).max);
        emit LogAddress("Spender address", spender);
    }

    function _handleWethTransfer(address target, uint256 amount) internal {
        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        emit LogMessage("WETH balance before transfer", wethBalance);
        
        require(wethBalance >= amount, "Insufficient WETH balance");
        
        // Calculate fee components for logging
        uint256 netAmount = (amount * 997) / 1000;
        uint256 feeAmount = amount - netAmount;
        emit FeeCalculation(netAmount, amount, feeAmount);
        
        require(IERC20(WETH).transfer(target, amount), "WETH transfer failed");
        
        wethBalance = IERC20(WETH).balanceOf(address(this));
        emit LogMessage("WETH balance after transfer", wethBalance);
        emit LogMessage("WETH transfer amount", amount);
    }

    function _logSwapParameters(address target, bytes memory payload) internal {
        if (target.code.length > 0) {
            try IUniswapV2Pair(target).token0() returns (address) {
                bytes memory data = new bytes(payload.length - 4);
                for (uint i = 4; i < payload.length; i++) {
                    data[i-4] = payload[i];
                }
                (uint amount0Out, uint amount1Out,,) = 
                    abi.decode(data, (uint, uint, address, bytes));
                emit SwapExecuted(target, amount0Out, amount1Out);
            } catch {
                // Not a pair contract or swap call, ignore
            }
        }
    }

    function _executeCall(
        uint256 index,
        address target,
        bytes memory payload,
        uint256 callValue
    ) internal {
        emit CallInitiated(index, target, payload);
        (bool success, bytes memory retData) = target.call{value: callValue}(payload);
        emit CallCompleted(index, target, success, retData);
        
        if (!success) {
            if (retData.length > 0) {
                assembly {
                    let resultLen := mload(retData)
                    let resultData := add(retData, 32)
                    revert(resultData, resultLen)
                }
            } else {
                revert("Call failed with no error message");
            }
        }
    }

    function executeOperation(
        address[] memory targets,
        bytes[] memory payloads,
        bool[] memory isWethTransfer,
        uint256[] memory values
    ) public payable {
        require(targets.length == payloads.length, "Length mismatch: targets vs payloads");
        require(targets.length == isWethTransfer.length, "Length mismatch: targets vs isWethTransfer");
        require(targets.length == values.length, "Length mismatch: targets vs values");

        for (uint i = 0; i < targets.length; i++) {
            emit LogAddress("Target address", targets[i]);
            emit LogMessage("Operation index", i);
            
            // Check initial balances
            emit BalanceCheck(WETH, IERC20(WETH).balanceOf(address(this)));
            
            if (isWethTransfer[i]) {
                _handleWethTransfer(targets[i], values[i]);
            }
            
            uint256 callValue = isWethTransfer[i] ? 0 : values[i];
            emit LogMessage("ETH value for call", callValue);
            
            _logSwapParameters(targets[i], payloads[i]);
            _executeCall(i, targets[i], payloads[i], callValue);
            
            // Check balances after operation
            emit BalanceCheck(WETH, IERC20(WETH).balanceOf(address(this)));
            emit LogMessage("Call succeeded", i);
        }

        // Return any remaining ETH to the sender
        uint256 remainingEth = address(this).balance;
        if (remainingEth > 0) {
            emit LogMessage("Returning remaining ETH", remainingEth);
            (bool success, ) = msg.sender.call{value: remainingEth}("");
            require(success, "ETH return transfer failed");
        }
    }

    receive() external payable {
        emit LogMessage("Received ETH", msg.value);
    }
}
