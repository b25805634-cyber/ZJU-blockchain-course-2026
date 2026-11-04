import { readFileSync } from "node:fs";
import path from "node:path";
import { formatEther } from "ethers";
import hre from "hardhat";
import { runSimulation } from "./simlib.js";

// 节点需要已经跑过 deploy。账户 0 的初始流动性不动，这里用后面 20 个账户。
async function main() {
  const file = path.resolve("..", "frontend", "src", "deployments", "localhost.json");
  const deployment = JSON.parse(readFileSync(file, "utf8"));
  const { ethers } = await hre.network.create();
  const signers = await ethers.getSigners();
  if (signers.length < 21) {
    throw new Error(`需要至少 21 个账户（1 个部署者 + 20 个用户），当前 ${signers.length}`);
  }

  const users = signers.slice(1, 21);
  const tokenA = await ethers.getContractAt("TestERC20", deployment.tokens.TKA.address);
  const tokenB = await ethers.getContractAt("TestERC20", deployment.tokens.TKB.address);
  const weth = deployment.tokens.WETH.address as string;

  const exchanges = [];
  for (const item of deployment.exchanges) {
    exchanges.push({
      name: item.name as string,
      router: await ethers.getContractAt("DexRouter", item.router),
      factory: await ethers.getContractAt("DexFactory", item.factory),
      nft: await ethers.getContractAt("LiquidityNFT", item.nft),
    });
  }

  console.log("模拟前价格（1 TKA 值多少 TKB）");
  for (const ex of exchanges) {
    await printPrice(ethers, ex.name, ex.factory, await tokenA.getAddress(), await tokenB.getAddress());
  }

  const result = await runSimulation({
    ethers,
    users,
    tokenA,
    tokenB,
    weth,
    exchanges,
    rounds: 30,
    seed: 20261106,
    prepare: true,
    tolerateReverts: true,
    log: (line) => console.log(line),
  });

  console.log("模拟后价格（1 TKA 值多少 TKB）");
  for (const ex of exchanges) {
    await printPrice(ethers, ex.name, ex.factory, await tokenA.getAddress(), await tokenB.getAddress());
  }
  console.log(result);
  if (result.swaps === 0 || result.adds === 0 || result.removes === 0) {
    throw new Error("模拟没有同时覆盖兑换、加池和撤池");
  }
}

async function printPrice(ethers: any, name: string, factory: any, tokenIn: string, tokenOut: string) {
  const pairAddr = await factory.getPair(tokenIn, tokenOut);
  const pair = await ethers.getContractAt("DexPair", pairAddr);
  const token0 = (await pair.token0()) as string;
  const reserve0 = (await pair.reserve0()) as bigint;
  const reserve1 = (await pair.reserve1()) as bigint;
  const reserveIn = token0.toLowerCase() === tokenIn.toLowerCase() ? reserve0 : reserve1;
  const reserveOut = token0.toLowerCase() === tokenIn.toLowerCase() ? reserve1 : reserve0;
  console.log(`${name}: ${formatEther((reserveOut * 10n ** 18n) / reserveIn)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
