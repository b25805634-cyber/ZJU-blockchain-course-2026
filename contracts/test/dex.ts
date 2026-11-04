import { expect } from "chai";
import { MaxUint256, parseEther } from "ethers";
import hre from "hardhat";
import { runSimulation } from "../scripts/simlib.js";

const { ethers, networkHelpers } = await hre.network.create();

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

async function send(txPromise: Promise<any>) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  return receipt;
}

function outOf(amountIn: bigint, reserveIn: bigint, reserveOut: bigint) {
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}

async function deployFixture() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const ownerAddr = await owner.getAddress();

  const tokenA = await ethers.deployContract("TestERC20", ["Token A", "TKA", ownerAddr]);
  const tokenB = await ethers.deployContract("TestERC20", ["Token B", "TKB", ownerAddr]);
  const weth = await ethers.deployContract("WETH");
  const faucet = await ethers.deployContract("EthFaucet", [], { value: parseEther("100") });
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  await weth.waitForDeployment();
  await faucet.waitForDeployment();

  async function deployExchange(name: string, symbol: string) {
    const factory = await ethers.deployContract("DexFactory", [ownerAddr]);
    const nft = await ethers.deployContract("LiquidityNFT", [`${name} LP`, symbol]);
    await factory.waitForDeployment();
    await nft.waitForDeployment();
    const router = await ethers.deployContract("DexRouter", [
      await factory.getAddress(),
      await weth.getAddress(),
      await nft.getAddress(),
    ]);
    await router.waitForDeployment();
    await send(factory.setRouter(await router.getAddress()));
    await send(nft.setRouter(await router.getAddress()));
    return { name, factory, router, nft };
  }

  const dexA = await deployExchange("MiniDEX-A", "MDA-LP");
  const dexB = await deployExchange("MiniDEX-B", "MDB-LP");
  const arb = await ethers.deployContract("AtomicArbitrage");
  await arb.waitForDeployment();

  return { signers, owner, tokenA, tokenB, weth, faucet, dexA, dexB, arb };
}

async function mintAndApprove(token: any, holder: any, spender: string, amount: bigint) {
  await send(token.mint(await holder.getAddress(), amount));
  await send(token.connect(holder).approve(spender, MaxUint256));
}

describe("faucet", function () {
  it("lets several users claim tokens and ETH", async function () {
    const { tokenA, tokenB, faucet, signers } = await networkHelpers.loadFixture(deployFixture);
    const alice = signers[1];
    const bob = signers[2];

    await send(tokenA.connect(alice).claim());
    await send(tokenB.connect(bob).claim());
    expect(await tokenA.balanceOf(await alice.getAddress())).to.equal(await tokenA.CLAIM_AMOUNT());
    expect(await tokenB.balanceOf(await bob.getAddress())).to.equal(await tokenB.CLAIM_AMOUNT());

    await send(tokenA.connect(alice).claim());
    await send(tokenA.connect(alice).claim());
    await expect(tokenA.connect(alice).claim()).to.be.revertedWith("claim limit");

    const faucetAddr = await faucet.getAddress();
    const before = await ethers.provider.getBalance(faucetAddr);
    await send(faucet.connect(alice).claim());
    await send(faucet.connect(bob).claim());
    const after = await ethers.provider.getBalance(faucetAddr);
    const claimEth = await faucet.CLAIM_AMOUNT();
    expect(before - after).to.equal(claimEth * 2n);
    expect(await faucet.claimed(await alice.getAddress())).to.equal(true);
    await expect(faucet.connect(alice).claim()).to.be.revertedWith("already claimed");
    await expect(tokenA.connect(bob).mint(await bob.getAddress(), 1n)).to.revert(ethers);
  });
});

