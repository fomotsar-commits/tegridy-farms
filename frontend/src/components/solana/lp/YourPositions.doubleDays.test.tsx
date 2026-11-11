// DOUBLE DAYS on a position row (island answer twenty-four, build 7): "Day {d} in the pool =
// {2d} warm days." under the row's heading, d the position's age in whole days from its own
// history (poolDays.ts). Only for a coin the island warms (an island room's coin on Solana):
// warm days are the island's count, and it counts none for a coin it does not measure. An age
// the history does not prove, and day 0, print nothing. The readers are fakes: no chain here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { TRENCHER_WORDS } from '../../../lib/arrival';
import { ledgerFigures, type LedgerEntry } from '../../../lib/solana/lp/ledger';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import { BAYLA_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { LP_PROGRAM } from './fakeLpWriteApi.fixture';
import type { LpReaders } from './readers';
import { YourPositions } from './YourPositions';

const wallet = vi.hoisted(() => ({ publicKey: null as null | PublicKey, signTransaction: undefined, signMessage: undefined, connecting: false, wallet: null }));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => conn }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
// web3's address derivation does not run under jsdom (PoolFinder.findable.test.tsx precedent).
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

const OWNER = key();
const SOL = 10n ** 9n;
const TOK = 10n ** 6n;
const DAY = 86_400;
/** The chain's clock at the positions read: 2026-11-03 03:36:40 UTC. */
const NOW = 1_793_677_000;

/** A pool of 10 SOL and 1,000 tokens with 100 shares issued. */
function view(mint: PublicKey): PoolView {
  const b = buildPool({ plain: true, mint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000n * TOK, lpSupply: 100n * SOL, openTime: 1n });
  return viewOf(b, { sol: 10n * SOL, tok: 1_000n * TOK });
}

const token = (mint: string, symbol: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: symbol, symbol, metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
} as TokenSafety);

/** Ten of the pool's hundred shares. */
function position(v: PoolView): Position {
  const coin = v.quoteReserve / 10n;
  const tok = 100n * TOK;
  return {
    lpMint: v.snapshot.pool.lpMint, lpAccount: key().toBase58(), lpAmount: 10n * SOL, placement: 'found', placementDetail: null,
    pool: { kind: 'pool', view: v },
    value: v.quoteIsToken0 ? { token0: coin, token1: tok, sharePct: 10 } : { token0: tok, token1: coin, sharePct: 10 },
    tooSmall: false,
  };
}

let n = 0;
const at = (daysAgo: number) => ({ signature: `${++n}`.padEnd(88, 'x'), slot: n, blockTime: NOW - Math.round(daysAgo * DAY), final: true });
/** The ten shares, put in from an empty account `daysAgo` days before the read. */
const intoEmpty = (daysAgo: number): LedgerEntry =>
  ({ kind: 'deposit', ...at(daysAgo), lp: 10n * SOL, token: 100n * TOK, coin: 1n * SOL, lpBefore: 0n });

function readers(p: Position, symbol: string, entries: LedgerEntry[]): LpReaders {
  const v = (p.pool as { view: PoolView }).view;
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, token(m, symbol)]))),
    findPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here', index: { kind: 'unread' as const, detail: 'not asked here' } })),
    outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here' })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [p], chainNow: BigInt(NOW), totalShares: 1 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here' })),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ledger: vi.fn(async () => ledgerFigures(entries, v, p.lpAmount, false)),
  } as LpReaders;
}

/** Mount one position (the first main share, so its history is read with no press) and wait for the read. */
async function row(mint: PublicKey, symbol: string, entries: LedgerEntry[]): Promise<HTMLElement> {
  const p = position(view(mint));
  render(<YourPositions readers={readers(p, symbol, entries)} owner={OWNER} />);
  const li = await screen.findByTestId('lp-position');
  await waitFor(() => expect(within(li).getByTestId('lp-ledger').getAttribute('data-ledger')).toBe('ok'));
  return li;
}

beforeEach(() => {
  wallet.publicKey = OWNER;
});
afterEach(() => cleanup());

describe('the double-days line on a position row', () => {
  it('a BAYLA position put in twelve and a half days ago: day 12, 24 warm days, under the heading', async () => {
    const li = await row(new PublicKey(BAYLA_MINT), 'BAYLA', [intoEmpty(12.5)]);
    const line = await within(li).findByTestId('lp-double-days');
    expect(line).toHaveTextContent(TRENCHER_WORDS.doubleDays(12));
    expect(line).toHaveTextContent('Day 12 in the pool = 24 warm days.');
    const heading = within(li).getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent('BAYLA / SOL');
    expect(heading.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(within(li).getByText('Your share: 10.0000% of the pool')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(li.textContent).not.toMatch(/—/);
  });

  it('a coin the island does not warm gets no line: its days are not warm days', async () => {
    const li = await row(key(), 'CORN', [intoEmpty(12.5)]);
    expect(within(li).queryByTestId('lp-double-days')).toBeNull();
    expect(li.textContent).not.toContain('warm days');
  });

  it('an age the history does not prove gets no line', async () => {
    const transfer: LedgerEntry = { kind: 'other', ...at(1) };
    const li = await row(new PublicKey(BAYLA_MINT), 'BAYLA', [transfer, intoEmpty(12.5)]);
    expect(within(li).queryByTestId('lp-double-days')).toBeNull();
  });

  it('day 0, the day of the deposit, gets no line', async () => {
    const li = await row(new PublicKey(BAYLA_MINT), 'BAYLA', [intoEmpty(0.5)]);
    expect(within(li).queryByTestId('lp-double-days')).toBeNull();
  });
});
