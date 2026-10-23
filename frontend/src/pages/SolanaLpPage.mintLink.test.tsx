import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { PublicKey } from '@solana/web3.js';
import type { LpReaders } from '../components/solana/lp/readers';

// The REAL LP section on its two tabs: /solana-lp?mint=<mint> opens the pool finder on that
// token, as /pools?mint= does; /solana-lp opens on the finder, and /pools keeps its order.
// Only the reads, the wallet stack and LP's mode (reads-only, so no write code) are faked.
const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}), browserRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../components/solana/SolanaProviders', () => ({ SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: null }) }));
vi.mock('../components/solana/SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
const reads = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../components/solana/lp/readers', () => ({ browserLpReaders: () => reads.current }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => 'off',
}));

const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
// A real mint (32 bytes of base58), not SOL, which the finder refuses.
const M = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const LIVE = {
  kind: 'live',
  programId: PROGRAM,
  config: {
    address: 'CfG1111111111111111111111111111111111111111',
    index: 0, disableCreatePool: false,
    tradeFeeRate: 2500n, protocolFeeRate: 120_000n, fundFeeRate: 0n,
    createPoolFee: 0n, creatorFeeRate: 0n,
    protocolOwner: 'Own1', fundOwner: 'Own2',
  },
  publicTier: { kind: 'not-asked' },
} as const;

function fakeReaders() {
  const unread = { kind: 'unread' as const, detail: 'not read in this test' };
  const r = {
    programId: PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { kind: 'unread' as const, mint: m, detail: 'not read' }]))),
    findPools: vi.fn(async (_mint: PublicKey) => ({ ...unread, index: unread })),
    outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not read' })),
    positions: vi.fn(async () => unread),
    feeTiers: vi.fn(async () => unread),
    wallet: vi.fn(async () => { throw new Error('not read in this test'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not read in this test'); }),
  };
  reads.current = r as unknown as LpReaders;
  return r;
}

// The real LP section is a lazy chunk. Its module graph is loaded once here, outside any
// test's own clock, so the lazy import inside a test resolves from what is already loaded
// (a cold load under a busy machine outran findBy's one second).
beforeAll(async () => {
  await import('../components/solana/lp/SolanaLpSection');
  await import('./SolanaLpPage');
  await import('./PoolsPage');
}, 60_000);

async function mount(path: string) {
  const { default: SolanaLpPage } = await import('./SolanaLpPage');
  return render(<MemoryRouter initialEntries={[path]}><SolanaLpPage /></MemoryRouter>);
}

async function mountPools() {
  const { default: PoolsPage } = await import('./PoolsPage');
  return render(<MemoryRouter initialEntries={['/pools']}><PoolsPage /></MemoryRouter>);
}

/** Each element comes after the one before it, reading the page top to bottom. */
function expectTopToBottom(named: [string, HTMLElement][]) {
  for (let i = 1; i < named.length; i++) {
    const [above, a] = named[i - 1]!;
    const [below, b] = named[i]!;
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING, `${below} is not after ${above}`).toBeTruthy();
  }
}

const RISK_LINE =
  "The team's vault can pause removing, change fees or replace the program, 48 hours after both its keys approve. No outside firm has checked our changes. Only add what you can afford to lose.";
const LP_PARTS = ['lp-earn-line', 'lp-finder', 'lp-positions', 'fee-tiers', 'lp-routes', 'lp-disclosure'];

beforeEach(() => { vi.clearAllMocks(); readVenue.mockResolvedValue(LIVE); });

describe('the ?mint= link on /solana-lp', () => {
  it('opens the finder on that token: the field holds it and its pools are searched', async () => {
    const r = fakeReaders();
    await mount(`/solana-lp?mint=${M}`);
    expect(await screen.findByTestId('lp-finder')).toBeInTheDocument();
    expect(screen.getByLabelText(/Token mint address/)).toHaveValue(M);
    await waitFor(() => expect(r.findPools).toHaveBeenCalled());
    expect(r.findPools.mock.calls[0]![0].toBase58()).toBe(M);
  });

  it('with no ?mint=, the finder waits for a token and searches nothing', async () => {
    const r = fakeReaders();
    await mount('/solana-lp');
    expect(await screen.findByTestId('lp-finder')).toBeInTheDocument();
    expect(screen.getByLabelText(/Token mint address/)).toHaveValue('');
    expect(r.findPools).not.toHaveBeenCalled();
  });
});

