import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatEther, MaxUint256, parseEther } from "ethers";
import hre, { artifacts } from "hardhat";

async function main() {
  const { ethers } = await hre.network.create();
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  console.log(`deployer ${deployerAddr}`);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const sepolia = chainId === 11155111;
  if (sepolia) {
    const bal = await ethers.provider.getBalance(deployerAddr);
    console.log(`sepolia ETH ${formatEther(bal)}。gas 和池子里的 ETH 都从这里扣。`);
    if (bal < parseEther("0.01")) {
      throw new Error("Sepolia ETH 太少。先去水龙头领测试币，再部署。");
    }
  }

  const tokenA = await deploy(ethers, "TestERC20", ["Token A", "TKA", deployerAddr]);
  const tokenB = await deploy(ethers, "TestERC20", ["Token B", "TKB", deployerAddr]);
  const weth = await deploy(ethers, "WETH");
  // 本地水龙头里放 100 ETH。Sepolia 不部署 EthFaucet，manifest 里写零地址。
  const faucet = sepolia
    ? null
    : await deploy(ethers, "EthFaucet", [], { value: parseEther("100") });

  const dexA = await deployExchange(ethers, deployerAddr, weth, "MiniDEX-A", "MDA-LP");
  const dexB = await deployExchange(ethers, deployerAddr, weth, "MiniDEX-B", "MDB-LP");
  const arb = await deploy(ethers, "AtomicArbitrage");

  // Sepolia 只铸够铺池和自己试一笔。本地仍然是大数，方便 20 个账户模拟。
  const mintA = sepolia ? parseEther("4000") : parseEther("1000000");
  const mintB = sepolia ? parseEther("4000") : parseEther("1000000");
  const wrapEth = sepolia ? parseEther("0.002") : parseEther("13");
  await (await tokenA.mint(deployerAddr, mintA)).wait();
  await (await tokenB.mint(deployerAddr, mintB)).wait();
  // TKB/ETH 留给前端自己创建。Sepolia 的 ETH 池只有 0.0008 和 0.0012 WETH。
  await (await weth.deposit({ value: wrapEth })).wait();

  const tokenAAddr = await tokenA.getAddress();
  const tokenBAddr = await tokenB.getAddress();
  const wethAddr = await weth.getAddress();

  for (const dex of [dexA, dexB]) {
    const routerAddr = await dex.router.getAddress();
    await (await tokenA.approve(routerAddr, MaxUint256)).wait();
    await (await tokenB.approve(routerAddr, MaxUint256)).wait();
    await (await weth.approve(routerAddr, MaxUint256)).wait();
  }

  if (sepolia) {
    await seed(dexA, tokenAAddr, tokenBAddr, parseEther("1000"), parseEther("1000"), deployerAddr, "TKA/TKB 1000/1000");
    await seed(dexB, tokenAAddr, tokenBAddr, parseEther("1000"), parseEther("2000"), deployerAddr, "TKA/TKB 1000/2000");
    await seed(dexA, tokenAAddr, wethAddr, parseEther("100"), parseEther("0.0008"), deployerAddr, "TKA/WETH 100/0.0008");
    await seed(dexB, tokenAAddr, wethAddr, parseEther("100"), parseEther("0.0012"), deployerAddr, "TKA/WETH 100/0.0012");
  } else {
    await seed(dexA, tokenAAddr, tokenBAddr, parseEther("10000"), parseEther("10000"), deployerAddr, "TKA/TKB 10000/10000");
    await seed(dexB, tokenAAddr, tokenBAddr, parseEther("10000"), parseEther("20000"), deployerAddr, "TKA/TKB 10000/20000");
    await seed(dexA, tokenAAddr, wethAddr, parseEther("5000"), parseEther("5"), deployerAddr, "TKA/WETH 5000/5");
    await seed(dexB, tokenAAddr, wethAddr, parseEther("5000"), parseEther("8"), deployerAddr, "TKA/WETH 5000/8");
  }

  const previewAmount = sepolia ? parseEther("100") : parseEther("1000");
  const plan = await arb.preview(
    await dexA.router.getAddress(),
    await dexB.router.getAddress(),
    tokenAAddr,
    tokenBAddr,
    previewAmount,
  );
  console.log(`--- 套利预览：花 ${sepolia ? "100" : "1000"} TKA 买 TKB ---`);
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

  const deployment = {
    chainId,
    // 页面连上 MetaMask 后走钱包节点。这里不写带 key 的 RPC，也不写私钥。
    rpcUrl: sepolia ? "https://rpc.sepolia.org" : "http://127.0.0.1:8545",
    ready: true,
    localFaucet: !sepolia,
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
    ethFaucet: faucet ? await faucet.getAddress() : "0x0000000000000000000000000000000000000000",
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
  const outFile = path.join(outDir, sepolia ? "sepolia.json" : "localhost.json");
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