describe("pool and LP NFT", function () {
  it("creates a pair, mints an NFT, and splits shares", async function () {
    const { tokenA, tokenB, dexA, signers } = await networkHelpers.loadFixture(deployFixture);
    const alice = signers[1];
    const bob = signers[2];
    const carol = signers[3];
    const routerAddr = await dexA.router.getAddress();
    const amount = parseEther("10000");

    await mintAndApprove(tokenA, alice, routerAddr, amount * 2n);
    await mintAndApprove(tokenB, alice, routerAddr, amount * 2n);
    await mintAndApprove(tokenA, bob, routerAddr, amount);
    await mintAndApprove(tokenB, bob, routerAddr, amount);

    const a = await tokenA.getAddress();
    const b = await tokenB.getAddress();
    await expect(dexA.factory.createPair(a, a)).to.be.revertedWith("same token");

    await send(
      dexA.router.connect(alice).createPairAndAddLiquidity(a, b, amount, amount, await alice.getAddress()),
    );
    const pairAddr = await dexA.factory.getPair(a, b);
    expect(await dexA.factory.getPair(b, a)).to.equal(pairAddr);
    await expect(dexA.factory.createPair(b, a)).to.be.revertedWith("pair exists");

    const pair = await ethers.getContractAt("DexPair", pairAddr);
    const [token0, token1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    expect(await pair.token0()).to.equal(token0);
    expect(await pair.token1()).to.equal(token1);
    expect(await pair.reserve0()).to.equal(amount);
    expect(await pair.reserve1()).to.equal(amount);

    const aliceIds = await dexA.nft.tokensOfOwner(await alice.getAddress());
    expect(aliceIds.length).to.equal(1);
    const aliceId = aliceIds[0];
    const alicePos = await dexA.nft.getPosition(aliceId);
    expect(alicePos.pair).to.equal(pairAddr);
    expect(alicePos.amount0).to.equal(amount);
    expect(alicePos.amount1).to.equal(amount);
    const block = await ethers.provider.getBlock("latest");
    expect(alicePos.createdAt).to.equal(BigInt(block!.timestamp));
    const pairIds = await dexA.nft.tokensOfPair(pairAddr);
    expect(pairIds.length).to.equal(1);
    expect(pairIds[0]).to.equal(aliceId);

    await send(dexA.router.connect(bob).addLiquidity(a, b, amount, amount, await bob.getAddress()));
    const bobId = (await dexA.nft.tokensOfOwner(await bob.getAddress()))[0];

    await expect(dexA.router.connect(carol).removeLiquidity(aliceId, await carol.getAddress())).to.be.revertedWith(
      "not owner",
    );

    const aliceBeforeA = await tokenA.balanceOf(await alice.getAddress());
    const aliceBeforeB = await tokenB.balanceOf(await alice.getAddress());
    await send(dexA.router.connect(alice).removeLiquidity(aliceId, await alice.getAddress()));
    // 第一笔流动性锁了 1000 份额，Alice 取回时每边少 1000 wei。
    expect((await tokenA.balanceOf(await alice.getAddress())) - aliceBeforeA).to.equal(amount - 1000n);
    expect((await tokenB.balanceOf(await alice.getAddress())) - aliceBeforeB).to.equal(amount - 1000n);

    const bobBeforeA = await tokenA.balanceOf(await bob.getAddress());
    const bobBeforeB = await tokenB.balanceOf(await bob.getAddress());
    await send(dexA.router.connect(bob).removeLiquidity(bobId, await bob.getAddress()));
    expect((await tokenA.balanceOf(await bob.getAddress())) - bobBeforeA).to.equal(amount);
    expect((await tokenB.balanceOf(await bob.getAddress())) - bobBeforeB).to.equal(amount);

    expect(await pair.totalShares()).to.equal(1000n);
    expect(await pair.reserve0()).to.equal(1000n);
    expect(await pair.reserve1()).to.equal(1000n);
    expect((await dexA.nft.tokensOfPair(pairAddr)).length).to.equal(0);
    await expect(dexA.nft.ownerOf(aliceId)).to.revert(ethers);
  });

  it("transfers the NFT and lets the new owner withdraw", async function () {
    const { tokenA, tokenB, dexA, signers } = await networkHelpers.loadFixture(deployFixture);
    const alice = signers[1];
    const bob = signers[2];
    const routerAddr = await dexA.router.getAddress();
    const amount = parseEther("1000");
    await mintAndApprove(tokenA, alice, routerAddr, amount);
    await mintAndApprove(tokenB, alice, routerAddr, amount);
    await send(
      dexA.router
        .connect(alice)
        .createPairAndAddLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          amount,
          amount,
          await alice.getAddress(),
        ),
    );
    const tokenId = (await dexA.nft.tokensOfOwner(await alice.getAddress()))[0];
    await send(dexA.nft.connect(alice).transferFrom(await alice.getAddress(), await bob.getAddress(), tokenId));
    await expect(
      dexA.router.connect(alice).removeLiquidity(tokenId, await alice.getAddress()),
    ).to.be.revertedWith("not owner");

    const before = await tokenA.balanceOf(await bob.getAddress());
    await send(dexA.router.connect(bob).removeLiquidity(tokenId, await bob.getAddress()));
    expect((await tokenA.balanceOf(await bob.getAddress())) > before).to.equal(true);
  });
});

