// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IArbRouter {
    function factory() external view returns (address);
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) external returns (uint256);
}

interface IArbFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IArbPair {
    function token0() external view returns (address);
    function reserve0() external view returns (uint256);
    function reserve1() external view returns (uint256);
}

/// 两个交易所之间搬一次货。全程一笔交易，中间任何一步失败都会一起回滚。
contract AtomicArbitrage {
    struct Plan {
        bool profitable;
        address buyRouter;
        address sellRouter;
        uint256 amountBought;
        uint256 amountBack;
        uint256 profit;
        uint256 priceBuyBefore;
        uint256 priceSellBefore;
        uint256 priceBuyAfter;
        uint256 priceSellAfter;
    }

    struct Cycle {
        bool ok;
        address buyRouter;
        address sellRouter;
        uint256 amountBought;
        uint256 amountBack;
        uint256 priceBeforeBuy;
        uint256 priceBeforeSell;
        uint256 priceAfterBuy;
        uint256 priceAfterSell;
    }

    uint256 private _lock = 1;

    event ArbitrageExecuted(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        address buyRouter,
        address sellRouter,
        uint256 amountIn,
        uint256 amountBought,
        uint256 amountBack,
        uint256 profit,
        uint256 priceBuyBefore,
        uint256 priceSellBefore,
        uint256 priceBuyAfter,
        uint256 priceSellAfter
    );

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    /// 价格 = 每 1 个 tokenIn 能换多少 tokenOut，乘了 1e18，不算手续费。
    function spotPrice(address router, address tokenIn, address tokenOut) external view returns (uint256) {
        return _spot(router, tokenIn, tokenOut);
    }

    function preview(address routerA, address routerB, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (Plan memory)
    {
        return _plan(routerA, routerB, tokenIn, tokenOut, amountIn);
    }

    function execute(
        address routerA,
        address routerB,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minProfit
    ) external nonReentrant returns (uint256 profit) {
        Plan memory p = _plan(routerA, routerB, tokenIn, tokenOut, amountIn);
        require(p.profitable, "no profit");
        profit = _settle(p, tokenIn, tokenOut, amountIn, minProfit);
    }

    function _settle(Plan memory p, address tokenIn, address tokenOut, uint256 amountIn, uint256 minProfit)
        internal
        returns (uint256 profit)
    {
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull");
        _approve(tokenIn, p.buyRouter, amountIn);
        uint256 bought =
            IArbRouter(p.buyRouter).swapExactTokensForTokens(tokenIn, tokenOut, amountIn, 0, address(this));
        _approve(tokenOut, p.sellRouter, bought);
        uint256 back = IArbRouter(p.sellRouter).swapExactTokensForTokens(tokenOut, tokenIn, bought, 0, address(this));

        // 卖回来的 tokenIn 必须比投进去的多，否则整笔交易 revert，池子储备也不会变。
        require(back > amountIn, "no profit");
        profit = back - amountIn;
        require(profit >= minProfit, "profit too small");
        require(IERC20(tokenIn).transfer(msg.sender, back), "pay trader");

        p.priceBuyAfter = _spot(p.buyRouter, tokenIn, tokenOut);
        p.priceSellAfter = _spot(p.sellRouter, tokenIn, tokenOut);
        emit ArbitrageExecuted(
            msg.sender,
            tokenIn,
            tokenOut,
            p.buyRouter,
            p.sellRouter,
            amountIn,
            bought,
            back,
            profit,
            p.priceBuyBefore,
            p.priceSellBefore,
            p.priceBuyAfter,
            p.priceSellAfter
        );
    }

    function _plan(address routerA, address routerB, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (Plan memory p)
    {
        require(routerA != routerB, "same dex");
        require(tokenIn != tokenOut && amountIn > 0, "bad args");
        Cycle memory left = _cycle(routerA, routerB, tokenIn, tokenOut, amountIn);
        Cycle memory right = _cycle(routerB, routerA, tokenIn, tokenOut, amountIn);
        Cycle memory best = left.amountBack >= right.amountBack ? left : right;
        p.buyRouter = best.buyRouter;
        p.sellRouter = best.sellRouter;
        p.amountBought = best.amountBought;
        p.amountBack = best.amountBack;
        p.priceBuyBefore = best.priceBeforeBuy;
        p.priceSellBefore = best.priceBeforeSell;
        p.priceBuyAfter = best.priceAfterBuy;
        p.priceSellAfter = best.priceAfterSell;
        if (best.ok && best.amountBack > amountIn) {
            p.profitable = true;
            p.profit = best.amountBack - amountIn;
        }
    }

    function _cycle(address buyRouter, address sellRouter, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (Cycle memory c)
    {
        c.buyRouter = buyRouter;
        c.sellRouter = sellRouter;
        try IArbRouter(buyRouter).quote(tokenIn, tokenOut, amountIn) returns (uint256 bought) {
            c.amountBought = bought;
        } catch {
            return c;
        }
        try IArbRouter(sellRouter).quote(tokenOut, tokenIn, c.amountBought) returns (uint256 back) {
            c.amountBack = back;
        } catch {
            return c;
        }

        c.ok = true;
        c.priceBeforeBuy = _spot(buyRouter, tokenIn, tokenOut);
        c.priceBeforeSell = _spot(sellRouter, tokenIn, tokenOut);
        (uint256 buyIn, uint256 buyOut) = _reserves(buyRouter, tokenIn, tokenOut);
        (uint256 sellIn, uint256 sellOut) = _reserves(sellRouter, tokenIn, tokenOut);
        // 买的那边：tokenIn 变多，tokenOut 变少。
        c.priceAfterBuy = (buyOut - c.amountBought) * 1e18 / (buyIn + amountIn);
        // 卖的那边：tokenOut 变多，tokenIn 变少。spot 仍然是 tokenOut / tokenIn。
        c.priceAfterSell = (sellOut + c.amountBought) * 1e18 / (sellIn - c.amountBack);
    }

    function _spot(address router, address tokenIn, address tokenOut) internal view returns (uint256) {
        (uint256 reserveIn, uint256 reserveOut) = _reserves(router, tokenIn, tokenOut);
        require(reserveIn > 0, "empty");
        return reserveOut * 1e18 / reserveIn;
    }

    function _reserves(address router, address tokenIn, address tokenOut)
        internal
        view
        returns (uint256 reserveIn, uint256 reserveOut)
    {
        address factory = IArbRouter(router).factory();
        address pair = IArbFactory(factory).getPair(tokenIn, tokenOut);
        require(pair != address(0), "no pair");
        address token0 = IArbPair(pair).token0();
        uint256 reserve0 = IArbPair(pair).reserve0();
        uint256 reserve1 = IArbPair(pair).reserve1();
        if (tokenIn == token0) {
            return (reserve0, reserve1);
        }
        return (reserve1, reserve0);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        require(IERC20(token).approve(spender, amount), "approve");
    }
}
