import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrowserProvider, type Provider, type Signer } from 'ethers';
import './App.css';
import {
  abis,
  bind,
  deploymentForChain,
  displaySymbol,
  ensureApprove,
  errText,
  exchangeNameOfRouter,
  fmt,
  fmtTime,
  HARDHAT_CHAIN_ID,
  loadBalances,
  loadLps,
  loadMyNfts,
  loadPools,
  localhostDeployment,
  networkLabel,
  parseAmount,
  resolveSide,
  same,
  SEPOLIA_CHAIN_ID,
  sepoliaDeployment,
  short,
  type DexDeployment,
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

type Impact = { text: string; bps: bigint };

const emptyBal = { eth: 0n, weth: 0n, tka: 0n, tkb: 0n };
const swapSides: SideId[] = ['TKA', 'TKB', 'ETH'];
const arbSides: SideId[] = ['TKA', 'TKB', 'WETH'];

function App() {
  const signerRef = useRef<Signer | null>(null);
  const providerRef = useRef<Provider | null>(null);
  const selectedRef = useRef('');
  const quoteGen = useRef(0);
  const pickGen = useRef(0);

  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState<number | null>(HARDHAT_CHAIN_ID);
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
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);

  const [add0, setAdd0] = useState('100');
  const [add1, setAdd1] = useState('100');
  const [simRounds, setSimRounds] = useState('20');
  const [arbIn, setArbIn] = useState<SideId>('TKA');
  const [arbOut, setArbOut] = useState<SideId>('TKB');
  const [arbAmt, setArbAmt] = useState('1000');
  const [arbView, setArbView] = useState<ArbView | null>(null);
  const [wrapAmt, setWrapAmt] = useState('1');
  const [lpPending, setLpPending] = useState('');

  function pushLog(line: string) {
    setLogs((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 80));
  }

  async function reload(provider: Provider, owner = address, file: DexDeployment = localhostDeployment) {
    if (!file.ready) {
      setPools([]);
      setLps([]);
      setNfts([]);
      setBalances(emptyBal);
      return;
    }
    const rows = await loadPools(file, provider);
    const key =
      selectedRef.current && rows.some((row) => row.key === selectedRef.current)
        ? selectedRef.current
        : (rows[0]?.key ?? '');
    const pool = rows.find((row) => row.key === key);
    const nextLps = pool ? await loadLps(file, provider, pool.exchangeIndex, pool.pair) : [];
    const nextBal = owner ? await loadBalances(file, provider, owner) : null;
    const nextNfts = owner ? await loadMyNfts(file, provider, owner) : null;
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
      if (!cancelled) {
        setError('本地节点还没连上。作业演示请先在 contracts 里启动节点并部署。要用 Sepolia，连接 MetaMask 并切到 Sepolia。');
      }
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
    const network = await browser.getNetwork();
    const id = Number(network.chainId);
    const file = deploymentForChain(id);
    const signer = await browser.getSigner();
    const addr = await signer.getAddress();
    signerRef.current = signer;
    providerRef.current = browser;
    setAddress(addr);
    setChainId(id);
    if (!file) {
      setPools([]);
      setLps([]);
      throw new Error(`钱包在 chain ${id}。作业演示切 Hardhat ${HARDHAT_CHAIN_ID}，测试网切 Sepolia ${SEPOLIA_CHAIN_ID}。`);
    }
    if (!file.ready) {
      setPools([]);
      setLps([]);
      setNfts([]);
      throw new Error('Sepolia 上还没有合约。先填 contracts/.env，再跑 npx hardhat run scripts/deploy.ts --network sepolia。');
    }
    await reload(browser, addr, file);
    pushLog(`已连接 ${short(addr)} · ${networkLabel(id)}`);
  }

  async function switchChain(id: number) {
    if (!window.ethereum) throw new Error('没有检测到浏览器钱包');
    const injected = window.ethereum;
    const hex = `0x${id.toString(16)}`;
    try {
      await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 4902) throw err;
      const params =
        id === SEPOLIA_CHAIN_ID
          ? {
              chainId: hex,
              chainName: 'Sepolia',
              rpcUrls: [sepoliaDeployment.rpcUrl],
              nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
              blockExplorerUrls: ['https://sepolia.etherscan.io'],
            }
          : {
              chainId: hex,
              chainName: 'Hardhat',
              rpcUrls: [localhostDeployment.rpcUrl],
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            };
      await injected.request({ method: 'wallet_addEthereumChain', params: [params] });
    }
    await connectMetaMask();
  }

  async function connectLocal() {
    const provider = rpcProvider();
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== HARDHAT_CHAIN_ID) {
      throw new Error(`本地链 id 是 ${network.chainId}，页面期望 ${HARDHAT_CHAIN_ID}`);
    }
    const signer = walletAt(0, provider);
    const addr = await signer.getAddress();
    signerRef.current = signer;
    providerRef.current = provider;
    setAddress(addr);
    setChainId(HARDHAT_CHAIN_ID);
    await reload(provider, addr, localhostDeployment);
    pushLog(`使用本地账户 ${short(addr)}`);
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      const provider = providerRef.current ?? rpcProvider();
      providerRef.current = provider;
      const id = Number((await provider.getNetwork()).chainId);
      const file = deploymentForChain(id);
      setChainId(id);
      if (!file?.ready) {
        throw new Error(
          file
            ? 'Sepolia 合约还没部署。先填 contracts/.env，再跑 deploy:sepolia。'
            : `chain ${id} 用不上。请切到 Hardhat ${HARDHAT_CHAIN_ID} 或 Sepolia ${SEPOLIA_CHAIN_ID}。`,
        );
      }
      const owner = address || (signerRef.current ? await signerRef.current.getAddress() : '');
      await reload(provider, owner, file);
      pushLog(`${label} 成功`);
    } catch (err) {
      const text = errText(err);
      setError(text);
      pushLog(`${label} 失败：${text}`);
    } finally {
      setBusy(false);
    }
  }

  const dep = deploymentForChain(chainId);
  const ready = Boolean(dep?.ready);

  async function onChoose(key: string) {
    if (!dep) return;
    const pool = pools.find((row) => row.key === key);
    if (!pool) return;
    const gen = ++pickGen.current;
    const previous = selectedRef.current;
    selectedRef.current = key;
    setLpPending(`正在读取 ${pool.exchangeName} · ${displaySymbol(dep, pool.token0)} / ${displaySymbol(dep, pool.token1)}`);
    const provider = providerRef.current ?? rpcProvider();
    try {
      const rows = await loadLps(dep, provider, pool.exchangeIndex, pool.pair);
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
  const impact = dep ? describeImpact(dep, pools, exchangeIndex, swapIn, swapOut, swapAmt) : null;
  const wethAddr = dep?.tokens.WETH.address ?? '';

  function sym(addr: string) {
    return dep ? displaySymbol(dep, addr) : short(addr);
  }

  async function quoteSwap() {
    if (!dep || !dep.ready) throw new Error('先连到已经部署好的 Hardhat 或 Sepolia');
    const gen = ++quoteGen.current;
    const left = resolveSide(dep, swapIn);
    const right = resolveSide(dep, swapOut);
    if (same(left.address, right.address)) throw new Error('两个代币不能一样');
    const provider = providerRef.current ?? rpcProvider();
    const router = bind(dep.exchanges[exchangeIndex].router, abis.router, provider);
    const amount = parseAmount(swapAmt);
    const out = (await router.quote(left.address, right.address, amount)) as bigint;
    if (gen !== quoteGen.current) return null;
    setQuoteOut(out);
    setQuoteText(`预计获得 ${fmt(out)} ${right.symbol}`);
    return { out, amount, left, right };
  }

  useEffect(() => {
    if (pools.length === 0) return;
    let cancelled = false;
    setQuoteOut(null);
    setQuoteText('');
    const timer = window.setTimeout(() => {
      quoteSwap()
        .then((res) => {
          if (cancelled || res) return;
          setQuoteOut(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setQuoteOut(null);
          setQuoteText(errText(err));
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // 输入变了再报价。函数本身每次渲染都是新的，放进依赖会转圈。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools, swapIn, swapOut, swapAmt, exchangeIndex]);

  function minOut(quoted: bigint) {
    const pct = Number(slippage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) throw new Error('滑点填 0 到 50 之间的百分数');
    const bps = BigInt(Math.round(pct * 100));
    return (quoted * (10000n - bps)) / 10000n;
  }

  function sideBalance(side: SideId) {
    if (side === 'TKA') return balances.tka;
    if (side === 'TKB') return balances.tkb;
    if (side === 'WETH') return balances.weth;
    return balances.eth;
  }

  function flipSides() {
    setSwapIn(swapOut);
    setSwapOut(swapIn);
  }

  const impactClass = !impact ? '' : impact.bps >= 500n ? 'impact bad' : impact.bps >= 100n ? 'impact hot' : 'impact';

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-inner">
          <div className="brand">
            <span className="mark" aria-hidden="true">
              M
            </span>
            <div>
              <h1 title="玉泉机房周末版，别部署到主网">MiniDEX</h1>
              <p className="kicker">浙大区块链作业2</p>
            </div>
          </div>
          <nav className="nav">
            <a href="#swap">兑换</a>
            <a href="#pools">池子</a>
            <a href="#lp">流动性</a>
            <a href="#sim">模拟</a>
            <a href="#arb">套利</a>
          </nav>
          <div className="bar-status">
            <span className="chip">{networkLabel(chainId)}</span>
            {address ? ` ${short(address)}` : ' 未连接'}
          </div>
        </div>
      </header>

      <main className="shell">
        {!dep ? (
          <p className="net-hint">
            钱包在 {networkLabel(chainId)}。作业演示切到 Hardhat {HARDHAT_CHAIN_ID}，可选测试网切到 Sepolia {SEPOLIA_CHAIN_ID}。主网不要用。
          </p>
        ) : null}
        {dep && !dep.ready ? (
          <p className="net-hint">
            已在 Sepolia，但仓库里的 sepolia.json 还是空的。填 contracts/.env 后运行 npx hardhat run scripts/deploy.ts --network sepolia，再刷新。
          </p>
        ) : null}
        <div className="stage">
          <section className="swap-card" id="swap">
            <div className="swap-head">
              <h2>兑换</h2>
              <div className="seg" role="tablist" aria-label="交易所">
                {(dep?.exchanges ?? []).map((ex, index) => (
                  <button
                    type="button"
                    key={ex.name}
                    role="tab"
                    aria-selected={exchangeIndex === index}
                    onClick={() => setExchangeIndex(index)}
                  >
                    {ex.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="slip">
              <span>滑点容忍</span>
              <input aria-label="滑点百分比" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
              <span>%</span>
            </div>
            <div className="wells">
              <div className="token-box">
                <div className="token-meta">
                  <span>支付</span>
                  <span className="num">{address ? `余额 ${fmt(sideBalance(swapIn))}` : '未连接'}</span>
                </div>
                <div className="token-row">
                  <input
                    className="amount"
                    aria-label="支付数量"
                    value={swapAmt}
                    onChange={(e) => setSwapAmt(e.target.value)}
                  />
                  <select
                    className="token-pill"
                    aria-label="支付代币"
                    value={swapIn}
                    onChange={(e) => setSwapIn(e.target.value as SideId)}
                  >
                    {swapSides.map((side) => (
                      <option key={side}>{side}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flip-row">
                <button type="button" className="flip" aria-label="对调支付和获得" onClick={flipSides}>
                  ↓
                </button>
              </div>
              <div className="token-box">
                <div className="token-meta">
                  <span>获得</span>
                  <button
                    type="button"
                    className="text-btn"
                    disabled={busy}
                    onClick={() =>
                      run('报价', async () => {
                        await quoteSwap();
                      })
                    }
                  >
                    报价
                  </button>
                </div>
                <div className="token-row">
                  <div className={quoteOut === null ? 'out-amt empty' : 'out-amt'}>{quoteOut === null ? '—' : fmt(quoteOut)}</div>
                  <select
                    className="token-pill"
                    aria-label="获得代币"
                    value={swapOut}
                    onChange={(e) => setSwapOut(e.target.value as SideId)}
                  >
                    {swapSides.map((side) => (
                      <option key={side}>{side}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            {impact ? <p className={impactClass}>{impact.text}</p> : null}
            {quoteText ? <p className="quote-line">{quoteText}</p> : null}
            <button
              type="button"
              className="cta"
              disabled={busy || !address}
              onClick={() =>
                run('兑换', async () => {
                  if (!dep) throw new Error('先选 Hardhat 或 Sepolia');
                  const signer = needSigner();
                  const me = await signer.getAddress();
                  const quoted = await quoteSwap();
                  if (!quoted) throw new Error('报价失败，再试一次');
                  const router = bind(dep.exchanges[exchangeIndex].router, abis.router, signer);
                  const min = minOut(quoted.out);
                  if (quoted.left.native) {
                    await (
                      await router.swapExactETHForTokens(quoted.right.address, min, me, { value: quoted.amount })
                    ).wait();
                  } else if (quoted.right.native) {
                    await ensureApprove(
                      bind(quoted.left.address, abis.erc20, signer),
                      me,
                      await router.getAddress(),
                      quoted.amount,
                    );
                    await (await router.swapExactTokensForETH(quoted.left.address, quoted.amount, min, me)).wait();
                  } else {
                    await ensureApprove(
                      bind(quoted.left.address, abis.erc20, signer),
                      me,
                      await router.getAddress(),
                      quoted.amount,
                    );
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
          </section>

          <aside className="card" id="wallet">
            <div className="card-title">
              <h2>钱包</h2>
              <span className="chip">{networkLabel(chainId)}</span>
            </div>
            <div className="connect">
              {chainId !== SEPOLIA_CHAIN_ID ? (
                <button type="button" className="primary" disabled={busy} onClick={() => run('本地账户', connectLocal)}>
                  使用本地测试账户
                </button>
              ) : (
                <button type="button" className="ghost" disabled={busy} onClick={() => run('本地账户', connectLocal)}>
                  回到本地 Hardhat
                </button>
              )}
              <button type="button" className="ghost" disabled={busy} onClick={() => run('连接钱包', connectMetaMask)}>
                连接 MetaMask
              </button>
              <div className="faucet">
                <button type="button" className="ghost" disabled={busy} onClick={() => run('切换网络', () => switchChain(HARDHAT_CHAIN_ID))}>
                  切到 Hardhat
                </button>
                <button type="button" className="ghost" disabled={busy} onClick={() => run('切换网络', () => switchChain(SEPOLIA_CHAIN_ID))}>
                  切到 Sepolia
                </button>
              </div>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() =>
                  run('刷新', async () => {
                    if (!providerRef.current) providerRef.current = rpcProvider();
                  })
                }
              >
                刷新
              </button>
            </div>
            <div className="balances">
              {(
                [
                  ['ETH', balances.eth],
                  ['WETH', balances.weth],
                  ['TKA', balances.tka],
                  ['TKB', balances.tkb],
                ] as const
              ).map(([sym, value]) => (
                <div className="bal-row" key={sym}>
                  <span className="sym">{sym}</span>
                  <strong>{fmt(value)}</strong>
                </div>
              ))}
            </div>
            {dep?.localFaucet ? (
              <div className="faucet">
                <button
                  type="button"
                  disabled={busy || !address}
                  onClick={() =>
                    run('领取 ETH', async () => {
                      if (!dep) throw new Error('先连本地节点');
                      const signer = needSigner();
                      const faucet = bind(dep.ethFaucet, abis.faucet, signer);
                      await (await faucet.claim()).wait();
                    })
                  }
                >
                  领 5 ETH
                </button>
                <button
                  type="button"
                  disabled={busy || !address}
                  onClick={() =>
                    run('领取 TKA', async () => {
                      if (!dep) throw new Error('先连本地节点');
                      const signer = needSigner();
                      await (await bind(dep.tokens.TKA.address, abis.erc20, signer).claim()).wait();
                    })
                  }
                >
                  领 TKA
                </button>
                <button
                  type="button"
                  disabled={busy || !address}
                  onClick={() =>
                    run('领取 TKB', async () => {
                      if (!dep) throw new Error('先连本地节点');
                      const signer = needSigner();
                      await (await bind(dep.tokens.TKB.address, abis.erc20, signer).claim()).wait();
                    })
                  }
                >
                  领 TKB
                </button>
              </div>
            ) : null}
            <div className="wrap-row">
              <label>
                包装 / 拆包
                <input aria-label="包装数量" value={wrapAmt} onChange={(e) => setWrapAmt(e.target.value)} />
              </label>
              <button
                type="button"
                disabled={busy || !address}
                onClick={() =>
                  run('包装 ETH', async () => {
                    const signer = needSigner();
                    const weth = bind(wethAddr, abis.weth, signer);
                    await (await weth.deposit({ value: parseAmount(wrapAmt) })).wait();
                  })
                }
              >
                包装成 WETH
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy || !address}
                onClick={() =>
                  run('拆包 WETH', async () => {
                    const signer = needSigner();
                    const weth = bind(wethAddr, abis.weth, signer);
                    await (await weth.withdraw(parseAmount(wrapAmt))).wait();
                  })
                }
              >
                拆回 ETH
              </button>
            </div>
            {dep?.localFaucet ? (
              <p className="note">
                每个地址 TKA、TKB 最多领 3 次，每次 10000。ETH 水龙头每个地址 1 次。本地按钮用的是 Hardhat 公开测试账户，不要拿到别的网络。
              </p>
            ) : (
              <p className="note">
                Sepolia 上没有领币按钮。测试 ETH 去 sepoliafaucet.com 或 Alchemy 的 Sepolia faucet 领，gas 由部署账户付。TKA、TKB 只用部署时铸下的那一点。
              </p>
            )}
          </aside>
        </div>

        <section className="section" id="pools">
          <div className="section-head">
            <h2>交易池</h2>
            <div className="seg" role="tablist" aria-label="筛选交易所">
              <button type="button" role="tab" aria-selected={poolFilter < 0} onClick={() => setPoolFilter(-1)}>
                全部
              </button>
              {(dep?.exchanges ?? []).map((ex, index) => (
                <button
                  type="button"
                  key={ex.name}
                  role="tab"
                  aria-selected={poolFilter === index}
                  onClick={() => setPoolFilter(index)}
                >
                  {ex.name}
                </button>
              ))}
            </div>
          </div>
          <div className="pools-layout">
            <div className="card" id="pool-table">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>交易所</th>
                      <th>交易对</th>
                      <th className="num">储备</th>
                      <th className="num">价格</th>
                      <th className="num">份额</th>
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
                          <td>
                            <span className={pool.exchangeIndex === 0 ? 'chip chip-a' : 'chip chip-b'}>{pool.exchangeName}</span>
                          </td>
                          <td className="pair">
                            {sym(pool.token0)}
                            <span className="slash">/</span>
                            {sym(pool.token1)}
                          </td>
                          <td className="num">
                            {fmt(pool.reserve0)} / {fmt(pool.reserve1)}
                          </td>
                          <td className="num">
                            1 {sym(pool.token0)} = {pool.reserve0 === 0n ? '-' : fmt((pool.reserve1 * 10n ** 18n) / pool.reserve0)}{' '}
                            {sym(pool.token1)}
                          </td>
                          <td className="num">{fmt(pool.totalShares)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <p className="note">点一行看这个池子的流动性来源。ETH 池底层是 WETH。左边这条线是当前选中的池子。</p>
            </div>

            <div className="card" id="create">
              <h2 className="subhead">创建交易池</h2>
              <div className="form-grid">
                <label className="wide">
                  交易所
                  <select value={exchangeIndex} onChange={(e) => setExchangeIndex(Number(e.target.value))}>
                    {(dep?.exchanges ?? []).map((ex, index) => (
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
              </div>
              <button
                type="button"
                className="cta"
                disabled={busy || !address}
                onClick={() =>
                  run('创建池子', async () => {
                    const signer = needSigner();
                    const me = await signer.getAddress();
                    if (!dep) throw new Error('先选 Hardhat 或 Sepolia');
                    const left = resolveSide(dep, createLeft);
                    const right = resolveSide(dep, createRight);
                    if (same(left.address, right.address)) throw new Error('不能用同一个代币建池');
                    const router = bind(dep.exchanges[exchangeIndex].router, abis.router, signer);
                    const amountLeft = parseAmount(createAmtLeft);
                    const amountRight = parseAmount(createAmtRight);
                    if (left.native || right.native) {
                      const token = left.native ? right : left;
                      const amountToken = left.native ? amountRight : amountLeft;
                      const value = left.native ? amountLeft : amountRight;
                      const erc20 = bind(token.address, abis.erc20, signer);
                      await ensureApprove(erc20, me, await router.getAddress(), amountToken);
                      await (await router.createPairAndAddLiquidityETH(token.address, amountToken, me, { value })).wait();
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
              <p className="note">池子已经存在时，这个按钮只会按当前比例继续加流动性。TKB/ETH 部署后还是空的，可以自己建。</p>
            </div>
          </div>
        </section>

        <section className="section" id="lp">
          <div className="section-head">
            <h2>流动性</h2>
            {current ? (
              <span className="chip">
                {current.exchangeName} · {sym(current.token0)} / {sym(current.token1)}
              </span>
            ) : (
              <span className="chip">先选一个池子</span>
            )}
          </div>
          {lpPending ? <p className="chip chip-wait pending">{lpPending}</p> : null}
          <div className="two">
            <div className="card">
              <h2 className="subhead">这个池子的来源</h2>
              <div className={lpPending ? 'dim' : undefined}>
                {dep ? <PositionTable dep={dep} rows={lps} showOwner /> : <p className="note">先连到 Hardhat 或 Sepolia。</p>}
              </div>
              {current ? (
                <div className="form-grid add-grid">
                  <label>
                    {sym(current.token0)}
                    <input value={add0} onChange={(e) => setAdd0(e.target.value)} />
                  </label>
                  <label>
                    {sym(current.token1)}
                    <input value={add1} onChange={(e) => setAdd1(e.target.value)} />
                  </label>
                  <button
                    type="button"
                    className="cta"
                    disabled={busy || !address}
                    onClick={() =>
                      run('添加流动性', async () => {
                        if (!dep) throw new Error('先选 Hardhat 或 Sepolia');
                        if (!current) throw new Error('先选一个池子');
                        const signer = needSigner();
                        const me = await signer.getAddress();
                        const router = bind(dep.exchanges[current.exchangeIndex].router, abis.router, signer);
                        const amount0 = parseAmount(add0);
                        const amount1 = parseAmount(add1);
                        const routerAddr = await router.getAddress();
                        if (same(current.token0, wethAddr)) {
                          await ensureApprove(bind(current.token1, abis.erc20, signer), me, routerAddr, amount1);
                          await (await router.addLiquidityETH(current.token1, amount1, me, { value: amount0 })).wait();
                        } else if (same(current.token1, wethAddr)) {
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
            </div>
            <div className="card" id="my-nfts">
              <h2 className="subhead">我的流动性 NFT</h2>
              {dep ? (
              <PositionTable
                dep={dep}
                rows={nfts}
                action={(row) => (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(`取回 #${row.tokenId.toString()}`, async () => {
                        const signer = needSigner();
                        const me = await signer.getAddress();
                        const router = bind(dep.exchanges[row.exchangeIndex].router, abis.router, signer);
                        if (same(row.token0, wethAddr) || same(row.token1, wethAddr)) {
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
              ) : (
                <p className="note">先连到 Hardhat 或 Sepolia。</p>
              )}
              <p className="note">当前可取回的数量已经包含手续费。部署者的初始 NFT 不要全部销毁，不然价差样本就没了。</p>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="two even">
            <div className="card" id="sim">
              <h2 title="1 到 20 号账户。0 号是我自己，别让脚本把初始池子撤了">多账户模拟</h2>
              <p className="note">
                用 Hardhat 的 20 个测试账户随机兑换、加池、撤池。不会动部署者放进去的初始流动性。节点必须开在 127.0.0.1:8545。Sepolia 上不跑这段。
              </p>
              <div className="sim-actions">
                <label className="stack">
                  轮数
                  <input value={simRounds} onChange={(e) => setSimRounds(e.target.value)} />
                </label>
                <button
                  type="button"
                  className="cta"
                  disabled={busy || !dep?.localFaucet}
                  onClick={() =>
                    run('模拟', async () => {
                      if (!dep?.localFaucet) throw new Error('模拟只在本地 Hardhat 上跑');
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
            </div>

            <div className="card" id="arb">
              <h2 title="一笔交易走完。中间失败就当没发生">
                原子套利<span className="nick">搬砖</span>
              </h2>
              <p className="note">
                合约会比较两个交易所，在更便宜的一边买入，再到另一边卖出。赚不到钱就整笔回滚。这里用的是 ERC20，ETH 池请选 WETH，并先包装。
              </p>
              <div className="form-grid">
                <label>
                  支付
                  <select value={arbIn} onChange={(e) => setArbIn(e.target.value as SideId)}>
                    {arbSides.map((side) => (
                      <option key={side}>{side}</option>
                    ))}
                  </select>
                </label>
                <label>
                  中间代币
                  <select value={arbOut} onChange={(e) => setArbOut(e.target.value as SideId)}>
                    {arbSides.map((side) => (
                      <option key={side}>{side}</option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  数量
                  <input value={arbAmt} onChange={(e) => setArbAmt(e.target.value)} />
                </label>
              </div>
              <div className="arb-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    run('套利预览', async () => {
                      const provider = providerRef.current ?? rpcProvider();
                      if (!dep) throw new Error('先选 Hardhat 或 Sepolia');
                      const view = await readArb(dep, provider, arbIn, arbOut, parseAmount(arbAmt));
                      setArbView({ ...view, source: '预览' });
                    })
                  }
                >
                  预览
                </button>
                <button
                  type="button"
                  className="cta"
                  disabled={busy || !address}
                  onClick={() =>
                    run('执行套利', async () => {
                      const signer = needSigner();
                      const me = await signer.getAddress();
                      const amount = parseAmount(arbAmt);
                      if (!dep) throw new Error('先选 Hardhat 或 Sepolia');
                      const tokenIn = resolveSide(dep, arbIn);
                      const tokenOut = resolveSide(dep, arbOut);
                      if (tokenIn.native || tokenOut.native) throw new Error('套利请选择 WETH，不要选原生 ETH');
                      const arb = bind(dep.arbitrage, abis.arbitrage, signer);
                      const view = await readArb(dep, signer, arbIn, arbOut, amount);
                      setArbView({ ...view, source: '预览' });
                      await ensureApprove(bind(tokenIn.address, abis.erc20, signer), me, await arb.getAddress(), amount);
                      // 没有利润也发出去，让合约自己 revert，方便看到整笔回滚。
                      const tx = await arb.execute(
                        dep.exchanges[0].router,
                        dep.exchanges[1].router,
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
                        buyName: exchangeNameOfRouter(dep, parsed.args.buyRouter),
                        sellName: exchangeNameOfRouter(dep, parsed.args.sellRouter),
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
            </div>
          </div>
        </section>

        <section className="card" id="log">
          <div className="card-title">
            <h2>操作记录</h2>
          </div>
          <div className="log">
            {logs.length === 0 ? (
              <p className="note">还没有操作。</p>
            ) : (
              logs.map((line, index) => <LogLine key={`${index}-${line}`} line={line} />)
            )}
          </div>
        </section>

        <footer className="foot">
          <span>浙大区块链作业2 · MiniDEX</span>
          <span className="sid">魏宝龙 · 3230105407</span>
        </footer>
      </main>
      {error ? <div className="toast">{error}</div> : null}
    </div>
  );
}

function LogLine({ line }: { line: string }) {
  const cut = line.indexOf('  ');
  const time = cut > 0 ? line.slice(0, cut) : '';
  const rest = cut > 0 ? line.slice(cut + 2) : line;
  return (
    <div className={rest.includes('失败') ? 'log-line bad' : 'log-line'}>
      <span className="log-time">{time}</span>
      <span>{rest}</span>
    </div>
  );
}

// 用页面上看到的储备估一下，不另发请求。差价里已经含 0.3% 手续费。
function describeImpact(
  dep: DexDeployment,
  pools: PoolRow[],
  exchangeIndex: number,
  swapIn: SideId,
  swapOut: SideId,
  swapAmt: string,
): Impact | null {
  if (pools.length === 0) return null;
  let amount: bigint;
  try {
    amount = parseAmount(swapAmt);
  } catch {
    return null;
  }
  if (amount === 0n) return null;
  const left = resolveSide(dep, swapIn);
  const right = resolveSide(dep, swapOut);
  if (same(left.address, right.address)) return null;
  const pool = pools.find((row) => {
    if (row.exchangeIndex !== exchangeIndex) return false;
    const a = row.token0.toLowerCase();
    const b = row.token1.toLowerCase();
    const i = left.address.toLowerCase();
    const o = right.address.toLowerCase();
    return (a === i && b === o) || (a === o && b === i);
  });
  if (!pool) return { text: '这个交易所还没有这对池子。', bps: 0n };
  const reserveIn = pool.token0.toLowerCase() === left.address.toLowerCase() ? pool.reserve0 : pool.reserve1;
  const reserveOut = pool.token0.toLowerCase() === left.address.toLowerCase() ? pool.reserve1 : pool.reserve0;
  if (reserveIn === 0n || reserveOut === 0n) return { text: '池子几乎空了，这单别硬换。', bps: 0n };
  const out = (reserveOut * amount * 997n) / (reserveIn * 1000n + amount * 997n);
  if (out === 0n) return { text: '按现在的储备，换出来会是 0。', bps: 0n };
  const ideal = amount * reserveOut;
  const got = out * reserveIn;
  if (got >= ideal) return null;
  const bps = ((ideal - got) * 10000n) / ideal;
  const whole = (bps / 100n).toString();
  const frac = (bps % 100n).toString().padStart(2, '0');
  return { text: `比池子现价大约少 ${whole}.${frac}%，0.3% 手续费算在里面。`, bps };
}

async function readArb(
  dep: DexDeployment,
  runner: Signer | Provider,
  arbIn: SideId,
  arbOut: SideId,
  amount: bigint,
): Promise<ArbView> {
  const tokenIn = resolveSide(dep, arbIn);
  const tokenOut = resolveSide(dep, arbOut);
  if (same(tokenIn.address, tokenOut.address)) throw new Error('两个代币不能一样');
  const arb = bind(dep.arbitrage, abis.arbitrage, runner);
  const plan = await arb.preview(
    dep.exchanges[0].router,
    dep.exchanges[1].router,
    tokenIn.address,
    tokenOut.address,
    amount,
  );
  return {
    profitable: Boolean(plan.profitable),
    buyName: exchangeNameOfRouter(dep, plan.buyRouter),
    sellName: exchangeNameOfRouter(dep, plan.sellRouter),
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
    <div className={done ? 'arb-box done' : 'arb-box'}>
      <div className="arb-path" title="同一笔交易里按这个顺序走">
        <span className="step">{view.tokenIn}</span>
        <span className="hop">买入 · {view.buyName || '—'}</span>
        <span className="step">
          {fmt(view.amountBought)} {view.tokenOut}
        </span>
        <span className="hop">卖出 · {view.sellName || '—'}</span>
        <span className="step">
          {fmt(view.amountBack)} {view.tokenIn}
        </span>
      </div>
      <p className="arb-line">
        <strong>{arbHeadline(done, view.profitable, fmt(view.profit), view.tokenIn)}</strong>
      </p>
      <p className="note">
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
  dep,
  rows,
  showOwner,
  action,
}: {
  dep: DexDeployment;
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
            <th className="num">当初放入</th>
            <th className="num">现在可取</th>
            <th>时间</th>
            {action ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.exchangeIndex}-${row.tokenId.toString()}`}>
              <td>
                <span className={row.exchangeIndex === 0 ? 'chip chip-a' : 'chip chip-b'}>{row.exchangeName}</span>
              </td>
              <td className="num">#{row.tokenId.toString()}</td>
              {showOwner ? <td>{short(row.owner)}</td> : null}
              <td className="pair">
                {displaySymbol(dep, row.token0)}
                <span className="slash">/</span>
                {displaySymbol(dep, row.token1)}
              </td>
              <td className="num">
                {fmt(row.amount0)} / {fmt(row.amount1)}
              </td>
              <td className="num">
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