describe("swap and fee", function () {
  it("charges 0.3% and gives the fee to the LP", async function () {
    const { tokenA, tokenB, dexA, signers } = await networkHelpers.loadFixture(deployFixture);
    const alice = signers[1];
    const trader = signers[2];
    const routerAddr = await dexA.router.getAddress();
    const amount = parseEther("10000");
    await mintAndApprove(tokenA, alice, routerAddr, amount);
    await mintAndApprove(tokenB, alice, routerAddr, amount);
    await send(
      dexA.router
        .connect(alice)
        .createPairAndAddLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          amount,
          amount,
          await alice.getAddress(),
        ),
    );

    const pairAddr = await dexA.factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pair = await ethers.getContractAt("DexPair", pairAddr);
    const token0 = await pair.token0();
    const tokenIn = same(token0, await tokenA.getAddress()) ? tokenA : tokenB;
    const tokenOut = tokenIn === tokenA ? tokenB : tokenA;
    const amountIn = parseEther("1000");
    await mintAndApprove(tokenIn, trader, routerAddr, amountIn);

    const reserveIn = await pair.reserveOf(await tokenIn.getAddress());
    const reserveOut = await pair.reserveOf(await tokenOut.getAddress());
    const expected = outOf(amountIn, reserveIn, reserveOut);
    expect(await dexA.router.quote(await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn)).to.equal(
      expected,
    );
    const noFee = (amountIn * reserveOut) / (reserveIn + amountIn);
    expect(expected < noFee).to.equal(true);

    const k0 = (await pair.reserve0()) * (await pair.reserve1());
    const outBefore = await tokenOut.balanceOf(await trader.getAddress());
    await expect(
      dexA.router
        .connect(trader)
        .swapExactTokensForTokens(
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          expected + 1n,
          await trader.getAddress(),
        ),
    ).to.be.revertedWith("slippage");
    expect(await pair.reserveOf(await tokenIn.getAddress())).to.equal(reserveIn);

    await send(
      dexA.router
        .connect(trader)
        .swapExactTokensForTokens(
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          expected,
          await trader.getAddress(),
        ),
    );
    expect((await tokenOut.balanceOf(await trader.getAddress())) - outBefore).to.equal(expected);
    // 手续费留在池子里，输入储备增加的是全额，不是扣费后的金额。
    expect((await pair.reserveOf(await tokenIn.getAddress())) - reserveIn).to.equal(amountIn);
    const k1 = (await pair.reserve0()) * (await pair.reserve1());
    expect(k1 > k0).to.equal(true);

    await expect(pair.connect(trader).swap(await tokenIn.getAddress(), 1n, 0, await trader.getAddress())).to.be
      .revertedWith("only router");

    const tokenId = (await dexA.nft.tokensOfOwner(await alice.getAddress()))[0];
    const aliceAddr = await alice.getAddress();
    const token0Erc = same(token0, await tokenA.getAddress()) ? tokenA : tokenB;
    const token1Erc = token0Erc === tokenA ? tokenB : tokenA;
    const before0 = await token0Erc.balanceOf(aliceAddr);
    const before1 = await token1Erc.balanceOf(aliceAddr);
    await send(dexA.router.connect(alice).removeLiquidity(tokenId, aliceAddr));
    const got0 = (await token0Erc.balanceOf(aliceAddr)) - before0;
    const got1 = (await token1Erc.balanceOf(aliceAddr)) - before1;
    // token0 是这次被买进的代币，手续费留在这边，取回应多于当初的 10000。
    expect(got0 > amount).to.equal(true);
    expect(got1 < amount).to.equal(true);
  });

  it("ignores tokens that are sent straight to the pair", async function () {
    const { tokenA, tokenB, dexA, signers } = await networkHelpers.loadFixture(deployFixture);
    const alice = signers[1];
    const routerAddr = await dexA.router.getAddress();
    const amount = parseEther("1000");
    await mintAndApprove(tokenA, alice, routerAddr, amount);
    await mintAndApprove(tokenB, alice, routerAddr, amount);
    await send(
      dexA.router
        .connect(alice)
        .createPairAndAddLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          amount,
          amount,
          await alice.getAddress(),
        ),
    );
    const pairAddr = await dexA.factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pair = await ethers.getContractAt("DexPair", pairAddr);
    const before0 = await pair.reserve0();
    const before1 = await pair.reserve1();
    await send(tokenA.mint(pairAddr, parseEther("50")));
    expect(await pair.reserve0()).to.equal(before0);
    expect(await pair.reserve1()).to.equal(before1);
  });
});

