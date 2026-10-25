// Open a pool with two public fee tiers (owner, 2026-10-18): the opener picks 1% or
// 0.25%, each choice says in one line what LPs keep and what the venue takes, read from
// the chain; the 0.25% tier appears only once its account is on chain, and a failed read
// never shows it; the Rates card lists a public tier only once it exists. The 0.25% tier is
// offered for SOL against USDC only (owner, 2026-10-24): the tier choice is walked with USDC
// as the token, and a meme coin (CORN) is offered 1% alone.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { key } from '../../../lib/solana/lp/testkit.fixture';
import { recordedFeeTiers } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { prepared } from '../curve/fakeWriteApi.fixture';
import type { CreateFacts, LpWriteApi } from '../curve/ports';
import { TIER1_ADDRESS, TIER2_ADDRESS, bothTiersFacts, fakeLpApi, lpCreateSummary, LP_PROGRAM, readyFacts, tier2Config, unusedGateRpc } from './fakeLpWriteApi.fixture';

// Address derivation cannot run under jsdom: each public tier is a fixed key, by index.
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return {
    ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()),
    publicTierConfig: (_p: unknown, index: number) => new Key(new Uint8Array(32).fill(index === 2 ? 42 : 41)),
  };
});

const OWNER = key();
const wallet = vi.hoisted(() => ({
  publicKey: null as null | PublicKey,
  signTransaction: undefined as undefined | ((t: unknown) => Promise<unknown>),
  signMessage: undefined,
  connecting: false,
  wallet: null,
}));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => conn }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const MINT = key();
const M = MINT.toBase58();
/** USDC as the token: paired with SOL, the one pair the 0.25% tier is offered. */
const USDC = new PublicKey(USDC_QUOTE.mint);
const U = USDC.toBase58();

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};

const usdcToken: TokenSafety = { ...okToken, mint: U, name: 'USD Coin', symbol: 'USDC', facts: { ...okToken.facts!, decimals: 6 } };

function search(mint = M): PoolSearchRead {
  const [std1, std2] = [key().toBase58(), key().toBase58()];
  return {
    kind: 'ok',
    search: {
      mint,
      known: {
        launchPool: key().toBase58(),
        standard: [
          { index: 1, config: TIER1_ADDRESS.toBase58(), address: std1!, quote: SOL_QUOTE.mint },
          { index: 2, config: TIER2_ADDRESS.toBase58(), address: std2!, quote: SOL_QUOTE.mint },
        ],
      },
      index: { kind: 'ok', pools: [], truncated: false },
      pools: [],
      otherPairs: 0,
      knownState: { [std1!]: 'absent', [std2!]: 'absent' },
      chainNow: 1_000n,
    },
  };
}

const walletFacts = (): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: key().toBase58(), amount: 500n * 10n ** 6n },
  wsol: { exists: false, amount: 0n },
  coin: null,
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, neverRefunded: 40_000_000n },
});

function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, okToken], [U, usdcToken]])),
    findPools: vi.fn(async (mint: PublicKey) => search(mint.toBase58())),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => walletFacts()),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

