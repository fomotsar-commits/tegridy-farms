// ProtocolPulse — the "What's Moving" live-activity feed.
//
// What this file protects: the panel is headed "Live Protocol Pulse" with a green
// pulsing dot and an "on-chain · live" tag. That framing is only true while it is
// actually showing chain activity, so the component must render NOTHING at all
// while its source is loading, errored, or empty — never an empty box under a
// live banner, and never a feed whose freshness claim outlives its data.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode, HTMLAttributes } from 'react';
import { render, screen } from '@testing-library/react';
import type { PulseItem } from '../lib/protocolEvents/types';

const feed: { items: PulseItem[]; loading: boolean; error: boolean } = {
  items: [],
  loading: false,
  error: false,
};
vi.mock('../hooks/useProtocolEvents', () => ({
  useProtocolEvents: () => feed,
}));

vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ priceInUsd: 0.00004 }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, {
    get: () => ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  });
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});

import { ProtocolPulse } from './ProtocolPulse';

function trade(over: Partial<PulseItem> = {}): PulseItem {
  return {
    id: '0xdead:1',
    kind: 'buy',
    usd: 420,
    actor: '0x1111111111111111111111111111111111111111',
    txHash: '0xdeadbeef',
    ts: Math.floor(Date.now() / 1000) - 30,
    whale: true,
    ...over,
  } as PulseItem;
}

describe('ProtocolPulse', () => {
  beforeEach(() => {
    feed.items = [];
    feed.loading = false;
    feed.error = false;
  });

  it('renders nothing while the source is still loading', () => {
    feed.loading = true;
    feed.items = [trade()];
    const { container } = render(<ProtocolPulse />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the source errored — no live banner over dead data', () => {
    feed.error = true;
    feed.items = [trade()];
    const { container } = render(<ProtocolPulse />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when there is genuinely no activity', () => {
    const { container } = render(<ProtocolPulse />);
    expect(container.innerHTML).toBe('');
  });

  it('lights up on real activity, and links each row to its transaction', () => {
    feed.items = [trade()];
    const { container } = render(<ProtocolPulse />);
    expect(screen.getByText(/Live Protocol Pulse/i)).toBeTruthy();
    expect(container.querySelector('a[href="https://etherscan.io/tx/0xdeadbeef"]')).not.toBeNull();
  });

  // HONESTY GUARD: the "live" banner and the rows are one claim. If the banner
  // can render without rows, the claim detaches from its evidence.
  it('never renders the live banner without at least one row behind it', () => {
    for (const state of [
      { loading: true, error: false, items: [] as PulseItem[] },
      { loading: false, error: true, items: [] as PulseItem[] },
      { loading: false, error: false, items: [] as PulseItem[] },
      { loading: true, error: false, items: [trade()] },
      { loading: false, error: true, items: [trade()] },
    ]) {
      feed.loading = state.loading;
      feed.error = state.error;
      feed.items = state.items;
      const { container, unmount } = render(<ProtocolPulse />);
      expect(
        container.textContent ?? '',
        `banner rendered for ${JSON.stringify({ ...state, items: state.items.length })}`,
      ).not.toMatch(/on-chain · live/i);
      unmount();
    }
  });

  it('honours the row limit rather than claiming a longer feed than it shows', () => {
    feed.items = Array.from({ length: 12 }, (_, i) => trade({ id: `0x${i}:1`, txHash: `0xhash${i}` }));
    const { container } = render(<ProtocolPulse limit={3} />);
    expect(container.querySelectorAll('a[href^="https://etherscan.io/tx/"]')).toHaveLength(3);
  });
});
