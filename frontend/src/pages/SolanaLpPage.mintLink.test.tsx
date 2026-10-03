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
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
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
  'These pools run on a pool program whose admin-key changes have not had their own independent review yet. Put in only what you can afford to lose. The full notice is right under your positions.';
const LP_PARTS = ['lp-risk-line', 'lp-finder', 'lp-positions', 'lp-disclosure', 'fee-tiers'];

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
  it('live: the risk line, the finder, the positions, the full notice, the fee tiers, the status card, "The program"', async () => {
    fakeReaders();
    await mount('/solana-lp');
    await screen.findByTestId('lp-finder');
    expectTopToBottom([
      ['the heading', screen.getByRole('heading', { level: 1 })],
      ...LP_PARTS.map((id): [string, HTMLElement] => [id, screen.getByTestId(id)]),
      ['the status card', screen.getByRole('region', { name: 'Venue status' })],
      ['"The program"', screen.getByRole('region', { name: 'The program' })],
    ]);
    expect(screen.getByRole('region', { name: 'Venue status' })).toHaveTextContent(/Pools are open/);
  });

  // The line may be short only because the whole notice is on the same page, where it says.
  it('the risk line says exactly this, and the full notice is right under the positions', async () => {
    fakeReaders();
    await mount('/solana-lp');
    const line = await screen.findByTestId('lp-risk-line');
    expect(line.textContent).toBe(RISK_LINE);
    const full = screen.getByTestId('lp-disclosure');
    expect(screen.getByTestId('lp-positions').nextElementSibling).toBe(full);
    expect(full).toHaveTextContent(/have not had their own independent review yet/);
    expect(full).toHaveTextContent(/It can switch off deposits,\s+withdrawals or swaps on any pool/);
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

describe('/pools keeps the order it had', () => {
  it('the status card, the disclosure, the fee tiers, the finder, the positions, the fee sheet, and no risk line', async () => {
    fakeReaders();
    await mountPools();
    await screen.findByTestId('lp-finder');
    expectTopToBottom([
      ['the heading', screen.getByRole('heading', { level: 1 })],
      ['the status card', screen.getByRole('region', { name: 'Venue status' })],
      ...['lp-disclosure', 'fee-tiers', 'lp-finder', 'lp-positions'].map((id): [string, HTMLElement] => [id, screen.getByTestId(id)]),
      ['the fee sheet', screen.getByRole('region', { name: 'Fee sheet' })],
      ['"The program"', screen.getByRole('region', { name: 'The program' })],
    ]);
    expect(screen.queryByTestId('lp-risk-line')).toBeNull();
    expect(document.body.textContent).not.toContain('The full notice is right under your positions.');
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