function mount(r: LpReaders, o: { facts?: CreateFacts; api?: Partial<LpWriteApi>; path?: string } = {}) {
  const api = fakeLpApi({ readCreateFacts: vi.fn(async () => o.facts ?? bothTiersFacts()), ...o.api });
  render(
    <MemoryRouter initialEntries={[o.path ?? `/pools?mint=${M}`]}>
      <LpInner readers={r} writes={{ mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
  return { api };
}

const USDC_PATH = `/pools?mint=${U}`;

async function openPanel() {
  const card = await screen.findByTestId('lp-create');
  fireEvent.click(await within(card).findByRole('button', { name: 'Open a pool' }));
  const panel = await screen.findByTestId('lp-create-panel');
  return { card, panel };
}

// A terms row's value, by its label; the Fee tier choice's own heading is not a row.
const rowValue = (el: HTMLElement, label: string) =>
  within(el)
    .getAllByText(label, { exact: true })
    .filter((e) => !e.closest('[role="radiogroup"]'))
    .map((e) => e.nextElementSibling?.textContent);
const said = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe('the opener picks a fee tier', () => {
  it('both tiers on chain: the card names both rates, the form has a Fee tier choice, each choice says what LPs keep and the venue takes', async () => {
    mount(readers(), { path: USDC_PATH });
    const { card, panel } = await openPanel();
    expect(card).toHaveTextContent('No SOL pool for this token yet. You can open the first one at 1% a trade or 0.25% a trade (fee tiers read just now).');
    const group = within(panel).getByRole('radiogroup', { name: 'Fee tier' });
    const options = within(group).getAllByRole('radio');
    expect(options).toHaveLength(2);
    expect(options.map((o) => (o as HTMLInputElement).checked)).toEqual([true, false]);
    const labels = options.map((o) => said(o.closest('label')!));
    expect(labels[0]).toBe('1% a trade. LPs keep 0.84% of each trade, the venue 0.16%.');
    expect(labels[1]).toBe('0.25% a trade. LPs keep 0.21% of each trade, the venue 0.04%.');
    // Tier 1 is the first choice: the terms are its until another is picked.
    expect(rowValue(panel, 'Fee tier')).toEqual(['1: traders pay 1% a trade; LPs keep 0.840% of each trade']);
    expect(rowValue(panel, 'Pool address')).toEqual(['the standard address for fee tier 1']);
  });

  it('the rates are the chain’s, never the site’s: a tier 2 read at 0.5% with a fifth to the venue says so', async () => {
    mount(readers(), { path: USDC_PATH, facts: bothTiersFacts({}, { tradeFeeRate: 5_000n, protocolFeeRate: 200_000n }) });
    const { panel } = await openPanel();
    const group = within(panel).getByRole('radiogroup', { name: 'Fee tier' });
    expect(said(within(group).getAllByRole('radio')[1]!.closest('label')!)).toBe('0.5% a trade. LPs keep 0.4% of each trade, the venue 0.1%.');
  });

  it('picking 0.25%: the terms, the pool address and the opening sent to prepare are tier 2’s', async () => {
    const prepareLpCreate = vi.fn(async () => ({ ok: true as const, prepared: prepared(lpCreateSummary(key(), USDC, { config: tier2Config() })) }));
    mount(readers(), { path: USDC_PATH, api: { prepareLpCreate } });
    const { panel } = await openPanel();
    const group = within(panel).getByRole('radiogroup', { name: 'Fee tier' });
    fireEvent.click(within(group).getAllByRole('radio')[1]!);
    expect(group).toHaveAttribute('data-tier', '2');
    expect(rowValue(panel, 'Fee tier')).toEqual(['2: traders pay 0.25% a trade; LPs keep 0.210% of each trade']);
    expect(rowValue(panel, 'Pool address')).toEqual(['the standard address for fee tier 2']);
    fireEvent.change(within(panel).getByLabelText('SOL to put in'), { target: { value: '1' } });
    fireEvent.click(within(panel).getByTestId('lp-create-match'));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: open the pool' }));
    });
    await within(panel).findByRole('heading', { name: 'Review: open a pool' });
    expect(prepareLpCreate).toHaveBeenCalledTimes(1);
    const args = (prepareLpCreate.mock.calls[0] as unknown[])[3] as { tier: number; shown: { terms: { tradeFeeRate: bigint } } };
    expect(args.tier).toBe(2);
    expect(args.shown.terms.tradeFeeRate).toBe(2_500n);
    // The review says which tier the pool opens on.
    expect(within(panel).getByText('Pool kind', { exact: true }).nextElementSibling).toHaveTextContent('Standard address for fee tier 2');
  });

  it('a meme coin with both tiers on chain: offered 1% alone, no choice is drawn, and 0.25% is said nowhere on the card or the form', async () => {
    const prepareLpCreate = vi.fn(async () => ({ ok: true as const, prepared: prepared(lpCreateSummary(key(), MINT)) }));
    mount(readers(), { api: { prepareLpCreate } });
    const { card, panel } = await openPanel();
    expect(card).toHaveTextContent('No pool for this token yet. You can open the first one on the public fee tier (read just now): 1% a trade.');
    expect(within(panel).queryByRole('radiogroup', { name: 'Fee tier' })).toBeNull();
    expect(within(panel).queryByTestId('lp-create-tier-aside')).toBeNull();
    expect(said(card)).not.toMatch(/0.25%|tier 2/);
    expect(rowValue(panel, 'Pool address')).toEqual(['the standard address for fee tier 1']);
    fireEvent.change(within(panel).getByLabelText('SOL to put in'), { target: { value: '1' } });
    fireEvent.click(within(panel).getByTestId('lp-create-match'));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: open the pool' }));
    });
    expect(((prepareLpCreate.mock.calls[0] as unknown[])[3] as { tier: number }).tier).toBe(1);
  });

  it('tier 2 not on chain yet (mainnet today): no choice is drawn, and 0.25% is said nowhere', async () => {
    mount(readers(), { facts: readyFacts() });
    const { card, panel } = await openPanel();
    expect(within(panel).queryByRole('radiogroup', { name: 'Fee tier' })).toBeNull();
    expect(card).toHaveTextContent('You can open the first one on the public fee tier (read just now): 1% a trade.');
    expect(said(card)).not.toMatch(/0\.25%|tier 2/);
    expect(within(card).getByTestId('lp-create-cost')).toHaveTextContent('Opening a pool costs 0.15 SOL to the venue plus');
  });

  it('tier 2 could not be read: not offered, said as unread (never as absent), and Refresh reads the tiers again', async () => {
    const readCreateFacts = vi
      .fn()
      .mockResolvedValueOnce({ tiers: [readyFacts().tiers[0], { kind: 'unread', index: 2, address: TIER2_ADDRESS, detail: 'HTTP 503' }], feeAccount: { kind: 'ready' } })
      .mockResolvedValue(bothTiersFacts());
    mount(readers(), { path: USDC_PATH, api: { readCreateFacts } });
    const { card, panel } = await openPanel();
    expect(card).toHaveAttribute('data-create', 'offer');
    expect(within(panel).queryByRole('radiogroup', { name: 'Fee tier' })).toBeNull();
    const aside = within(panel).getByTestId('lp-create-tier-aside');
    expect(aside).toHaveTextContent('Fee tier 2 could not be read (HTTP 503), so it is not offered.');
    expect(said(panel)).not.toMatch(/0\.25%/);
    fireEvent.click(within(aside).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readCreateFacts).toHaveBeenCalledTimes(2));
    expect(await within(panel).findByRole('radiogroup', { name: 'Fee tier' })).toBeInTheDocument();
    expect(within(panel).queryByTestId('lp-create-tier-aside')).toBeNull();
  });

  it('tier 2 switched off beside a ready tier 1: offered on tier 1, and tier 2 is said to be off', async () => {
    const both = bothTiersFacts();
    const off: CreateFacts = { ...both, tiers: [both.tiers[0]!, { kind: 'switched-off', index: 2, address: TIER2_ADDRESS, config: tier2Config({ disableCreatePool: true }) }] };
    mount(readers(), { path: USDC_PATH, facts: off });
    const { card, panel } = await openPanel();
    expect(card).toHaveAttribute('data-create', 'offer');
    expect(within(panel).queryByRole('radiogroup', { name: 'Fee tier' })).toBeNull();
    expect(within(panel).getByTestId('lp-create-tier-aside')).toHaveTextContent('Fee tier 2 is switched off for new pools right now, so it is not offered.');
  });

  it('no tier ready: the card’s one line names the tier that decided it', async () => {
    const both = bothTiersFacts();
    const stop: CreateFacts = { ...both, tiers: [{ kind: 'not-open', index: 1, address: TIER1_ADDRESS }, { kind: 'switched-off', index: 2, address: TIER2_ADDRESS, config: tier2Config({ disableCreatePool: true }) }] };
    mount(readers(), { path: USDC_PATH, facts: stop });
    const card = await screen.findByTestId('lp-create');
    await waitFor(() => expect(card).toHaveAttribute('data-create', 'tier-off'));
    expect(card).toHaveTextContent("Opening new pools on fee tier 2 is switched off right now by the pool program's admin (the team's vault). No other fee tier is open for new pools.");
    expect(within(card).queryByRole('button', { name: 'Open a pool' })).toBeNull();
  });
});

