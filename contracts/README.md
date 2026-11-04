# MiniDEX 合约

Hardhat 3、ethers 6、Solidity 0.8.20。具体怎么跑、公式和截图写在仓库根目录的 README 里。这里只留合约目录里会用到的命令。

```bash
npm ci
npm run compile
npm test
```

本地节点和部署：

```bash
npm run node
npm run deploy
npm run simulate
```

`npm run deploy` 把地址和 ABI 写到 `frontend/src/deployments/localhost.json`。

`hardhat.config.ts` 里还留着 Ganache 网络，`npm run deploy:ganache` 可以部署过去。页面默认读的是上面那个 json，RPC 写成了 `http://127.0.0.1:8545`。Ganache 如果不是这个地址，要自己改 json 里的 `rpcUrl`。

测试网络叫 `default`，`npm run node` 用的网络叫 `hardhat`。两边都配了 25 个账户，这样部署者之外还能拿出 20 个地址做模拟。