describe("ETH pair", function () {
  it("adds, swaps and removes native ETH", async function () {
    const { tokenA, weth, dexA, signers } = await networkHelpers.loadFixture(deployFixture);
    const alice = signers[1];
    const bob = signers[2];
    const routerAddr = await dexA.router.getAddress();
    const amountToken = parseEther("5000");
    await mintAndApprove(tokenA, alice, routerAddr, amountToken + parseEther("1000"));
    await send(
      dexA.router.connect(alice).createPairAndAddLiquidityETH(await tokenA.getAddress(), amountToken, await alice.getAddress(), {
        value: parseEther("5"),
      }),
    );

    const pairAddr = await dexA.factory.getPair(await tokenA.getAddress(), await weth.getAddress());
    const pair = await ethers.getContractAt("DexPair", pairAddr);
    expect(await pair.reserveOf(await weth.getAddress())).to.equal(parseEther("5"));

    // 多付的 ETH 会退回，储备只增加按比例需要的部分。
    const reserveWeth = await pair.reserveOf(await weth.getAddress());
    const reserveToken = await pair.reserveOf(await tokenA.getAddress());
    const addToken = parseEther("1000");
    const needEth = (addToken * reserveWeth) / reserveToken;
    await send(
      dexA.router.connect(alice).addLiquidityETH(await tokenA.getAddress(), addToken, await alice.getAddress(), {
        value: needEth + parseEther("1"),
      }),
    );
    expect(await pair.reserveOf(await weth.getAddress())).to.equal(reserveWeth + needEth);
    expect(await ethers.provider.getBalance(routerAddr)).to.equal(0n);

    const swapEth = parseEther("0.2");
    const expectedToken = await dexA.router.quote(await weth.getAddress(), await tokenA.getAddress(), swapEth);
    const tokenBefore = await tokenA.balanceOf(await bob.getAddress());
    await send(
      dexA.router.connect(bob).swapExactETHForTokens(await tokenA.getAddress(), 0, await bob.getAddress(), {
        value: swapEth,
      }),
    );
    expect((await tokenA.balanceOf(await bob.getAddress())) - tokenBefore).to.equal(expectedToken);

    const sell = parseEther("100");
    await mintAndApprove(tokenA, alice, routerAddr, sell);
    const expectedEth = await dexA.router.quote(await tokenA.getAddress(), await weth.getAddress(), sell);
    const bobEthBefore = await ethers.provider.getBalance(await bob.getAddress());
    await send(
      dexA.router.connect(alice).swapExactTokensForETH(await tokenA.getAddress(), sell, 0, await bob.getAddress()),
    );
    expect((await ethers.provider.getBalance(await bob.getAddress())) - bobEthBefore).to.equal(expectedEth);

    const tokenId = (await dexA.nft.tokensOfOwner(await alice.getAddress()))[0];
    const pos = await dexA.nft.getPosition(tokenId);
    const [out0, out1] = await pair.previewWithdraw(pos.shares);
    const wethAddr = await weth.getAddress();
    const ethOut = same(await pair.token0(), wethAddr) ? out0 : out1;
    const bobEth2 = await ethers.provider.getBalance(await bob.getAddress());
    await send(dexA.router.connect(alice).removeLiquidityETH(tokenId, await bob.getAddress()));
    expect((await ethers.provider.getBalance(await bob.getAddress())) - bobEth2).to.equal(ethOut);
  });
});

