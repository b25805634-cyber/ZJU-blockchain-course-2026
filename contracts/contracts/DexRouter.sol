// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./DexFactory.sol";
import "./DexPair.sol";
import "./LiquidityNFT.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// 用户入口。ETH 在这里换成 WETH 再进池子，取回时再拆开。
contract DexRouter {
    DexFactory public immutable factory;
    address public immutable weth;
    LiquidityNFT public immutable nft;

    uint256 private _lock = 1;

    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event LiquidityAdded(
        address indexed user,
        uint256 indexed tokenId,
        address pair,
        uint256 shares,
        uint256 amount0,
        uint256 amount1
    );
    event LiquidityRemoved(address indexed user, uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address factory_, address weth_, address nft_) {
        require(factory_ != address(0) && weth_ != address(0) && nft_ != address(0), "zero address");
        factory = DexFactory(factory_);
        weth = weth_;
        nft = LiquidityNFT(nft_);
    }

    receive() external payable {}

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        return factory.createPair(tokenA, tokenB);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        address pair = factory.getPair(tokenIn, tokenOut);
        require(pair != address(0), "no pair");
        return DexPair(pair).getAmountOut(tokenIn, amountIn);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        address to
    ) external nonReentrant returns (uint256 tokenId, uint256 shares, uint256 amount0, uint256 amount1) {
        return _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, to);
    }

    function createPairAndAddLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        address to
    ) external nonReentrant returns (uint256 tokenId, uint256 shares, uint256 amount0, uint256 amount1) {
        if (factory.getPair(tokenA, tokenB) == address(0)) {
            factory.createPair(tokenA, tokenB);
        }
        return _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, to);
    }

    function addLiquidityETH(address token, uint256 amountTokenDesired, address to)
        external
        payable
        nonReentrant
        returns (uint256 tokenId, uint256 shares, uint256 amount0, uint256 amount1)
    {
        return _addLiquidityETH(token, amountTokenDesired, to);
    }

    function createPairAndAddLiquidityETH(address token, uint256 amountTokenDesired, address to)
        external
        payable
        nonReentrant
        returns (uint256 tokenId, uint256 shares, uint256 amount0, uint256 amount1)
    {
        if (factory.getPair(token, weth) == address(0)) {
            factory.createPair(token, weth);
        }
        return _addLiquidityETH(token, amountTokenDesired, to);
    }

    function removeLiquidity(uint256 tokenId, address to)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        require(to != address(0), "zero to");
        require(nft.ownerOf(tokenId) == msg.sender, "not owner");
        (address pair, uint256 shares, , , ) = nft.getPosition(tokenId);
        nft.burn(tokenId);
        (amount0, amount1) = DexPair(pair).burn(shares, to);
        emit LiquidityRemoved(msg.sender, tokenId, amount0, amount1);
    }

    function removeLiquidityETH(uint256 tokenId, address to)
        external
        nonReentrant
        returns (uint256 amountToken, uint256 amountETH)
    {
        require(to != address(0), "zero to");
        require(nft.ownerOf(tokenId) == msg.sender, "not owner");
        (address pair, uint256 shares, , , ) = nft.getPosition(tokenId);
        DexPair p = DexPair(pair);
        address token0 = p.token0();
        address token1 = p.token1();
        require(token0 == weth || token1 == weth, "not eth pair");

        nft.burn(tokenId);
        (uint256 amount0, uint256 amount1) = p.burn(shares, address(this));

        address token;
        if (token0 == weth) {
            amountETH = amount0;
            amountToken = amount1;
            token = token1;
        } else {
            amountETH = amount1;
            amountToken = amount0;
            token = token0;
        }
        IWETH(weth).withdraw(amountETH);
        require(IERC20(token).transfer(to, amountToken), "token transfer");
        (bool ok, ) = to.call{value: amountETH}("");
        require(ok, "eth transfer");
        emit LiquidityRemoved(msg.sender, tokenId, amount0, amount1);
    }

    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) external nonReentrant returns (uint256 amountOut) {
        return _swap(tokenIn, tokenOut, amountIn, amountOutMin, to);
    }

    function swapExactETHForTokens(address tokenOut, uint256 amountOutMin, address to)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        require(msg.value > 0, "zero eth");
        require(to != address(0), "zero to");
        address pair = factory.getPair(weth, tokenOut);
        require(pair != address(0), "no pair");
        IWETH(weth).deposit{value: msg.value}();
        require(IERC20(weth).transfer(pair, msg.value), "weth transfer");
        amountOut = DexPair(pair).swap(weth, msg.value, amountOutMin, to);
        emit Swapped(msg.sender, weth, tokenOut, msg.value, amountOut);
    }

    function swapExactTokensForETH(address tokenIn, uint256 amountIn, uint256 amountOutMin, address to)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(to != address(0), "zero to");
        amountOut = _swap(tokenIn, weth, amountIn, amountOutMin, address(this));
        IWETH(weth).withdraw(amountOut);
        (bool ok, ) = to.call{value: amountOut}("");
        require(ok, "eth transfer");
    }

    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        address to
    ) internal returns (uint256 tokenId, uint256 shares, uint256 amount0, uint256 amount1) {
        require(to != address(0), "zero to");
        address pair = factory.getPair(tokenA, tokenB);
        require(pair != address(0), "no pair");
        uint256 amountA;
        uint256 amountB;
        (amountA, amountB) = _optimal(pair, tokenA, tokenB, amountADesired, amountBDesired);
        require(IERC20(tokenA).transferFrom(msg.sender, pair, amountA), "transfer A");
        require(IERC20(tokenB).transferFrom(msg.sender, pair, amountB), "transfer B");
        (amount0, amount1) = _ordered(pair, tokenA, amountA, tokenB, amountB);
        shares = DexPair(pair).mint(amount0, amount1);
        tokenId = nft.mint(to, pair, shares, amount0, amount1);
        emit LiquidityAdded(msg.sender, tokenId, pair, shares, amount0, amount1);
    }

    function _addLiquidityETH(address token, uint256 amountTokenDesired, address to)
        internal
        returns (uint256 tokenId, uint256 shares, uint256 amount0, uint256 amount1)
    {
        require(to != address(0), "zero to");
        require(token != weth, "token is weth");
        address pair = factory.getPair(token, weth);
        require(pair != address(0), "no pair");
        uint256 amountToken;
        uint256 amountETH;
        (amountToken, amountETH) = _optimal(pair, token, weth, amountTokenDesired, msg.value);
        require(IERC20(token).transferFrom(msg.sender, pair, amountToken), "transfer token");
        IWETH(weth).deposit{value: amountETH}();
        require(IERC20(weth).transfer(pair, amountETH), "weth transfer");
        (amount0, amount1) = _ordered(pair, token, amountToken, weth, amountETH);
        shares = DexPair(pair).mint(amount0, amount1);
        tokenId = nft.mint(to, pair, shares, amount0, amount1);
        uint256 refund = msg.value - amountETH;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "eth refund");
        }
        emit LiquidityAdded(msg.sender, tokenId, pair, shares, amount0, amount1);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address to)
        internal
        returns (uint256 amountOut)
    {
        require(to != address(0), "zero to");
        require(tokenIn != tokenOut, "same token");
        address pair = factory.getPair(tokenIn, tokenOut);
        require(pair != address(0), "no pair");
        require(IERC20(tokenIn).transferFrom(msg.sender, pair, amountIn), "pull in");
        amountOut = DexPair(pair).swap(tokenIn, amountIn, amountOutMin, to);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// 池子已有储备时，按当前比例截断多出来的一边，避免把价格直接打歪。
    function _optimal(
        address pair,
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired
    ) internal view returns (uint256 amountA, uint256 amountB) {
        require(amountADesired > 0 && amountBDesired > 0, "zero desired");
        uint256 reserveA = DexPair(pair).reserveOf(tokenA);
        uint256 reserveB = DexPair(pair).reserveOf(tokenB);
        if (reserveA == 0 && reserveB == 0) {
            return (amountADesired, amountBDesired);
        }
        require(reserveA > 0 && reserveB > 0, "empty side");
        uint256 amountBOptimal = amountADesired * reserveB / reserveA;
        if (amountBOptimal <= amountBDesired) {
            require(amountBOptimal > 0, "amount too small");
            return (amountADesired, amountBOptimal);
        }
        uint256 amountAOptimal = amountBDesired * reserveA / reserveB;
        require(amountAOptimal > 0 && amountAOptimal <= amountADesired, "amount too small");
        return (amountAOptimal, amountBDesired);
    }

    function _ordered(address pair, address tokenA, uint256 amountA, address tokenB, uint256 amountB)
        internal
        view
        returns (uint256 amount0, uint256 amount1)
    {
        address token0 = DexPair(pair).token0();
        address token1 = DexPair(pair).token1();
        if (tokenA == token0) {
            require(tokenB == token1, "pair mismatch");
            return (amountA, amountB);
        }
        require(tokenA == token1 && tokenB == token0, "pair mismatch");
        return (amountB, amountA);
    }
}
