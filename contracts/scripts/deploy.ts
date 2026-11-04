import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatEther, MaxUint256, parseEther } from "ethers";
import hre, { artifacts } from "hardhat";

async function main() {
  const { ethers } = await hre.network.create();
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  console.log(`deployer ${deployerAddr}`);

  const tokenA = await deploy(ethers, "TestERC20", ["Token A", "TKA", deployerAddr]);
  const tokenB = await deploy(ethers, "TestERC20", ["Token B", "TKB", deployerAddr]);
  const weth = await deploy(ethers, "WETH");
  const faucet = await deploy(ethers, "EthFaucet", [], { value: parseEther("100") });

  const dexA = await deployExchange(ethers, deployerAddr, weth, "MiniDEX-A", "MDA-LP");
  const dexB = await deployExchange(ethers, deployerAddr, weth, "MiniDEX-B", "MDB-LP");
  const arb = await deploy(ethers, "AtomicArbitrage");

  await (await tokenA.mint(deployerAddr, parseEther("1000000"))).wait();
  await (await tokenB.mint(deployerAddr, parseEther("1000000"))).wait();
  // TKA/WETH 两个池一共 13 ETH。TKB/ETH 留给前端自己创建。
  await (await weth.deposit({ value: parseEther("13") })).wait();

  const tokenAAddr = await tokenA.getAddress();
  const tokenBAddr = await tokenB.getAddress();
  const wethAddr = await weth.getAddress();

  for (const dex of [dexA, dexB]) {
    const routerAddr = await dex.router.getAddress();
    await (await tokenA.approve(routerAddr, MaxUint256)).wait();
    await (await tokenB.approve(routerAddr, MaxUint256)).wait();
    await (await weth.approve(routerAddr, MaxUint256)).wait();
  }

  await seed(dexA, tokenAAddr, tokenBAddr, parseEther("10000"), parseEther("10000"), deployerAddr, "TKA/TKB 10000/10000");
  await seed(dexB, tokenAAddr, tokenBAddr, parseEther("10000"), parseEther("20000"), deployerAddr, "TKA/TKB 10000/20000");
  await seed(dexA, tokenAAddr, wethAddr, parseEther("5000"), parseEther("5"), deployerAddr, "TKA/WETH 5000/5");
  await seed(dexB, tokenAAddr, wethAddr, parseEther("5000"), parseEther("8"), deployerAddr, "TKA/WETH 5000/8");

  const plan = await arb.preview(
    await dexA.router.getAddress(),
    await dexB.router.getAddress(),
    tokenAAddr,
    tokenBAddr,
    parseEther("1000"),
  );
  console.log("--- 套利预览：花 1000 TKA 买 TKB ---");
  console.log(`profitable ${plan.profitable}`);
  console.log(`buyRouter ${plan.buyRouter}`);
  console.log(`sellRouter ${plan.sellRouter}`);
  console.log(`bought TKB ${formatEther(plan.amountBought)}`);
  console.log(`back TKA ${formatEther(plan.amountBack)}`);
  console.log(`profit TKA ${formatEther(plan.profit)}`);
  console.log(`priceBuyBefore ${formatEther(plan.priceBuyBefore)}`);
  console.log(`priceSellBefore ${formatEther(plan.priceSellBefore)}`);
  console.log(`priceBuyAfter ${formatEther(plan.priceBuyAfter)}`);
  console.log(`priceSellAfter ${formatEther(plan.priceSellAfter)}`);

  const network = await ethers.provider.getNetwork();
  const deployment = {
    chainId: Number(network.chainId),
    rpcUrl: "http://127.0.0.1:8545",
    tokens: {
      TKA: {
        address: tokenAAddr,
        name: await tokenA.name(),
        symbol: await tokenA.symbol(),
      },
      TKB: {
        address: tokenBAddr,
        name: await tokenB.name(),
        symbol: await tokenB.symbol(),
      },
      WETH: {
        address: wethAddr,
        name: await weth.name(),
        symbol: await weth.symbol(),
      },
    },
    ethFaucet: await faucet.getAddress(),
    exchanges: [
      {
        name: dexA.name,
        factory: await dexA.factory.getAddress(),
        router: await dexA.router.getAddress(),
        nft: await dexA.nft.getAddress(),
      },
      {
        name: dexB.name,
        factory: await dexB.factory.getAddress(),
        router: await dexB.router.getAddress(),
        nft: await dexB.nft.getAddress(),
      },
    ],
    arbitrage: await arb.getAddress(),
    abis: {
      erc20: (await artifacts.readArtifact("TestERC20")).abi,
      weth: (await artifacts.readArtifact("WETH")).abi,
      faucet: (await artifacts.readArtifact("EthFaucet")).abi,
      factory: (await artifacts.readArtifact("DexFactory")).abi,
      router: (await artifacts.readArtifact("DexRouter")).abi,
      nft: (await artifacts.readArtifact("LiquidityNFT")).abi,
      pair: (await artifacts.readArtifact("DexPair")).abi,
      arbitrage: (await artifacts.readArtifact("AtomicArbitrage")).abi,
    },
  };

  const outDir = path.resolve("..", "frontend", "src", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "localhost.json");
  writeFileSync(outFile, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
}

async function deploy(ethers: any, name: string, args: any[] = [], overrides: any = {}) {
  const contract = await ethers.deployContract(name, args, overrides);
  await contract.waitForDeployment();
  console.log(`${name} -> ${await contract.getAddress()}`);
  return contract;
}

async function deployExchange(ethers: any, owner: string, weth: any, name: string, symbol: string) {
  const factory = await deploy(ethers, "DexFactory", [owner]);
  const nft = await deploy(ethers, "LiquidityNFT", [`${name} LP`, symbol]);
  const router = await deploy(ethers, "DexRouter", [
    await factory.getAddress(),
    await weth.getAddress(),
    await nft.getAddress(),
  ]);
  await (await factory.setRouter(await router.getAddress())).wait();
  await (await nft.setRouter(await router.getAddress())).wait();
  console.log(`${name} ready`);
  return { name, factory, nft, router };
}

async function seed(
  dex: any,
  tokenX: string,
  tokenY: string,
  amountX: bigint,
  amountY: bigint,
  to: string,
  label: string,
) {
  const tx = await dex.router.createPairAndAddLiquidity(tokenX, tokenY, amountX, amountY, to);
  await tx.wait();
  console.log(`seed ${dex.name} ${label}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
