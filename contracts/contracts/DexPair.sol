// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IDexFactoryRouter {
    function router() external view returns (address);
}

/// 恒定乘积池。x * y = k，手续费留在储备里，不另开一个分红账户。
contract DexPair {
    address public factory;
    address public token0;
    address public token1;

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalShares;

    // 0.3% 写成 997/1000，输出向下取整。少掉的留在储备里，不进单独账户。
    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1000;

    // 第一笔流动性锁住这么多份额，避免有人用 1 wei 把份额比例做得很极端。
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    event Mint(uint256 shares, uint256 amount0, uint256 amount1, uint256 totalShares);
    event Burn(uint256 shares, uint256 amount0, uint256 amount1, uint256 totalShares);
    event Swap(
        address indexed sender,
        address indexed tokenIn,
        address indexed to,
        uint256 amountIn,
        uint256 amountOut,
        uint256 reserve0,
        uint256 reserve1
    );

    modifier onlyRouter() {
        require(msg.sender == IDexFactoryRouter(factory).router(), "only router");
        _;
    }

    constructor(address token0_, address token1_) {
        require(token0_ != address(0) && token1_ != address(0), "zero token");
        require(token0_ < token1_, "order");
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
    }

    function getState()
        external
        view
        returns (address _token0, address _token1, uint256 _reserve0, uint256 _reserve1, uint256 _totalShares)
    {
        return (token0, token1, reserve0, reserve1, totalShares);
    }

    function reserveOf(address token) public view returns (uint256) {
        if (token == token0) return reserve0;
        if (token == token1) return reserve1;
        revert("token not in pair");
    }

    /// amountOut = reserveOut * amountIn * 997 / (reserveIn * 1000 + amountIn * 997)
    function getAmountOut(address tokenIn, uint256 amountIn) external view returns (uint256) {
        require(tokenIn == token0 || tokenIn == token1, "bad token");
        uint256 reserveIn = tokenIn == token0 ? reserve0 : reserve1;
        uint256 reserveOut = tokenIn == token0 ? reserve1 : reserve0;
        return quote(amountIn, reserveIn, reserveOut);
    }

    function quote(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256 amountOut) {
        require(amountIn > 0, "zero in");
        require(reserveIn > 0 && reserveOut > 0, "empty pool");
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        amountOut = amountInWithFee * reserveOut / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
        require(amountOut > 0, "zero out");
    }

    function previewWithdraw(uint256 shares) external view returns (uint256 amount0, uint256 amount1) {
        require(totalShares > 0 && shares <= totalShares, "bad shares");
        amount0 = shares * reserve0 / totalShares;
        amount1 = shares * reserve1 / totalShares;
    }

    /// 只把路由声明的数量记入储备。误转到池子里的代币不会改变价格。
    function mint(uint256 amount0, uint256 amount1) external onlyRouter returns (uint256 shares) {
        require(amount0 > 0 && amount1 > 0, "zero amount");
        require(IERC20(token0).balanceOf(address(this)) >= reserve0 + amount0, "token0 short");
        require(IERC20(token1).balanceOf(address(this)) >= reserve1 + amount1, "token1 short");

        if (totalShares == 0) {
            uint256 liquidity = _sqrt(amount0 * amount1);
            require(liquidity > MINIMUM_LIQUIDITY, "liquidity too small");
            totalShares = liquidity;
            shares = liquidity - MINIMUM_LIQUIDITY;
        } else {
            uint256 share0 = amount0 * totalShares / reserve0;
            uint256 share1 = amount1 * totalShares / reserve1;
            shares = share0 < share1 ? share0 : share1;
            require(shares > 0, "shares too small");
            totalShares += shares;
        }

        reserve0 += amount0;
        reserve1 += amount1;
        emit Mint(shares, amount0, amount1, totalShares);
    }

    function burn(uint256 shares, address to) external onlyRouter returns (uint256 amount0, uint256 amount1) {
        require(shares > 0 && shares <= totalShares, "bad shares");
        require(to != address(0) && to != address(this), "bad to");
        // 手续费已经留在 reserve 里，所以同样的份额现在能换出更多代币。
        amount0 = shares * reserve0 / totalShares;
        amount1 = shares * reserve1 / totalShares;
        require(amount0 > 0 && amount1 > 0, "zero out");

        totalShares -= shares;
        reserve0 -= amount0;
        reserve1 -= amount1;
        require(IERC20(token0).transfer(to, amount0), "transfer0");
        require(IERC20(token1).transfer(to, amount1), "transfer1");
        emit Burn(shares, amount0, amount1, totalShares);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 amountOutMin, address to)
        external
        onlyRouter
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "zero in");
        require(to != address(0) && to != address(this), "bad to");
        bool inIs0 = tokenIn == token0;
        require(inIs0 || tokenIn == token1, "bad token");

        uint256 old0 = reserve0;
        uint256 old1 = reserve1;
        uint256 reserveIn = inIs0 ? old0 : old1;
        uint256 reserveOut = inIs0 ? old1 : old0;
        amountOut = quote(amountIn, reserveIn, reserveOut);
        require(amountOut >= amountOutMin, "slippage");
        require(amountOut < reserveOut, "insufficient liquidity");

        uint256 balIn = IERC20(tokenIn).balanceOf(address(this));
        require(balIn >= reserveIn + amountIn, "input not received");

        if (inIs0) {
            reserve0 = old0 + amountIn;
            reserve1 = old1 - amountOut;
        } else {
            reserve1 = old1 + amountIn;
            reserve0 = old0 - amountOut;
        }
        // 输入按全额计入，输出按扣费后的数量付出，所以 k 不会变小。
        require(reserve0 * reserve1 >= old0 * old1, "k");

        address tokenOut = inIs0 ? token1 : token0;
        require(IERC20(tokenOut).transfer(to, amountOut), "out transfer");
        emit Swap(msg.sender, tokenIn, to, amountIn, amountOut, reserve0, reserve1);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
