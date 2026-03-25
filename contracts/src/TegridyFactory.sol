// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./TegridyPair.sol";

/// @title TegridyFactory — Creates and manages AMM liquidity pools
/// @notice Fork of Uniswap V2 Factory. Creates TegridyPair pools for any token pair.
///
///         Features:
///         - Create pools for any ERC20 pair (PEPE/ETH, USDC/ETH, TOWELI/USDT, etc.)
///         - Protocol fee (0.05% of swap volume) sent to feeTo address
///         - Unlimited pools — add any pair anytime
///         - Each pool is a TegridyPair contract with its own LP token
contract TegridyFactory {

    address public feeTo;      // Address that receives protocol fees (treasury)
    address public feeToSetter; // Address allowed to change feeTo

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount);

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Create a new trading pair. Anyone can call this.
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "PAIR_EXISTS");

        // Deploy new pair contract
        bytes memory bytecode = type(TegridyPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }

        TegridyPair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // Populate reverse mapping
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        feeToSetter = _feeToSetter;
    }
}
