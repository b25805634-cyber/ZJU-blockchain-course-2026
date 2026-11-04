import { Contract, MaxUint256, type Provider, type Signer } from "ethers";
import localhostJson from "./deployments/localhost.json";
import sepoliaJson from "./deployments/sepolia.json";

export const HARDHAT_CHAIN_ID = 31337;
export const SEPOLIA_CHAIN_ID = 11155111;

export const abis = localhostJson.abis;

export type DexDeployment = {
  chainId: number;
  rpcUrl: string;
  ready: boolean;
  localFaucet: boolean;
  tokens: {
    TKA: { address: string; name: string; symbol: string };
    TKB: { address: string; name: string; symbol: string };
    WETH: { address: string; name: string; symbol: string };
  };
  ethFaucet: string;
  exchanges: { name: string; factory: string; router: string; nft: string }[];
  arbitrage: string;
};

function asDeployment(
  file: {
    chainId: number;
    rpcUrl: string;
    ready?: boolean;
    localFaucet?: boolean;
    tokens: DexDeployment["tokens"];
    ethFaucet: string;
    exchanges: DexDeployment["exchanges"];
    arbitrage: string;
  },
  fallback: { ready: boolean; localFaucet: boolean },
): DexDeployment {
  return {
    chainId: file.chainId,
    rpcUrl: file.rpcUrl,
    ready: file.ready ?? fallback.ready,
    localFaucet: file.localFaucet ?? fallback.localFaucet,
    tokens: file.tokens,
    ethFaucet: file.ethFaucet,
    exchanges: file.exchanges,
    arbitrage: file.arbitrage,
  };
}

export const localhostDeployment = asDeployment(localhostJson, { ready: true, localFaucet: true });
export const sepoliaDeployment = asDeployment(sepoliaJson, { ready: false, localFaucet: false });

// 作业默认走本地。只有钱包明确停在 Sepolia 才换那份地址。
export function deploymentForChain(chainId: number | null): DexDeployment | null {
  if (chainId === SEPOLIA_CHAIN_ID) return sepoliaDeployment;
  if (chainId === HARDHAT_CHAIN_ID) return localhostDeployment;
  return null;
}

export function networkLabel(chainId: number | null) {
  if (chainId === HARDHAT_CHAIN_ID) return "Hardhat 本地";
  if (chainId === SEPOLIA_CHAIN_ID) return "Sepolia";
  if (chainId === null) return "未选择网络";
  return `chain ${chainId}`;
}

const ONE = 10n ** 18n;

export function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

export function short(addr: string) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function fmt(value: bigint, digits = 4) {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const whole = v / ONE;
  const frac = (v % ONE).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  // 锁住的 1000 wei 之类的灰尘，四位小数会变成 0，页面上容易看成池子空了。
  if (v > 0n && whole === 0n && frac === "") return "<0.0001";
  const text = frac ? `${whole.toString()}.${frac}` : whole.toString();
  return neg ? `-${text}` : text;
}

export function parseAmount(text: string) {
  const s = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) {
    throw new Error("数量格式不对");
  }
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * ONE + BigInt(frac.padEnd(18, "0"));
}

export function errText(err: unknown) {
  if (err && typeof err === "object") {
    const value = err as { shortMessage?: string; reason?: string; message?: string };
    const raw = value.shortMessage || value.reason || value.message || "交易失败";
    const matched = raw.match(/reason="([^"]+)"/);
    return matched ? matched[1] : raw;
  }
  return "交易失败";
}

export function fmtTime(ts: bigint) {
  if (ts === 0n) return "-";
  return new Date(Number(ts) * 1000).toLocaleString();
}

export type SideId = "TKA" | "TKB" | "ETH" | "WETH";

export function resolveSide(dep: DexDeployment, id: SideId) {
  const weth = dep.tokens.WETH.address;
  if (id === "ETH") return { address: weth, native: true, symbol: "ETH" };
  if (id === "WETH") return { address: weth, native: false, symbol: "WETH" };
  if (id === "TKA") return { address: dep.tokens.TKA.address, native: false, symbol: "TKA" };
  return { address: dep.tokens.TKB.address, native: false, symbol: "TKB" };
}

export function displaySymbol(dep: DexDeployment, addr: string) {
  if (same(addr, dep.tokens.WETH.address)) return "ETH";
  if (same(addr, dep.tokens.TKA.address)) return "TKA";
  if (same(addr, dep.tokens.TKB.address)) return "TKB";
  return short(addr);
}

export function exchangeNameOfRouter(dep: DexDeployment, addr: string) {
  const found = dep.exchanges.find((item) => same(item.router, addr));
  return found ? found.name : short(addr);
}