describe("simulation", function () {
  it("lets 20 accounts swap, add and remove", async function () {
    this.timeout(180000);
    const fix = await networkHelpers.loadFixture(deployFixture);
    const { owner, tokenA, tokenB, weth, dexA, dexB } = fix;
    const amount = parseEther("20000");
    for (const dex of [dexA, dexB]) {
      const routerAddr = await dex.router.getAddress();
      await mintAndApprove(tokenA, owner, routerAddr, amount);
      await mintAndApprove(tokenB, owner, routerAddr, amount);
      await send(weth.connect(owner).deposit({ value: parseEther("20") }));
      await send(weth.connect(owner).approve(routerAddr, MaxUint256));
      await send(
        dex.router.createPairAndAddLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          parseEther("10000"),
          parseEther("10000"),
          await owner.getAddress(),
        ),
      );
      await send(
        dex.router.createPairAndAddLiquidity(
          await tokenA.getAddress(),
          await weth.getAddress(),
          parseEther("5000"),
          parseEther("5"),
          await owner.getAddress(),
        ),
      );
    }

    const users = fix.signers.slice(1, 21);
    const result = await runSimulation({
      ethers,
      users,
      tokenA,
      tokenB,
      weth: await weth.getAddress(),
      exchanges: [dexA, dexB],
      rounds: 36,
      seed: 7,
      prepare: true,
      tolerateReverts: false,
    });

    expect(users.length).to.equal(20);
    expect(result.swaps > 0).to.equal(true);
    expect(result.adds > 0).to.equal(true);
    expect(result.removes > 0).to.equal(true);
    const pairAddr = await dexA.factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pair = await ethers.getContractAt("DexPair", pairAddr);
    expect((await pair.reserve0()) > 0n).to.equal(true);
    expect((await pair.reserve1()) > 0n).to.equal(true);
  });
});