describe('the Rates card lists a public tier once it exists', () => {
  const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((td) => td.textContent);

  it('tier 2 live: a third row, public tiers first, each named by its rate', async () => {
    const recorded = recordedFeeTiers();
    if (recorded.kind !== 'ok') throw new Error('the recording did not read');
    const tiers = [...recorded.tiers, { index: 2, address: TIER2_ADDRESS.toBase58(), config: tier2Config(), state: 'live' as const }];
    mount(readers({ feeTiers: vi.fn(async () => ({ ...recorded, tiers })) }), { path: '/pools' });
    await waitFor(() => expect(screen.getAllByTestId('fee-tier')).toHaveLength(3));
    const rows = screen.getAllByTestId('fee-tier');
    expect(rows.map((r) => r.getAttribute('data-index'))).toEqual(['1', '2', '0']);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['1% pools', '0.25% pools (SOL against USDC)', 'Launch pools']);
    expect(cells(rows[1]!)).toEqual(['0.25%', '0.21%', '0.04%']);
    const rates = screen.getByTestId('fee-tiers');
    expect(rates).toHaveTextContent('0.16% of each trade in a 1% pool.');
    expect(rates).toHaveTextContent('0.04% of each trade in a 0.25% pool.');
    expect(rates).toHaveTextContent('0.15 SOL when a public pool is opened.');
    expect(within(rates).getByTestId('lp-open-cost').textContent).toMatch(/^Open a pool: 0\.15 SOL \+ [\d.]+ SOL setup, not refunded\.$/);
  });

  it('tier 2 absent (mainnet today): not listed, and nothing on the card says 0.25%', async () => {
    const recorded = recordedFeeTiers();
    if (recorded.kind !== 'ok') throw new Error('the recording did not read');
    const tiers = [...recorded.tiers, { index: 2, address: TIER2_ADDRESS.toBase58(), config: null, state: 'absent' as const }];
    mount(readers({ feeTiers: vi.fn(async () => ({ ...recorded, tiers })) }), { path: '/pools' });
    await waitFor(() => expect(screen.getAllByTestId('fee-tier')).toHaveLength(2));
    expect(screen.getAllByTestId('fee-tier').map((r) => r.getAttribute('data-index'))).toEqual(['1', '0']);
    expect(screen.getAllByTestId('fee-tier').map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Public pools', 'Launch pools']);
    expect(said(screen.getByTestId('fee-tiers'))).not.toMatch(/not created yet|tier 2/);
  });
});
