// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/// 一张 NFT 就是一笔流动性。销毁只能走路由，避免凭证没了代币还在池子里。
contract LiquidityNFT is ERC721Enumerable {
    struct Position {
        address pair;
        uint256 shares;
        uint256 amount0;
        uint256 amount1;
        uint64 createdAt;
    }

    address public deployer;
    address public router;
    uint256 public nextId = 1;

    mapping(uint256 => Position) private _positions;
    mapping(address => uint256[]) private _poolIds;

    event RouterSet(address router);
    event PositionMinted(
        uint256 indexed tokenId,
        address indexed to,
        address indexed pair,
        uint256 shares,
        uint256 amount0,
        uint256 amount1,
        uint256 createdAt
    );
    event PositionBurned(uint256 indexed tokenId, address indexed owner);

    modifier onlyRouter() {
        require(msg.sender == router, "only router");
        _;
    }

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {
        deployer = msg.sender;
    }

    function setRouter(address router_) external {
        require(msg.sender == deployer, "not deployer");
        require(router == address(0), "router set");
        require(router_ != address(0), "zero router");
        router = router_;
        emit RouterSet(router_);
    }

    function mint(address to, address pair, uint256 shares, uint256 amount0, uint256 amount1)
        external
        onlyRouter
        returns (uint256 tokenId)
    {
        require(to != address(0) && pair != address(0), "zero address");
        require(shares > 0, "zero shares");
        tokenId = nextId++;
        _positions[tokenId] = Position({
            pair: pair,
            shares: shares,
            amount0: amount0,
            amount1: amount1,
            createdAt: uint64(block.timestamp)
        });
        _poolIds[pair].push(tokenId);
        _safeMint(to, tokenId);
        emit PositionMinted(tokenId, to, pair, shares, amount0, amount1, block.timestamp);
    }

    function burn(uint256 tokenId) external onlyRouter {
        address owner = ownerOf(tokenId);
        _removePoolId(tokenId);
        delete _positions[tokenId];
        _burn(tokenId);
        emit PositionBurned(tokenId, owner);
    }

    function getPosition(uint256 tokenId)
        external
        view
        returns (address pair, uint256 shares, uint256 amount0, uint256 amount1, uint64 createdAt)
    {
        require(_ownerOf(tokenId) != address(0), "no nft");
        Position memory p = _positions[tokenId];
        return (p.pair, p.shares, p.amount0, p.amount1, p.createdAt);
    }

    function tokensOfPair(address pair) external view returns (uint256[] memory) {
        return _poolIds[pair];
    }

    function tokensOfOwner(address owner) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = tokenOfOwnerByIndex(owner, i);
        }
    }

    function _removePoolId(uint256 tokenId) internal {
        address pair = _positions[tokenId].pair;
        uint256[] storage ids = _poolIds[pair];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; i++) {
            if (ids[i] == tokenId) {
                ids[i] = ids[n - 1];
                ids.pop();
                break;
            }
        }
    }
}
