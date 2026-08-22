// The honesty guard for the trigger surface's rendered half.
//
// armState.test.ts proves the verdict is computed correctly. This proves the verdict
// reaches the screen: that the panel does not offer a placement button it cannot
// honour, does not decorate an unarmed order with reassuring chrome, and prints the
// reason next to the refusal rather than behind a tooltip.
//
// The wallet is mocked as a plain EOA on mainnet — the most common visitor, and the
// one for whom nothing on this surface can fire until F4's keeper exists.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111' }),
  useChainId: () => 1,
  usePublicClient: () => ({ getCode: async () => '0x' }), // no bytecode → EOA
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { TriggerOrderTab } from './TriggerOrderTab';

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('an EOA is told plainly that nothing would fire', () => {
  it('labels the order Not armed', async () => {
    render(<TriggerOrderTab />);
    await waitFor(() => expect(screen.getAllByText(/Not armed/i).length).toBeGreaterThan(0));
  });

  it('says the venue runs no keeper, in the panel body', async () => {
    render(<TriggerOrderTab />);
    await waitFor(() => expect(screen.getByText(/runs no keeper yet/i)).toBeInTheDocument());
    expect(screen.getByText(/It would not fire/i)).toBeInTheDocument();
  });

  it('does not offer a working placement button', async () => {
    render(<TriggerOrderTab />);
    const button = await screen.findByRole('button', { name: /cannot be armed/i });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^arm /i })).toBeNull();
  });

  it('never labels the order armed, active or monitoring', async () => {
    const { container } = render(<TriggerOrderTab />);
    await waitFor(() => expect(screen.getByText(/runs no keeper yet/i)).toBeInTheDocument());
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\bmonitoring\b/i);
    expect(text).not.toMatch(/\bwatching the market\b/i);
    // "Armed" only ever appears as part of the refusal ("Not armed" / "Cannot be armed").
    for (const m of text.matchAll(/armed/gi)) {
      const before = text.slice(Math.max(0, m.index! - 12), m.index!);
      expect(before).toMatch(/not |be /i);
    }
  });

  it('can show exactly what the keeper would have to provide', async () => {
    render(<TriggerOrderTab />);
    const disclose = await screen.findByRole('button', { name: /what would have to exist/i });
    fireEvent.click(disclose);
    expect(screen.getByText(/never holds user funds/i)).toBeInTheDocument();
    expect(screen.getByText(/must be visible as not fired/i)).toBeInTheDocument();
  });
});

describe('the fee row is honest about a fee nobody is paying', () => {
  it('reads None, and states the published rate anyway', async () => {
    render(<TriggerOrderTab />);
    await waitFor(() => expect(screen.getByText('Venue fee on execution')).toBeInTheDocument());
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByText(/0\.1%/)).toBeInTheDocument();
  });

  it('does not claim the trade is free of costs', async () => {
    render(<TriggerOrderTab />);
    await waitFor(() => expect(screen.getByText('Venue fee on execution')).toBeInTheDocument());
    expect(screen.getByText(/solver fees, pool costs and network gas/i)).toBeInTheDocument();
  });
});

describe('each kind explains its own missing mechanism', () => {
  it('take-profit says CoW’s handler only fires on a falling price', async () => {
    render(<TriggerOrderTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Take-profit' }));
    await waitFor(() => expect(screen.getByText(/only fires on a FALLING price/i)).toBeInTheDocument());
  });

  it('trailing stop says nothing holds the high-water mark', async () => {
    render(<TriggerOrderTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Trailing stop' }));
    await waitFor(() =>
      expect(screen.getByText(/needs the venue keeper to hold the high-water mark/i)).toBeInTheDocument(),
    );
  });

  it('OCO says the losing leg would not be cancelled', async () => {
    render(<TriggerOrderTab />);
    fireEvent.click(screen.getByRole('button', { name: /^OCO/ }));
    await waitFor(() => expect(screen.getByText(/cannot do that — both could fill/i)).toBeInTheDocument());
  });
});
