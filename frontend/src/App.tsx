import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrowserProvider, type Provider, type Signer } from 'ethers';
import './App.css';
import {
  abis,
  bind,
  deployment,
  displaySymbol,
  ensureApprove,
  errText,
  exchangeNameOfRouter,
  fmt,
  fmtTime,
  loadBalances,
  loadLps,
  loadMyNfts,
  loadPools,
  parseAmount,
  resolveSide,
  same,
  short,
  TKA,
  TKB,
  WETH,
  type PoolRow,
  type PositionRow,
  type SideId,
} from './chain';
import { rpcProvider, runLocalSimulation, walletAt } from './sim';

type ArbView = {
  profitable: boolean;
  buyName: string;
  sellName: string;
  amountBought: bigint;
  amountBack: bigint;
  profit: bigint;
  priceBuyBefore: bigint;
  priceSellBefore: bigint;
  priceBuyAfter: bigint;
  priceSellAfter: bigint;
  tokenIn: string;
  tokenOut: string;
  source: string;
};

const emptyBal = { eth: 0n, weth: 0n, tka: 0n, tkb: 0n };

function App() {
  const signerRef = useRef<Signer | null>(null);
  const providerRef = useRef<Provider | null>(null);
  const selectedRef = useRef('');

  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [balances, setBalances] = useState(emptyBal);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [selected, setSelected] = useState('');
  const [lps, setLps] = useState<PositionRow[]>([]);
  const [nfts, setNfts] = useState<PositionRow[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exchangeIndex, setExchangeIndex] = useState(0);
  const [poolFilter, setPoolFilter] = useState(-1);

  const [createLeft, setCreateLeft] = useState<SideId>('TKB');
  const [createRight, setCreateRight] = useState<SideId>('ETH');
  const [createAmtLeft, setCreateAmtLeft] = useState('1000');
  const [createAmtRight, setCreateAmtRight] = useState('1');

  const [swapIn, setSwapIn] = useState<SideId>('TKA');
  const [swapOut, setSwapOut] = useState<SideId>('TKB');
  const [swapAmt, setSwapAmt] = useState('10');
  const [slippage, setSlippage] = useState('1');
  const [quoteText, setQuoteText] = useState('');

  const [add0, setAdd0] = useState('100');
  const [add1, setAdd1] = useState('100');
  const [simRounds, setSimRounds] = useState('20');
  const [arbIn, setArbIn] = useState<SideId>('TKA');
  const [arbOut, setArbOut] = useState<SideId>('TKB');
  const [arbAmt, setArbAmt] = useState('1000');
  const [arbView, setArbView] = useState<ArbView | null>(null);
  const [wrapAmt, setWrapAmt] = useState('1');
  const [lpPending, setLpPending] = useState('');
  const pickGen = useRef(0);

  function pushLog(line: string) {
    setLogs((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 80));
  }

  async function reload(provider: Provider, owner = address) {
    const rows = await loadPools(provider);
    const key =
      selectedRef.current && rows.some((row) => row.key === selectedRef.current)
        ? selectedRef.current
        : (rows[0]?.key ?? '');
    const pool = rows.find((row) => row.key === key);
    const nextLps = pool ? await loadLps(provider, pool.exchangeIndex, pool.pair) : [];
    const nextBal = owner ? await loadBalances(provider, owner) : null;
    const nextNfts = owner ? await loadMyNfts(provider, owner) : null;
    const liveKey =
      selectedRef.current && rows.some((row) => row.key === selectedRef.current) ? selectedRef.current : key;
    setPools(rows);
    if (nextBal && nextNfts) {
      setBalances(nextBal);
      setNfts(nextNfts);
    }
    // 读取期间又点了别的池子，别把旧表盖回去。
    if (liveKey !== key) return;
    selectedRef.current = key;
    setSelected(key);
    setLps(nextLps);
    setLpPending('');
  }

  useEffect(() => {
    console.log('MiniDEX：x*y=k。池子不会累，我会。');
    const provider = rpcProvider();
    let cancelled = false;
    // 开发模式会装上又卸下一次，取消掉的请求别把错误留在页面上。
    reload(provider).catch(() => {
      if (!cancelled) setError('本地节点还没连上。先在 contracts 里启动节点并部署，再点刷新。');
    });
    return () => {
      cancelled = true;
      void provider.destroy();
    };
    // 只在打开页面时读一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function needSigner() {
    const signer = signerRef.current;
    if (!signer || !providerRef.current) throw new Error('请先连接钱包');
    return signer;
  }

  async function connectMetaMask() {
    if (!window.ethereum) throw new Error('没有检测到浏览器钱包');
    const injected = window.ethereum;
    // cacheTimeout 关掉，原因和 sim.ts 里的本地节点一样。
    const browser = new BrowserProvider(injected, undefined, { cacheTimeout: -1 });
    await browser.send('eth_requestAccounts', []);
    const hexId = `0x${deployment.chainId.toString(16)}`;
    const network = await browser.getNetwork();
    if (Number(network.chainId) !== deployment.chainId) {
      try {
        await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
      } catch {
        await injected.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hexId,
              chainName: 'Hardhat',
              rpcUrls: [deployment.rpcUrl],
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            },
          ],
        });
      }
    }
    const next = new BrowserProvider(injected, undefined, { cacheTimeout: -1 });
    const signer = await next.getSigner();
    const addr = await signer.getAddress();
    signerRef.current = signer;
    providerRef.current = next;
    setAddress(addr);
    setChainId(Number((await next.getNetwork()).chainId));
    await reload(next, addr);
    pushLog(`已连接 ${short(addr)}`);
  }

  async function connectLocal() {
    const provider = rpcProvider();
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== deployment.chainId) {
      throw new Error(`本地链 id 是 ${network.chainId}，页面期望 ${deployment.chainId}`);
    }
    const signer = walletAt(0, provider);
    const addr = await signer.getAddress();
    signerRef.current = signer;
    providerRef.current = provider;
    setAddress(addr);
    setChainId(Number(network.chainId));
    await reload(provider, addr);
    pushLog(`使用本地账户 ${short(addr)}`);
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      const provider = providerRef.current ?? rpcProvider();
      const owner = address || (signerRef.current ? await signerRef.current.getAddress() : '');
      await reload(provider, owner);
      pushLog(`${label} 成功`);
    } catch (err) {
      const text = errText(err);
      setError(text);
      pushLog(`${label} 失败：${text}`);
    } finally {
      setBusy(false);
    }
  }

  async function onChoose(key: string) {
    const pool = pools.find((row) => row.key === key);
    if (!pool) return;
    const gen = ++pickGen.current;
    const previous = selectedRef.current;
    selectedRef.current = key;
    setLpPending(`正在读取 ${pool.exchangeName} · ${displaySymbol(pool.token0)} / ${displaySymbol(pool.token1)}`);
    const provider = providerRef.current ?? rpcProvider();
    try {
      const rows = await loadLps(provider, pool.exchangeIndex, pool.pair);
      if (gen !== pickGen.current) return;
      setSelected(key);
      setLps(rows);
      setLpPending('');
    } catch (err) {
      if (gen !== pickGen.current) return;
      selectedRef.current = previous;
      setLpPending('');
      setError(errText(err));
    }
  }

  const shownPools = pools.filter((pool) => poolFilter < 0 || pool.exchangeIndex === poolFilter);
  const current = pools.find((pool) => pool.key === selected);

  async function quoteSwap() {
    const provider = providerRef.current ?? rpcProvider();
    const left = resolveSide(swapIn);
    const right = resolveSide(swapOut);
    if (same(left.address, right.address)) throw new Error('两个代币不能一样');
    const router = bind(deployment.exchanges[exchangeIndex].router, abis.router, provider);
    const amount = parseAmount(swapAmt);
    const out = (await router.quote(left.address, right.address, amount)) as bigint;
    setQuoteText(`预计获得 ${fmt(out)} ${right.symbol}`);
    return { out, amount, left, right };
  }

  const impactText = describeImpact(pools, exchangeIndex, swapIn, swapOut, swapAmt);

  function minOut(quoted: bigint) {
    const pct = Number(slippage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) throw new Error('滑点填 0 到 50 之间的百分数');
    const bps = BigInt(Math.round(pct * 100));
    return (quoted * (10000n - bps)) / 10000n;
  }

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="kicker">浙大区块链作业2</p>
          <h1 title="玉泉机房周末版，别部署到主网">MiniDEX</h1>
          <p className="lede">恒定乘积。流动性记在 NFT 上，手续费 0.3% 留在池子里。</p>
        </div>
      </header>
      <nav className="nav">
        <a href="#wallet">钱包</a>
        <a href="#pools">交易池</a>
        <a href="#swap">兑换</a>
        <a href="#lp">流动性</a>
        <a href="#sim">模拟</a>
        <a href="#arb">套利</a>
      </nav>
      {error ? <div className="error">{error}</div> : null}

      <section className="card" id="wallet">
        <h2>钱包和水龙头</h2>
        <div className="toolbar">
          <button disabled={busy} onClick={() => run('连接钱包', connectMetaMask)}>
            连接 MetaMask
          </button>
          <button className="ghost" disabled={busy} onClick={() => run('本地账户', connectLocal)}>
            使用本地测试账户
          </button>
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run('刷新', async () => {
                const provider = providerRef.current ?? rpcProvider();
                providerRef.current = providerRef.current ?? provider;
                await reload(provider, address);
              })
            }
          >
            刷新
          </button>
          <span className="muted">
            {address ? `${short(address)} · chain ${chainId ?? '-'}` : '还没连接'}
          </span>
        </div>
        <div className="balances">
          <div>
            <span className="sym">ETH</span>
            <strong>{fmt(balances.eth)}</strong>
          </div>
          <div>
            <span className="sym">WETH</span>
            <strong>{fmt(balances.weth)}</strong>
          </div>
          <div>
            <span className="sym">TKA</span>
            <strong>{fmt(balances.tka)}</strong>
          </div>
          <div>
            <span className="sym">TKB</span>
            <strong>{fmt(balances.tkb)}</strong>
          </div>
        </div>
        <div className="actions">
          <button
            disabled={busy || !address}
            onClick={() =>
              run('领取 ETH', async () => {
                const signer = needSigner();
                const faucet = bind(deployment.ethFaucet, abis.faucet, signer);
                await (await faucet.claim()).wait();
              })
            }
          >
            领 5 ETH
          </button>
          <button
            disabled={busy || !address}
            onClick={() =>
              run('领取 TKA', async () => {
                const signer = needSigner();
                await (await bind(TKA, abis.erc20, signer).claim()).wait();
              })
            }
          >
            领 TKA
          </button>
          <button
            disabled={busy || !address}
            onClick={() =>
              run('领取 TKB', async () => {
                const signer = needSigner();
                await (await bind(TKB, abis.erc20, signer).claim()).wait();
              })
            }
          >
            领 TKB
          </button>
          <label>
            包装 / 拆包
            <input value={wrapAmt} onChange={(e) => setWrapAmt(e.target.value)} />
          </label>
          <button
            disabled={busy || !address}
            onClick={() =>
              run('包装 ETH', async () => {
                const signer = needSigner();
                const weth = bind(WETH, abis.weth, signer);
                await (await weth.deposit({ value: parseAmount(wrapAmt) })).wait();
              })
            }
          >
            包装成 WETH
          </button>
          <button
            className="ghost"
            disabled={busy || !address}
            onClick={() =>
              run('拆包 WETH', async () => {
                const signer = needSigner();
                const weth = bind(WETH, abis.weth, signer);
                await (await weth.withdraw(parseAmount(wrapAmt))).wait();
              })
            }
          >
            拆回 ETH
          </button>
        </div>
        <p className="note">
          每个地址 TKA、TKB 最多领 3 次，每次 10000。ETH 水龙头每个地址 1 次。本地按钮用的是 Hardhat 公开测试账户，不要拿到别的网络。
        </p>
      </section>

      <section className="card" id="pools">
        <h2>交易池</h2>
        <div className="fields compact">
          <label>
            筛选交易所
            <select value={poolFilter} onChange={(e) => setPoolFilter(Number(e.target.value))}>
              <option value={-1}>全部</option>
              {deployment.exchanges.map((ex, index) => (
                <option value={index} key={ex.name}>
                  {ex.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>交易所</th>
                <th>交易对</th>
                <th>储备</th>
                <th>价格</th>
                <th>份额</th>
              </tr>
            </thead>
            <tbody>
              {shownPools.length === 0 ? (
                <tr>
                  <td colSpan={5}>还没有池子。</td>
                </tr>
              ) : (
                shownPools.map((pool) => (
                  <tr
                    key={pool.key}
                    className={pool.key === selected ? 'picked clickable' : 'clickable'}
                    onClick={() => onChoose(pool.key)}
                  >
                    <td>{pool.exchangeName}</td>
                    <td>
                      {displaySymbol(pool.token0)} / {displaySymbol(pool.token1)}
                    </td>
                    <td>
                      {fmt(pool.reserve0)} / {fmt(pool.reserve1)}
                    </td>
                    <td>
                      1 {displaySymbol(pool.token0)} = {pool.reserve0 === 0n ? '-' : fmt((pool.reserve1 * 10n ** 18n) / pool.reserve0)}{' '}
                      {displaySymbol(pool.token1)}
                    </td>
                    <td>{fmt(pool.totalShares)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="note">点一行可以看到这个池子的流动性来源。ETH 池底层是 WETH。</p>

        <div className="split">
        <h2 className="sub">创建交易池</h2>
        <div className="fields">
          <label>
            交易所
            <select value={exchangeIndex} onChange={(e) => setExchangeIndex(Number(e.target.value))}>
              {deployment.exchanges.map((ex, index) => (
                <option value={index} key={ex.name}>
                  {ex.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            代币 A
            <select value={createLeft} onChange={(e) => setCreateLeft(e.target.value as SideId)}>
              <option>TKA</option>
              <option>TKB</option>
              <option>ETH</option>
            </select>
          </label>
          <label>
            数量 A
            <input value={createAmtLeft} onChange={(e) => setCreateAmtLeft(e.target.value)} />
          </label>
          <label>
            代币 B
            <select value={createRight} onChange={(e) => setCreateRight(e.target.value as SideId)}>
              <option>TKA</option>
              <option>TKB</option>
              <option>ETH</option>
            </select>
          </label>
          <label>
            数量 B
            <input value={createAmtRight} onChange={(e) => setCreateAmtRight(e.target.value)} />
          </label>
          <button
            disabled={busy || !address}
            onClick={() =>
              run('创建池子', async () => {
                const signer = needSigner();
                const me = await signer.getAddress();
                const left = resolveSide(createLeft);
                const right = resolveSide(createRight);
                if (same(left.address, right.address)) throw new Error('不能用同一个代币建池');
                const router = bind(deployment.exchanges[exchangeIndex].router, abis.router, signer);
                const amountLeft = parseAmount(createAmtLeft);
                const amountRight = parseAmount(createAmtRight);
                if (left.native || right.native) {
                  const token = left.native ? right : left;
                  const amountToken = left.native ? amountRight : amountLeft;
                  const value = left.native ? amountLeft : amountRight;
                  const erc20 = bind(token.address, abis.erc20, signer);
                  await ensureApprove(erc20, me, await router.getAddress(), amountToken);
                  await (
                    await router.createPairAndAddLiquidityETH(token.address, amountToken, me, { value })
                  ).wait();
                } else {
                  await ensureApprove(bind(left.address, abis.erc20, signer), me, await router.getAddress(), amountLeft);
                  await ensureApprove(bind(right.address, abis.erc20, signer), me, await router.getAddress(), amountRight);
                  await (
                    await router.createPairAndAddLiquidity(left.address, right.address, amountLeft, amountRight, me)
                  ).wait();
                }
              })
            }
          >
            创建并添加流动性
          </button>
        </div>
        <p className="note">池子已经存在时，这个按钮只会按当前比例继续加流动性。TKB/ETH 部署后还是空的，可以自己建。</p>
        </div>
      </section>

      <section className="card" id="swap">
        <h2>兑换</h2>
        <div className="fields compact">
          <label>
            交易所
            <select value={exchangeIndex} onChange={(e) => setExchangeIndex(Number(e.target.value))}>
              {deployment.exchanges.map((ex, index) => (
                <option value={index} key={ex.name}>
                  {ex.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="swap-grid">
          <div className="swap-side">
            <label>
              支付
              <select value={swapIn} onChange={(e) => setSwapIn(e.target.value as SideId)}>
                <option>TKA</option>
                <option>TKB</option>
                <option>ETH</option>
              </select>
            </label>
            <label>
              数量
              <input value={swapAmt} onChange={(e) => setSwapAmt(e.target.value)} />
            </label>
          </div>
          <div className="swap-side">
            <label>
              获得
              <select value={swapOut} onChange={(e) => setSwapOut(e.target.value as SideId)}>
                <option>TKA</option>
                <option>TKB</option>
                <option>ETH</option>
              </select>
            </label>
            <label>
              滑点 %
              <input value={slippage} onChange={(e) => setSlippage(e.target.value)} />
            </label>
          </div>
        </div>
        <div className="swap-actions">
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run('报价', async () => {
                await quoteSwap();
              })
            }
          >
            报价
          </button>
          <button
            disabled={busy || !address}
            onClick={() =>
              run('兑换', async () => {
                const signer = needSigner();
                const me = await signer.getAddress();
                const quoted = await quoteSwap();
                const router = bind(deployment.exchanges[exchangeIndex].router, abis.router, signer);
                const min = minOut(quoted.out);
                if (quoted.left.native) {
                  await (
                    await router.swapExactETHForTokens(quoted.right.address, min, me, { value: quoted.amount })
                  ).wait();
                } else if (quoted.right.native) {
                  await ensureApprove(bind(quoted.left.address, abis.erc20, signer), me, await router.getAddress(), quoted.amount);
                  await (await router.swapExactTokensForETH(quoted.left.address, quoted.amount, min, me)).wait();
                } else {
                  await ensureApprove(bind(quoted.left.address, abis.erc20, signer), me, await router.getAddress(), quoted.amount);
                  await (
                    await router.swapExactTokensForTokens(
                      quoted.left.address,
                      quoted.right.address,
                      quoted.amount,
                      min,
                      me,
                    )
                  ).wait();
                }
              })
            }
          >
            兑换
          </button>
        </div>
        {quoteText ? <p className="quote">{quoteText}</p> : null}
        {impactText ? <p className="note">{impactText}</p> : null}
      </section>

      <section className="card" id="lp">
        <h2>池子里的流动性来源</h2>
        {current ? (
          <p className="note">
            {current.exchangeName} · {displaySymbol(current.token0)} / {displaySymbol(current.token1)}
          </p>
        ) : (
          <p className="note">先在上面选一个池子。</p>
        )}
        {lpPending ? <p className="note">{lpPending}</p> : null}
        <PositionTable rows={lps} showOwner />
        {current ? (
          <div className="fields">
            <label>
              {displaySymbol(current.token0)}
              <input value={add0} onChange={(e) => setAdd0(e.target.value)} />
            </label>
            <label>
              {displaySymbol(current.token1)}
              <input value={add1} onChange={(e) => setAdd1(e.target.value)} />
            </label>
            <button
              disabled={busy || !address}
              onClick={() =>
                run('添加流动性', async () => {
                  if (!current) throw new Error('先选一个池子');
                  const signer = needSigner();
                  const me = await signer.getAddress();
                  const router = bind(deployment.exchanges[current.exchangeIndex].router, abis.router, signer);
                  const amount0 = parseAmount(add0);
                  const amount1 = parseAmount(add1);
                  const routerAddr = await router.getAddress();
                  if (same(current.token0, WETH)) {
                    await ensureApprove(bind(current.token1, abis.erc20, signer), me, routerAddr, amount1);
                    await (await router.addLiquidityETH(current.token1, amount1, me, { value: amount0 })).wait();
                  } else if (same(current.token1, WETH)) {
                    await ensureApprove(bind(current.token0, abis.erc20, signer), me, routerAddr, amount0);
                    await (await router.addLiquidityETH(current.token0, amount0, me, { value: amount1 })).wait();
                  } else {
                    await ensureApprove(bind(current.token0, abis.erc20, signer), me, routerAddr, amount0);
                    await ensureApprove(bind(current.token1, abis.erc20, signer), me, routerAddr, amount1);
                    await (await router.addLiquidity(current.token0, current.token1, amount0, amount1, me)).wait();
                  }
                })
              }
            >
              向选中池子加流动性
            </button>
          </div>
        ) : null}
        <p className="note">加池时如果两边比例和池子不一致，合约会按现价少收多的那一边。</p>

        <div className="split">
        <h2 className="sub">我的流动性 NFT</h2>
        <PositionTable
          rows={nfts}
          action={(row) => (
            <button
              disabled={busy}
              onClick={() =>
                run(`取回 #${row.tokenId.toString()}`, async () => {
                  const signer = needSigner();
                  const me = await signer.getAddress();
                  const router = bind(deployment.exchanges[row.exchangeIndex].router, abis.router, signer);
                  if (same(row.token0, WETH) || same(row.token1, WETH)) {
                    await (await router.removeLiquidityETH(row.tokenId, me)).wait();
                  } else {
                    await (await router.removeLiquidity(row.tokenId, me)).wait();
                  }
                })
              }
            >
              销毁并取回
            </button>
          )}
        />
        <p className="note">当前可取回的数量已经包含手续费。部署者的初始 NFT 不要全部销毁，不然价差样本就没了。</p>
        </div>
      </section>

      <section className="card" id="sim">
        <h2 title="1 到 20 号账户。0 号是我自己，别让脚本把初始池子撤了">多账户模拟</h2>
        <p className="note">
          用 Hardhat 的 20 个测试账户随机兑换、加池、撤池。不会动部署者放进去的初始流动性。节点必须开在 127.0.0.1:8545。
        </p>
        <div className="fields">
          <label>
            轮数
            <input value={simRounds} onChange={(e) => setSimRounds(e.target.value)} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              run('模拟', async () => {
                const rounds = Number(simRounds);
                if (!Number.isInteger(rounds) || rounds < 1 || rounds > 60) {
                  throw new Error('轮数填 1 到 60');
                }
                const result = await runLocalSimulation(rounds, pushLog);
                pushLog(`结果：兑换 ${result.swaps}，加池 ${result.adds}，撤池 ${result.removes}，跳过 ${result.skips}`);
              })
            }
          >
            开始模拟
          </button>
        </div>
      </section>

      <section className="card" id="arb">
        <h2 title="一笔交易走完。中间失败就当没发生">
          原子套利<span className="nick">搬砖</span>
        </h2>
        <p className="note">
          合约会比较两个交易所，在更便宜的一边买入，再到另一边卖出。赚不到钱就整笔回滚。这里用的是 ERC20，ETH 池请选 WETH，并先包装。
        </p>
        <div className="fields">
          <label>
            支付
            <select value={arbIn} onChange={(e) => setArbIn(e.target.value as SideId)}>
              <option>TKA</option>
              <option>TKB</option>
              <option>WETH</option>
            </select>
          </label>
          <label>
            中间代币
            <select value={arbOut} onChange={(e) => setArbOut(e.target.value as SideId)}>
              <option>TKA</option>
              <option>TKB</option>
              <option>WETH</option>
            </select>
          </label>
          <label>
            数量
            <input value={arbAmt} onChange={(e) => setArbAmt(e.target.value)} />
          </label>
        </div>
        <div className="swap-actions">
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run('套利预览', async () => {
                const provider = providerRef.current ?? rpcProvider();
                const view = await readArb(provider, arbIn, arbOut, parseAmount(arbAmt));
                setArbView({ ...view, source: '预览' });
              })
            }
          >
            预览
          </button>
          <button
            disabled={busy || !address}
            onClick={() =>
              run('执行套利', async () => {
                const signer = needSigner();
                const me = await signer.getAddress();
                const amount = parseAmount(arbAmt);
                const tokenIn = resolveSide(arbIn);
                const tokenOut = resolveSide(arbOut);
                if (tokenIn.native || tokenOut.native) throw new Error('套利请选择 WETH，不要选原生 ETH');
                const arb = bind(deployment.arbitrage, abis.arbitrage, signer);
                const view = await readArb(signer, arbIn, arbOut, amount);
                setArbView({ ...view, source: '预览' });
                await ensureApprove(bind(tokenIn.address, abis.erc20, signer), me, await arb.getAddress(), amount);
                // 没有利润也发出去，让合约自己 revert，方便看到整笔回滚。
                const tx = await arb.execute(
                  deployment.exchanges[0].router,
                  deployment.exchanges[1].router,
                  tokenIn.address,
                  tokenOut.address,
                  amount,
                  view.profitable ? view.profit : 0n,
                );
                const receipt = await tx.wait();
                if (!receipt) throw new Error('没有交易回执');
                const parsed = receipt.logs
                  .map((log: { topics: string[]; data: string }) => {
                    try {
                      return arb.interface.parseLog(log);
                    } catch {
                      return null;
                    }
                  })
                  .find((item: { name: string } | null) => item && item.name === 'ArbitrageExecuted');
                if (!parsed) throw new Error('交易成功但没有找到套利事件');
                setArbView({
                  profitable: true,
                  buyName: exchangeNameOfRouter(parsed.args.buyRouter),
                  sellName: exchangeNameOfRouter(parsed.args.sellRouter),
                  amountBought: parsed.args.amountBought,
                  amountBack: parsed.args.amountBack,
                  profit: parsed.args.profit,
                  priceBuyBefore: parsed.args.priceBuyBefore,
                  priceSellBefore: parsed.args.priceSellBefore,
                  priceBuyAfter: parsed.args.priceBuyAfter,
                  priceSellAfter: parsed.args.priceSellAfter,
                  tokenIn: tokenIn.symbol,
                  tokenOut: tokenOut.symbol,
                  source: '已成交',
                });
              })
            }
          >
            执行套利
          </button>
        </div>
        {arbView ? <ArbBox view={arbView} /> : null}
      </section>

      <section className="card">
        <h2>操作记录</h2>
        <div className="log">
          {logs.length === 0 ? <div>还没有操作。</div> : logs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
        </div>
      </section>
      <footer className="foot">
        浙大区块链作业2 · MiniDEX
        <span className="sid">魏宝龙 · 3230105407</span>
      </footer>
    </div>
  );
}

// 用页面上看到的储备估一下，不另发请求。差价里已经含 0.3% 手续费。
function describeImpact(pools: PoolRow[], exchangeIndex: number, swapIn: SideId, swapOut: SideId, swapAmt: string) {
  if (pools.length === 0) return '';
  let amount: bigint;
  try {
    amount = parseAmount(swapAmt);
  } catch {
    return '';
  }
  if (amount === 0n) return '';
  const left = resolveSide(swapIn);
  const right = resolveSide(swapOut);
  if (same(left.address, right.address)) return '';
  const pool = pools.find((row) => {
    if (row.exchangeIndex !== exchangeIndex) return false;
    const a = row.token0.toLowerCase();
    const b = row.token1.toLowerCase();
    const i = left.address.toLowerCase();
    const o = right.address.toLowerCase();
    return (a === i && b === o) || (a === o && b === i);
  });
  if (!pool) return '这个交易所还没有这对池子。';
  const reserveIn = pool.token0.toLowerCase() === left.address.toLowerCase() ? pool.reserve0 : pool.reserve1;
  const reserveOut = pool.token0.toLowerCase() === left.address.toLowerCase() ? pool.reserve1 : pool.reserve0;
  if (reserveIn === 0n || reserveOut === 0n) return '池子几乎空了，这单别硬换。';
  const out = (reserveOut * amount * 997n) / (reserveIn * 1000n + amount * 997n);
  if (out === 0n) return '按现在的储备，换出来会是 0。';
  const ideal = amount * reserveOut;
  const got = out * reserveIn;
  if (got >= ideal) return '';
  const bps = ((ideal - got) * 10000n) / ideal;
  const whole = (bps / 100n).toString();
  const frac = (bps % 100n).toString().padStart(2, '0');
  return `比池子现价大约少 ${whole}.${frac}%，0.3% 手续费算在里面。`;
}

async function readArb(runner: Signer | Provider, arbIn: SideId, arbOut: SideId, amount: bigint): Promise<ArbView> {
  const tokenIn = resolveSide(arbIn);
  const tokenOut = resolveSide(arbOut);
  if (same(tokenIn.address, tokenOut.address)) throw new Error('两个代币不能一样');
  const arb = bind(deployment.arbitrage, abis.arbitrage, runner);
  const plan = await arb.preview(
    deployment.exchanges[0].router,
    deployment.exchanges[1].router,
    tokenIn.address,
    tokenOut.address,
    amount,
  );
  return {
    profitable: Boolean(plan.profitable),
    buyName: exchangeNameOfRouter(plan.buyRouter),
    sellName: exchangeNameOfRouter(plan.sellRouter),
    amountBought: plan.amountBought as bigint,
    amountBack: plan.amountBack as bigint,
    profit: plan.profit as bigint,
    priceBuyBefore: plan.priceBuyBefore as bigint,
    priceSellBefore: plan.priceSellBefore as bigint,
    priceBuyAfter: plan.priceBuyAfter as bigint,
    priceSellAfter: plan.priceSellAfter as bigint,
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    source: '预览',
  };
}

export function arbHeadline(done: boolean, profitable: boolean, profitText: string, token: string) {
  if (!profitable) return done ? '已成交，但没有正利润' : '预览，当前没有正利润';
  return done ? `已成交，实际利润 ${profitText} ${token}` : `预览，预计利润 ${profitText} ${token}`;
}

function ArbBox({ view }: { view: ArbView }) {
  const done = view.source === '已成交';
  return (
    <div className="arb-box">
      <div className="arb-path" title="同一笔交易里按这个顺序走">
        <span className="step">{view.tokenIn}</span>
        <span className="hop">买入 · {view.buyName || '—'}</span>
        <span className="step">{fmt(view.amountBought)} {view.tokenOut}</span>
        <span className="hop">卖出 · {view.sellName || '—'}</span>
        <span className="step">{fmt(view.amountBack)} {view.tokenIn}</span>
      </div>
      <p>{arbHeadline(done, view.profitable, fmt(view.profit), view.tokenIn)}</p>
      <p>
        {done
          ? `已在 ${view.buyName} 用 ${view.tokenIn} 买入 ${fmt(view.amountBought)} ${view.tokenOut}，并在 ${view.sellName} 卖出 ${fmt(view.amountBack)} ${view.tokenIn}`
          : `在 ${view.buyName} 用 ${view.tokenIn} 买入 ${fmt(view.amountBought)} ${view.tokenOut}，再到 ${view.sellName} 卖回 ${fmt(view.amountBack)} ${view.tokenIn}`}
      </p>
      <p className="note">
        价格（1 {view.tokenIn} 值多少 {view.tokenOut}）：买入边 {fmt(view.priceBuyBefore)} → {fmt(view.priceBuyAfter)}，卖出边{' '}
        {fmt(view.priceSellBefore)} → {fmt(view.priceSellAfter)}
      </p>
    </div>
  );
}

function PositionTable({
  rows,
  showOwner,
  action,
}: {
  rows: PositionRow[];
  showOwner?: boolean;
  action?: (row: PositionRow) => ReactNode;
}) {
  if (rows.length === 0) return <p className="note">没有记录。</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>交易所</th>
            <th>NFT</th>
            {showOwner ? <th>地址</th> : null}
            <th>交易对</th>
            <th>当初放入</th>
            <th>现在可取</th>
            <th>时间</th>
            {action ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.exchangeIndex}-${row.tokenId.toString()}`}>
              <td>{row.exchangeName}</td>
              <td>#{row.tokenId.toString()}</td>
              {showOwner ? <td>{short(row.owner)}</td> : null}
              <td>
                {displaySymbol(row.token0)} / {displaySymbol(row.token1)}
              </td>
              <td>
                {fmt(row.amount0)} / {fmt(row.amount1)}
              </td>
              <td>
                {fmt(row.out0)} / {fmt(row.out1)}
              </td>
              <td>{fmtTime(row.createdAt)}</td>
              {action ? <td>{action(row)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