export function bind(address: string, abi: readonly unknown[], runner: Signer | Provider) {
  return new Contract(address, abi as never, runner);
}

export async function ensureApprove(token: Contract, owner: string, spender: string, amount: bigint) {
  const allowance = (await token.allowance(owner, spender)) as bigint;
  if (allowance >= amount) return;
  const tx = await token.approve(spender, MaxUint256);
  await tx.wait();
}

export type PoolRow = {
  key: string;
  exchangeIndex: number;
  exchangeName: string;
  pair: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  totalShares: bigint;
};

export type PositionRow = {
  exchangeIndex: number;
  exchangeName: string;
  tokenId: bigint;
  pair: string;
  owner: string;
  token0: string;
  token1: string;
  shares: bigint;
  amount0: bigint;
  amount1: bigint;
  out0: bigint;
  out1: bigint;
  createdAt: bigint;
};

export async function loadPools(dep: DexDeployment, provider: Provider): Promise<PoolRow[]> {
  const rows: PoolRow[] = [];
  for (let i = 0; i < dep.exchanges.length; i++) {
    const ex = dep.exchanges[i];
    const factory = bind(ex.factory, abis.factory, provider);
    const count = Number(await factory.allPairsLength());
    for (let j = 0; j < count; j++) {
      const pair = (await factory.allPairs(j)) as string;
      const pool = bind(pair, abis.pair, provider);
      const state = await pool.getState();
      rows.push({
        key: `${i}-${pair.toLowerCase()}`,
        exchangeIndex: i,
        exchangeName: ex.name,
        pair,
        token0: state[0] as string,
        token1: state[1] as string,
        reserve0: state[2] as bigint,
        reserve1: state[3] as bigint,
        totalShares: state[4] as bigint,
      });
    }
  }
  return rows;
}

async function readPosition(
  dep: DexDeployment,
  provider: Provider,
  exchangeIndex: number,
  tokenId: bigint,
  owner: string,
): Promise<PositionRow> {
  const ex = dep.exchanges[exchangeIndex];
  const nft = bind(ex.nft, abis.nft, provider);
  const pos = await nft.getPosition(tokenId);
  const pair = bind(pos.pair as string, abis.pair, provider);
  const state = await pair.getState();
  const preview = await pair.previewWithdraw(pos.shares);
  return {
    exchangeIndex,
    exchangeName: ex.name,
    tokenId,
    pair: pos.pair as string,
    owner,
    token0: state[0] as string,
    token1: state[1] as string,
    shares: pos.shares as bigint,
    amount0: pos.amount0 as bigint,
    amount1: pos.amount1 as bigint,
    out0: preview[0] as bigint,
    out1: preview[1] as bigint,
    createdAt: pos.createdAt as bigint,
  };
}

export async function loadMyNfts(dep: DexDeployment, provider: Provider, owner: string) {
  const rows: PositionRow[] = [];
  for (let i = 0; i < dep.exchanges.length; i++) {
    const nft = bind(dep.exchanges[i].nft, abis.nft, provider);
    const ids = (await nft.tokensOfOwner(owner)) as bigint[];
    for (const tokenId of ids) {
      rows.push(await readPosition(dep, provider, i, tokenId, owner));
    }
  }
  return rows;
}

export async function loadLps(dep: DexDeployment, provider: Provider, exchangeIndex: number, pair: string) {
  const nft = bind(dep.exchanges[exchangeIndex].nft, abis.nft, provider);
  const ids = (await nft.tokensOfPair(pair)) as bigint[];
  const rows: PositionRow[] = [];
  for (const tokenId of ids) {
    const owner = (await nft.ownerOf(tokenId)) as string;
    rows.push(await readPosition(dep, provider, exchangeIndex, tokenId, owner));
  }
  return rows;
}

export async function loadBalances(dep: DexDeployment, provider: Provider, owner: string) {
  const tka = bind(dep.tokens.TKA.address, abis.erc20, provider);
  const tkb = bind(dep.tokens.TKB.address, abis.erc20, provider);
  const weth = bind(dep.tokens.WETH.address, abis.weth, provider);
  const [eth, wethBal, tkaBal, tkbBal] = await Promise.all([
    provider.getBalance(owner),
    weth.balanceOf(owner) as Promise<bigint>,
    tka.balanceOf(owner) as Promise<bigint>,
    tkb.balanceOf(owner) as Promise<bigint>,
  ]);
  return { eth, weth: wethBal, tka: tkaBal, tkb: tkbBal };
}
