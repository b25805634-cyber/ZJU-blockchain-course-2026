import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import App, { arbHeadline } from './App';
import { deploymentForChain, HARDHAT_CHAIN_ID, networkLabel, SEPOLIA_CHAIN_ID } from './chain';

test('shows the MiniDEX title', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'MiniDEX' })).toBeInTheDocument();
  expect(screen.getAllByText(/浙大区块链作业2/).length).toBeGreaterThan(0);
});

test('picks Hardhat by default and keeps the Sepolia faucet off', () => {
  expect(deploymentForChain(HARDHAT_CHAIN_ID)?.localFaucet).toBe(true);
  expect(deploymentForChain(HARDHAT_CHAIN_ID)?.chainId).toBe(31337);
  expect(deploymentForChain(SEPOLIA_CHAIN_ID)?.localFaucet).toBe(false);
  expect(deploymentForChain(SEPOLIA_CHAIN_ID)?.chainId).toBe(11155111);
  expect(deploymentForChain(1)).toBeNull();
  expect(networkLabel(SEPOLIA_CHAIN_ID)).toBe('Sepolia');
  expect(networkLabel(HARDHAT_CHAIN_ID)).toBe('Hardhat 本地');
});

test('arb copy uses 预计 only before the trade lands', () => {
  expect(arbHeadline(false, true, '531.009', 'TKA')).toBe('预览，预计利润 531.009 TKA');
  expect(arbHeadline(true, true, '531.009', 'TKA')).toBe('已成交，实际利润 531.009 TKA');
  expect(arbHeadline(false, false, '0', 'TKA')).toBe('预览，当前没有正利润');
});
