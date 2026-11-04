import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.20",
    settings: {
      // 兼容教学中使用的 Ganache 节点。
      evmVersion: "paris",
      // 套利事件字段比较多，不用 viaIR 会 stack too deep。
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // Hardhat 3 里测试走的是 default，节点脚本用的是 hardhat，两边都多给几个账户。
    default: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      accounts: {
        count: 25,
      },
    },
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      accounts: {
        count: 25,
      },
    },
    localhost: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: "remote",
    },
    ganache: {
      type: "http",
      chainType: "l1",
      url: process.env.GANACHE_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: "remote",
    },
  },
});