describe("atomic arbitrage", function () {
  async function seedGap(fix: Awaited<ReturnType<typeof deployFixture>>) {
    const { owner, tokenA, tokenB, dexA, dexB } = fix;
    for (const [dex, amountB] of [
      [dexA, parseEther("10000")],
      [dexB, parseEther("20000")],
    ] as const) {
      const routerAddr = await dex.router.getAddress();
      await mintAndApprove(tokenA, owner, routerAddr, parseEther("10000"));
      await mintAndApprove(tokenB, owner, routerAddr, amountB);
      await send(
        dex.router.createPairAndAddLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          parseEther("10000"),
          amountB,
          await owner.getAddress(),
        ),
      );
    }
  }

  it("buys low and sells high in one transaction", async function () {
    const fix = await networkHelpers.loadFixture(deployFixture);
    await seedGap(fix);
    const { tokenA, tokenB, dexA, dexB, arb, signers } = fix;
    const trader = signers[1];
    const amountIn = parseEther("1000");
    await send(tokenA.mint(await trader.getAddress(), amountIn));
    await send(tokenA.connect(trader).approve(await arb.getAddress(), MaxUint256));

    const routerA = await dexA.router.getAddress();
    const routerB = await dexB.router.getAddress();
    const a = await tokenA.getAddress();
    const b = await tokenB.getAddress();
    const priceA = await arb.spotPrice(routerA, a, b);
    const priceB = await arb.spotPrice(routerB, a, b);
    expect(priceB > priceA).to.equal(true);

    const plan = await arb.preview(routerA, routerB, a, b, amountIn);
    expect(plan.profitable).to.equal(true);
    expect(plan.buyRouter).to.equal(routerB);
    expect(plan.sellRouter).to.equal(routerA);
    expect(plan.priceBuyBefore).to.equal(priceB);
    expect(plan.priceSellBefore).to.equal(priceA);
    expect(plan.profit > 0n).to.equal(true);

    const pairA = await ethers.getContractAt("DexPair", await dexA.factory.getPair(a, b));
    const pairB = await ethers.getContractAt("DexPair", await dexB.factory.getPair(a, b));
    const reserveBefore = await pairB.reserve0();
    await expect(
      arb.connect(trader).execute(routerA, routerB, a, b, amountIn, plan.profit + 1n),
    ).to.be.revertedWith("profit too small");
    expect(await pairB.reserve0()).to.equal(reserveBefore);
    expect(await tokenA.balanceOf(await trader.getAddress())).to.equal(amountIn);

    const gapBefore = priceB - priceA;
    const tx = await arb.connect(trader).execute(routerA, routerB, a, b, amountIn, plan.profit);
    const receipt = await tx.wait();
    const parsed = receipt.logs
      .map((log: any) => {
        try {
          return arb.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((item: any) => item && item.name === "ArbitrageExecuted");
    expect(parsed.args.profit).to.equal(plan.profit);
    expect(parsed.args.amountBought).to.equal(plan.amountBought);
    expect(parsed.args.amountBack).to.equal(plan.amountBack);
    expect(await tokenA.balanceOf(await trader.getAddress())).to.equal(amountIn + plan.profit);

    const priceAAfter = await arb.spotPrice(routerA, a, b);
    const priceBAfter = await arb.spotPrice(routerB, a, b);
    const gapAfter = priceBAfter > priceAAfter ? priceBAfter - priceAAfter : priceAAfter - priceBAfter;
    expect(gapAfter < gapBefore).to.equal(true);
    expect(parsed.args.priceBuyAfter).to.equal(priceBAfter);
    expect(parsed.args.priceSellAfter).to.equal(priceAAfter);
    expect(await pairA.reserve0()).to.not.equal(0n);
  });

  it("reverts the whole trade when there is no spread", async function () {
    const fix = await networkHelpers.loadFixture(deployFixture);
    const { owner, tokenA, tokenB, dexA, dexB, arb, signers } = fix;
    for (const dex of [dexA, dexB]) {
      const routerAddr = await dex.router.getAddress();
      await mintAndApprove(tokenA, owner, routerAddr, parseEther("10000"));
      await mintAndApprove(tokenB, owner, routerAddr, parseEther("10000"));
      await send(
        dex.router.createPairAndAddLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          parseEther("10000"),
          parseEther("10000"),
          await owner.getAddress(),
        ),
      );
    }
    const trader = signers[1];
    const amountIn = parseEther("100");
    await send(tokenA.mint(await trader.getAddress(), amountIn));
    await send(tokenA.connect(trader).approve(await arb.getAddress(), MaxUint256));
    const a = await tokenA.getAddress();
    const b = await tokenB.getAddress();
    const pair = await ethers.getContractAt("DexPair", await dexA.factory.getPair(a, b));
    const reserve0 = await pair.reserve0();
    await expect(
      arb.connect(trader).execute(await dexA.router.getAddress(), await dexB.router.getAddress(), a, b, amountIn, 0),
    ).to.be.revertedWith("no profit");
    expect(await pair.reserve0()).to.equal(reserve0);
    expect(await tokenA.balanceOf(await trader.getAddress())).to.equal(amountIn);
  });
});
