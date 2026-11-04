import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

// 读 contracts/.env。已经在环境里的值不动。私钥不会写进代码。
const envFile = path.resolve(".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

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
    // 只有 --network sepolia 才会去读这两个变量。本地测试不需要填。
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
