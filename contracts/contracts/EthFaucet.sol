// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// 测试 ETH 水龙头。每个地址只能领一次，部署时由脚本往里面打入 ETH。
contract EthFaucet {
    uint256 public constant CLAIM_AMOUNT = 5 ether;

    mapping(address => bool) public claimed;

    event Claimed(address indexed user, uint256 amount);

    constructor() payable {}

    receive() external payable {}

    function claim() external {
        require(!claimed[msg.sender], "already claimed");
        require(address(this).balance >= CLAIM_AMOUNT, "faucet empty");
        claimed[msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: CLAIM_AMOUNT}("");
        require(ok, "eth transfer failed");
        emit Claimed(msg.sender, CLAIM_AMOUNT);
    }
}
