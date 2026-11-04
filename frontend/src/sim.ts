import { Contract, FetchRequest, HDNodeWallet, JsonRpcProvider } from "ethers";
import { runSimulation } from "../../contracts/scripts/simlib";
import { abis, localhostDeployment as deployment } from "./chain";

// Hardhat 默认公开助记词，只给本地 31337 用。
export const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export function rpcProvider() {
  const req = new FetchRequest(deployment.rpcUrl);
  req.timeout = 8000;
  // Hardhat 自动出块，250ms 内的 nonce 查询会被 ethers 缓存，连着发两笔就会 nonce too low。
  return new JsonRpcProvider(req, deployment.chainId, { staticNetwork: true, cacheTimeout: -1 });
}

export function walletAt(index: number, provider: JsonRpcProvider) {
  return HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
}

const abiByName: Record<string, readonly unknown[]> = {
  DexPair: abis.pair,
  TestERC20: abis.erc20,
  DexRouter: abis.router,
  DexFactory: abis.factory,
  LiquidityNFT: abis.nft,
};

export async function runLocalSimulation(rounds: number, log: (line: string) => void) {
  const provider = rpcProvider();
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== deployment.chainId) {
    throw new Error(`链 id 是 ${network.chainId}，模拟只在 ${deployment.chainId} 上跑`);
  }
  const deployer = walletAt(0, provider);
  const users = Array.from({ length: 20 }, (_, index) => walletAt(index + 1, provider));
  const ethersShim = {
    provider,
    getContractAt: async (name: string, address: string, signer?: unknown) =>
      new Contract(address, abiByName[name] as never, (signer as never) ?? provider),
  };
  const exchanges = deployment.exchanges.map((item) => ({
    name: item.name,
    router: new Contract(item.router, abis.router, deployer),
    factory: new Contract(item.factory, abis.factory, deployer),
    nft: new Contract(item.nft, abis.nft, deployer),
  }));
  return runSimulation({
    ethers: ethersShim,
    users,
    tokenA: new Contract(deployment.tokens.TKA.address, abis.erc20, deployer),
    tokenB: new Contract(deployment.tokens.TKB.address, abis.erc20, deployer),
    weth: deployment.tokens.WETH.address,
    exchanges,
    rounds,
    seed: 20261106,
    prepare: true,
    tolerateReverts: true,
    log,
  });
}
