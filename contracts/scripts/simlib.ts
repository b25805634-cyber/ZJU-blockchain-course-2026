import { MaxUint256, parseEther } from "ethers";

export type SimExchange = {
  name: string;
  router: any;
  factory: any;
  nft: any;
};

export type SimResult = {
  swaps: number;
  adds: number;
  removes: number;
  skips: number;
};

function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function errorText(err: unknown) {
  if (err && typeof err === "object") {
    const value = err as { shortMessage?: string; message?: string };
    return value.shortMessage || value.message || String(err);
  }
  return String(err);
}

async function wait(txPromise: Promise<any>) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (receipt && receipt.status === 0) {
    throw new Error("transaction reverted");
  }
  return receipt;
}

// 20 个账户随机兑换、加池、撤池。金额封顶，避免一次把池子打空。
export async function runSimulation(opts: {
  ethers: {
    getContractAt: (name: string, address: string, signer?: any) => Promise<any>;
    provider: { getBalance: (address: string) => Promise<bigint> };
  };
  users: any[];
  tokenA: any;
  tokenB: any;
  weth: string;
  exchanges: SimExchange[];
  rounds: number;
  seed?: number;
  prepare?: boolean;
  tolerateReverts?: boolean;
  log?: (line: string) => void;
}): Promise<SimResult> {
  if (opts.users.length < 20) {
    throw new Error(`需要至少 20 个模拟账户，当前 ${opts.users.length}`);
  }
  const log = opts.log ?? (() => {});
  const rng = makeRng(opts.seed ?? 1);
  const tokenAAddr = (await opts.tokenA.getAddress()) as string;
  const tokenBAddr = (await opts.tokenB.getAddress()) as string;
  const result: SimResult = { swaps: 0, adds: 0, removes: 0, skips: 0 };

  const tokenByAddress = (addr: string) => {
    if (same(addr, tokenAAddr)) return opts.tokenA;
    if (same(addr, tokenBAddr)) return opts.tokenB;
    throw new Error(`未知代币 ${addr}`);
  };

  if (opts.prepare) {
    for (const user of opts.users) {
      const userAddr = await user.getAddress();
      for (const token of [opts.tokenA, opts.tokenB]) {
        const balance = (await token.balanceOf(userAddr)) as bigint;
        const claimed = (await token.claims(userAddr)) as bigint;
        if (balance < parseEther("100") && claimed < 3n) {
          await wait(token.connect(user).claim());
        }
        for (const ex of opts.exchanges) {
          const routerAddr = await ex.router.getAddress();
          const allowance = (await token.allowance(userAddr, routerAddr)) as bigint;
          if (allowance < parseEther("1000000")) {
            await wait(token.connect(user).approve(routerAddr, MaxUint256));
          }
        }
      }
    }
    log(`准备完成：${opts.users.length} 个账户已领币并授权`);
  }

  for (let round = 0; round < opts.rounds; round++) {
    const forcedAdd = round < 4;
    const user = opts.users[forcedAdd ? round : rng() % opts.users.length];
    const userAddr = await user.getAddress();
    let kind: "swap" | "add" | "remove" = forcedAdd ? "add" : "swap";
    if (!forcedAdd) {
      const roll = rng() % 100;
      kind = roll < 45 ? "swap" : roll < 75 ? "add" : "remove";
    }
    const ex = opts.exchanges[rng() % opts.exchanges.length];
    const pairCount = Number(await ex.factory.allPairsLength());
    if (pairCount === 0) {
      result.skips += 1;
      continue;
    }
    const pairAddr = (await ex.factory.allPairs(rng() % pairCount)) as string;

    try {
      const done = await runAction(kind);
      if (done === "swap") result.swaps += 1;
      else if (done === "add") result.adds += 1;
      else if (done === "remove") result.removes += 1;
      else result.skips += 1;
      if (done !== "skip") {
        log(`#${round + 1} ${ex.name} ${short(userAddr)} ${label(done)}`);
      }
    } catch (err) {
      if (!opts.tolerateReverts) {
        throw new Error(`第 ${round + 1} 轮 ${kind} 失败: ${errorText(err)}`);
      }
      result.skips += 1;
      log(`#${round + 1} 跳过 ${kind}: ${errorText(err)}`);
    }

    async function runAction(initial: "swap" | "add" | "remove"): Promise<"swap" | "add" | "remove" | "skip"> {
      if (initial === "remove") {
        if (await tryRemove()) return "remove";
        if (await trySwap()) return "swap";
        if (await tryAdd()) return "add";
        return "skip";
      }
      if (initial === "swap") {
        if (await trySwap()) return "swap";
        if (await tryAdd()) return "add";
        return "skip";
      }
      if (await tryAdd()) return "add";
      if (await trySwap()) return "swap";
      return "skip";
    }

    async function loadPair() {
      const pair = await opts.ethers.getContractAt("DexPair", pairAddr, user);
      const token0 = (await pair.token0()) as string;
      const token1 = (await pair.token1()) as string;
      const reserve0 = (await pair.reserve0()) as bigint;
      const reserve1 = (await pair.reserve1()) as bigint;
      return { pair, token0, token1, reserve0, reserve1 };
    }

    async function trySwap() {
      const { token0, token1, reserve0, reserve1 } = await loadPair();
      if (reserve0 === 0n || reserve1 === 0n) return false;
      const involvesEth = same(token0, opts.weth) || same(token1, opts.weth);
      const dir = rng() % 2;
      if (!involvesEth) {
        const tokenIn = dir === 0 ? token0 : token1;
        const tokenOut = dir === 0 ? token1 : token0;
        const reserveIn = dir === 0 ? reserve0 : reserve1;
        const erc20 = tokenByAddress(tokenIn);
        const balance = (await erc20.balanceOf(userAddr)) as bigint;
        let amount = balance / 20n;
        const cap = reserveIn / 20n;
        if (amount > cap) amount = cap;
        if (amount < parseEther("1")) return false;
        await wait(
          ex.router.connect(user).swapExactTokensForTokens(tokenIn, tokenOut, amount, 0, userAddr),
        );
        return true;
      }

      const tokenAddr = same(token0, opts.weth) ? token1 : token0;
      const reserveToken = same(tokenAddr, token0) ? reserve0 : reserve1;
      const reserveEth = same(tokenAddr, token0) ? reserve1 : reserve0;
      if (dir === 0) {
        let amountEth = parseEther("0.05");
        const cap = reserveEth / 20n;
        if (cap > 0n && amountEth > cap) amountEth = cap;
        const ethBal = await opts.ethers.provider.getBalance(userAddr);
        if (amountEth === 0n || ethBal < amountEth + parseEther("0.2")) return false;
        await wait(ex.router.connect(user).swapExactETHForTokens(tokenAddr, 0, userAddr, { value: amountEth }));
        return true;
      }
      const erc20 = tokenByAddress(tokenAddr);
      const balance = (await erc20.balanceOf(userAddr)) as bigint;
      let amount = balance / 20n;
      const cap = reserveToken / 20n;
      if (amount > cap) amount = cap;
      if (amount < parseEther("1")) return false;
      await wait(ex.router.connect(user).swapExactTokensForETH(tokenAddr, amount, 0, userAddr));
      return true;
    }

    async function tryAdd() {
      const { token0, token1, reserve0, reserve1 } = await loadPair();
      if (reserve0 === 0n || reserve1 === 0n) return false;
      const involvesEth = same(token0, opts.weth) || same(token1, opts.weth);
      if (!involvesEth) {
        const ercA = tokenByAddress(token0);
        const ercB = tokenByAddress(token1);
        const balA = (await ercA.balanceOf(userAddr)) as bigint;
        const balB = (await ercB.balanceOf(userAddr)) as bigint;
        let amount0 = balA / 40n;
        if (amount0 > parseEther("200")) amount0 = parseEther("200");
        if (amount0 < parseEther("10")) return false;
        const amount1 = (amount0 * reserve1) / reserve0;
        if (amount1 === 0n || amount1 > balB) return false;
        await wait(ex.router.connect(user).addLiquidity(token0, token1, amount0, amount1, userAddr));
        return true;
      }

      const tokenAddr = same(token0, opts.weth) ? token1 : token0;
      const erc20 = tokenByAddress(tokenAddr);
      const balance = (await erc20.balanceOf(userAddr)) as bigint;
      const reserveToken = same(tokenAddr, token0) ? reserve0 : reserve1;
      const reserveEth = same(tokenAddr, token0) ? reserve1 : reserve0;
      let amountToken = balance / 40n;
      if (amountToken > parseEther("200")) amountToken = parseEther("200");
      if (amountToken < parseEther("10")) return false;
      const amountEth = (amountToken * reserveEth) / reserveToken;
      const ethBal = await opts.ethers.provider.getBalance(userAddr);
      if (amountEth === 0n || ethBal < amountEth + parseEther("0.2")) return false;
      await wait(
        ex.router.connect(user).addLiquidityETH(tokenAddr, amountToken, userAddr, { value: amountEth }),
      );
      return true;
    }

    async function tryRemove() {
      let holder = user;
      let holderAddr = userAddr;
      let ids = (await ex.nft.tokensOfOwner(holderAddr)) as bigint[];
      if (ids.length === 0) {
        for (const candidate of opts.users) {
          const addr = await candidate.getAddress();
          const owned = (await ex.nft.tokensOfOwner(addr)) as bigint[];
          if (owned.length > 0) {
            holder = candidate;
            holderAddr = addr;
            ids = owned;
            break;
          }
        }
      }
      if (ids.length === 0) return false;
      const chosen = ids[ids.length - 1];
      const pos = await ex.nft.getPosition(chosen);
      const position = await opts.ethers.getContractAt("DexPair", pos.pair, holder);
      const token0 = (await position.token0()) as string;
      const token1 = (await position.token1()) as string;
      const involvesEth = same(token0, opts.weth) || same(token1, opts.weth);
      if (involvesEth) {
        await wait(ex.router.connect(holder).removeLiquidityETH(chosen, holderAddr));
      } else {
        await wait(ex.router.connect(holder).removeLiquidity(chosen, holderAddr));
      }
      return true;
    }
  }

  log(
    `模拟结束：兑换 ${result.swaps}，加池 ${result.adds}，撤池 ${result.removes}，跳过 ${result.skips}`,
  );
  return result;
}

function short(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function label(kind: "swap" | "add" | "remove") {
  if (kind === "swap") return "兑换";
  if (kind === "add") return "加池";
  return "撤池";
}
