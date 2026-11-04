// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// 作业用测试币。部署者可以 mint，普通地址用 claim 领币。
contract TestERC20 is ERC20, Ownable {
    uint256 public constant CLAIM_AMOUNT = 10_000 ether;
    uint256 public constant MAX_CLAIMS = 3;

    mapping(address => uint256) public claims;

    event Claimed(address indexed user, uint256 amount, uint256 count);

    constructor(string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {}

    function claim() external {
        require(claims[msg.sender] < MAX_CLAIMS, "claim limit");
        claims[msg.sender] += 1;
        _mint(msg.sender, CLAIM_AMOUNT);
        emit Claimed(msg.sender, CLAIM_AMOUNT, claims[msg.sender]);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