// The finder used to sit 1,506px down a phone, under the status card, the risk card and
// the fee tiers, where a visitor did not find it. On this tab it comes first.
describe('/solana-lp opens on the pool finder', () => {
  it('live: the earn line, the finder, the positions, the rates, the routes, the full notice, the Venue AMM link, the status card, "The program"', async () => {
    fakeReaders();
    await mount('/solana-lp');
    await screen.findByTestId('lp-finder');
    const h1 = screen.getByRole('heading', { level: 1 });
    expectTopToBottom([
      ['the heading', h1],
      ...LP_PARTS.map((id): [string, HTMLElement] => [id, screen.getByTestId(id)]),
      ['the Venue AMM link', screen.getByRole('link', { name: /fees and status, on the Venue AMM tab/i })],
      ['the status card', screen.getByRole('region', { name: 'Venue status' })],
      ['"The program"', screen.getByRole('region', { name: 'The program' })],
    ]);
    expect(screen.getByRole('region', { name: 'Venue status' })).toHaveTextContent(/Pools are open/);
    // Between the hero's words and the finder there is one short line and nothing else: the one line on
    // earning (fees need no claim); no risk line (owner, 2026-10-17). e2e/tab-target-size.spec.ts holds the finder on the first screen.
    expect(h1.parentElement!.nextElementSibling!.firstElementChild).toBe(screen.getByTestId('lp-section'));
    expect(screen.queryByTestId('lp-risk-line')).toBeNull();
    expect(screen.getByTestId('lp-section').firstElementChild).toBe(screen.getByTestId('lp-earn-line'));
    expect(screen.getByTestId('lp-earn-line').nextElementSibling).toBe(screen.getByTestId('lp-finder'));
    expect(within(h1.parentElement!).queryByRole('link')).toBeNull();
  });

  // The vault sentence is behind a press now, first in the notice's Risks, on the same page.
  it('the vault sentence leads the full notice, below the positions, after the rates and the routes', async () => {
    fakeReaders();
    await mount('/solana-lp');
    await screen.findByTestId('lp-finder');
    const full = screen.getByTestId('lp-disclosure');
    expect(within(full).getByText(RISK_LINE).closest('details')).not.toHaveAttribute('open');
    // The rates are the positions' next neighbour, then the routes; the long notice follows them.
    expect(screen.getByTestId('lp-positions').nextElementSibling).toBe(screen.getByTestId('fee-tiers'));
    expect(screen.getByTestId('fee-tiers').nextElementSibling).toBe(screen.getByTestId('lp-routes'));
    expect(screen.getByTestId('lp-routes').nextElementSibling).toBe(full);
    expect(full).toHaveTextContent(/have not had their own independent review yet/);
    expect(full).toHaveTextContent(/The vault can switch off adding, removing or trading on any pool/);
    expect(full).toHaveTextContent(PROGRAM);
    expect(screen.getAllByTestId('lp-disclosure')).toHaveLength(1);
  });

  it('not live: the status card under the hero, and none of the LP section, risk line included', async () => {
    fakeReaders();
    readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'proxy timed out' });
    await mount('/solana-lp');
    const card = await screen.findByRole('region', { name: 'Venue status' });
    expect(card).toHaveTextContent(/The chain could not be read/);
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.nextElementSibling).toBe(card);
    for (const id of [...LP_PARTS, 'lp-section']) expect(screen.queryByTestId(id), id).toBeNull();
    expect(screen.queryByText(/Loading the pool finder/)).toBeNull();
  });
});

describe('/pools leads with the same actions', () => {
  it('the earn line, the finder, the positions, the rates, the routes, the full notice, the status card, and one rates card only', async () => {
    fakeReaders();
    await mountPools();
    await screen.findByTestId('lp-finder');
    expectTopToBottom([
      ['the heading', screen.getByRole('heading', { level: 1 })],
      ...LP_PARTS.map((id): [string, HTMLElement] => [id, screen.getByTestId(id)]),
      ['the status card', screen.getByRole('region', { name: 'Venue status' })],
      ['"The program"', screen.getByRole('region', { name: 'The program' })],
    ]);
    expect(screen.queryByRole('region', { name: 'Fee sheet' })).toBeNull();
    expect(screen.getAllByTestId('fee-tiers')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('The full notice is below your positions.');
  });
});

describe('the disclosure on /solana-lp', () => {
  it('says to see "The program" below, and that section is below it on this page', async () => {
    fakeReaders();
    await mount('/solana-lp');
    const d = await screen.findByTestId('lp-disclosure');
    expect(d).toHaveTextContent('(see “The program” below)');
    expect(within(d).queryByRole('link')).toBeNull();
    expect(d).toHaveTextContent(/have not had their own independent review yet/);
    const program = screen.getByRole('region', { name: 'The program' });
    expect(d.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
