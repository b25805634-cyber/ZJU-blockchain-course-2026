// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./DexPair.sol";

/// 一个工厂对应一个交易所。作业的 Bonus 会部署两份，池子互不影响。
contract DexFactory is Ownable {
    address public router;
    address[] public allPairs;
    mapping(address => mapping(address => address)) public getPair;

    event RouterSet(address router);
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 index);

    constructor(address owner_) Ownable(owner_) {}

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function setRouter(address router_) external onlyOwner {
        require(router == address(0), "router set");
        require(router_ != address(0), "zero router");
        router = router_;
        emit RouterSet(router_);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "same token");
        require(tokenA != address(0) && tokenB != address(0), "zero token");
        require(tokenA.code.length > 0 && tokenB.code.length > 0, "not contract");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(getPair[token0][token1] == address(0), "pair exists");

        // 工厂是 pair 的 msg.sender，pair 里记录的 factory 就是本合约。
        pair = address(new DexPair(token0, token1));
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length - 1);
    }
}
