// Every shared curve-token link had the same page title.
//
// THE BUG THIS PINS. `/eth-curve/:token` exists to be shared — it carries a
// Share button that copies its own URL — yet `usePageTitle` was called with two
// constants. Every token on the curve produced an identical browser tab, an
// identical meta description and an identical social preview, so a creator
// posting their coin got a link indistinguishable from every other coin's.
//
// AND THE HONESTY CONSTRAINT. A token symbol is authored by whoever deployed
// the token. It is shown, but the address travels with it and an unreadable
// symbol falls back to the address alone — never to a placeholder name, and
// never to a chain or graduation state the page did not read.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const chain = vi.hoisted(() => ({
  // One probe result per deployed launcher; index 0 is mainnet.
  probes: [] as ({ status: 'success'; result: unknown } | { status: 'failure' })[],
  symbol: undefined as unknown,
}));

const LAUNCH = {
  creator: '0x2222222222222222222222222222222222222222',
  virtualEth: 10n ** 18n,
  ethReserve: 5n * 10n ** 17n,
  tokenReserve: 10n ** 24n,
  graduationEth: 10n ** 19n,
  graduated: false,
};

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useReadContract: () => ({ data: chain.symbol }),
  useReadContracts: () => ({ data: chain.probes, isLoading: false }),
  useWriteContract: () => ({ writeContract: () => {}, isPending: false }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isSuccess: false }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ trackPageView: () => {} }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => null }));
vi.mock('../components/launcher/CurveTradePanel', () => ({ CurveTradePanel: () => null }));
vi.mock('../components/launcher/EvmCurveChart', () => ({ EvmCurveChart: () => null }));

import CurveTokenPage from './CurveTokenPage';

const TOKEN_A = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const TOKEN_B = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function mountAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/eth-curve/${token}?c=1`]}>
      <Routes>
        <Route path="/eth-curve/:token" element={<CurveTokenPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Mainnet resolves, the other probed chains do not. */
function resolvedOnMainnet(overrides: Partial<typeof LAUNCH> = {}) {
  chain.probes = [
    { status: 'success', result: { ...LAUNCH, ...overrides } },
    { status: 'failure' },
    { status: 'failure' },
  ];
}

const metaDescription = () =>
  document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  chain.symbol = undefined;
  resolvedOnMainnet();
});

describe('per-token identity in the shared link', () => {
  it('gives two different tokens two different titles', () => {
    chain.symbol = 'AAA';
    mountAt(TOKEN_A);
    const a = document.title;
    chain.symbol = 'BBB';
    mountAt(TOKEN_B);
    const b = document.title;
    expect(a).not.toBe(b);
    expect(a).toContain('AAA');
    expect(b).toContain('BBB');
  });

  it('carries the address even when a symbol resolved, and falls back to it when none did', () => {
    chain.symbol = 'AAA';
    mountAt(TOKEN_A);
    // The symbol is attacker-authored; the address is what makes the title
    // unspoofable, so it rides along rather than being replaced.
    expect(document.title).toContain('0x6B1754');
    chain.symbol = undefined;
    mountAt(TOKEN_B);
    expect(document.title).toContain('0xA0b869');
    expect(document.title).toContain('Memetics Curve');
  });

  it('strips control characters out of a hostile symbol instead of rendering them', () => {
    // A symbol is whatever the deployer's contract returns. Terminal escapes and
    // C0 control bytes have no business in a document title.
    const CONTROL = String.fromCharCode(1) + String.fromCharCode(27);
    chain.symbol = `EV${CONTROL}IL`;
    mountAt(TOKEN_A);
    expect(document.title).toContain('EVIL');
    expect(document.title.split('').some((c) => c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f))).toBe(false);
  });

  it('caps a symbol long enough to bury the address', () => {
    chain.symbol = 'A'.repeat(200);
    mountAt(TOKEN_A);
    expect(document.title).toContain('0x6B1754');
    expect(document.title.length).toBeLessThan(80);
  });

  it('describes the state it actually read, and says so differently once graduated', () => {
    mountAt(TOKEN_A);
    const onCurve = metaDescription();
    expect(onCurve).toMatch(/still on the curve/i);
    resolvedOnMainnet({ graduated: true });
    mountAt(TOKEN_A);
    expect(metaDescription()).toMatch(/graduated/i);
    expect(metaDescription()).not.toBe(onCurve);
  });

  it('never asserts a chain or state for a token that resolved nowhere', () => {
    chain.probes = [{ status: 'failure' }, { status: 'failure' }, { status: 'failure' }];
    mountAt(TOKEN_A);
    expect(metaDescription()).toMatch(/looking up/i);
    expect(metaDescription()).not.toMatch(/graduated|still on the curve/i);
  });
});
