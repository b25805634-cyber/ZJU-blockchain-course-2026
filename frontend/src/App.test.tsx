import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

test('shows the MiniDEX title', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'MiniDEX' })).toBeInTheDocument();
});
