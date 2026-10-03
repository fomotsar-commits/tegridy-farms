// The list a visitor sees before typing a token: every pool read on chain, each with a
// way in, dollar lines only when the SOL price was read, and nothing at all in a build
// whose readers cannot list.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VenuePoolList } from './VenuePoolList';
import type { LpReaders } from './readers';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { MintFacts, TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

function readersOf(list: (() => Promise<PoolListRead>) | undefined, safety?: LpReaders['safety']): LpReaders {
  return { programId: 'p', listPools: list, safety: safety ?? (async () => new Map()) } as unknown as LpReaders;
}

function pool(sol: bigint, tok: bigint) {
  const b = buildPool({ mint: key(), configIndex: 1, solReserve: sol, tokenReserve: tok, plain: true });
  return viewOf(b, { sol, tok, origin: 'standard' });
}

const readToken = (mint: string, name: string, symbol: string): TokenSafety => ({
  kind: 'read',
  mint,
  verdict: 'ok',
  blocks: [],
  warnings: [],
  facts: { decimals: 6 } as unknown as MintFacts,
  name,
  symbol,
  metadataSource: 'metaplex',
});

const okList = (pools: ReturnType<typeof pool>[], extra: Partial<Extract<PoolListRead, { kind: 'ok' }>['list']> = {}): PoolListRead => ({
  kind: 'ok',
  list: { pools, unread: 0, otherPairs: 0, truncated: false, chainNow: 1n, ...extra },
});

describe('VenuePoolList', () => {
  it('lists each pool with its name, what it holds, its price and fee, and a button that opens it in the finder', async () => {
    const v = pool(1_000_000_000n, 1_000_000_000n);
    const onPick = vi.fn();
    const safety = vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, readToken(m, 'Bayla', 'BAYLA')])));
    render(<VenuePoolList readers={readersOf(async () => okList([v]), safety)} reloadKey={0} usdPerSol={null} onPick={onPick} />);
    const row = await screen.findByTestId('lp-venue-pool');
    expect(row).toHaveAttribute('data-pool', v.address);
    expect(row).toHaveTextContent('Bayla (BAYLA)');
    expect(row).toHaveTextContent('standard address');
    expect(row).toHaveTextContent(v.tokenMint);
    expect(row).toHaveTextContent('no problems found');
    expect(row).toHaveTextContent(/In the pool\s*1(\.0+)? SOL and 1,000(\.0+)? tokens/);
    expect(row).toHaveTextContent(/Price here\s*1 token = 0\.001 SOL/);
    expect(row).toHaveTextContent(/Fee tier 1\s*Traders pay/);
    expect(safety).toHaveBeenCalledWith([v.tokenMint]);
    fireEvent.click(screen.getByRole('button', { name: 'Open this pool' }));
    expect(onPick).toHaveBeenCalledWith(v.tokenMint);
    // No SOL price: no dollar line anywhere.
    expect(row).not.toHaveTextContent('$');
  });

  it('shows a dollar line for a pool only from a read SOL price: twice the SOL side', async () => {
    const v = pool(1_000_000_000n, 1_000_000_000n);
    render(<VenuePoolList readers={readersOf(async () => okList([v]))} reloadKey={0} usdPerSol={150} onPick={() => {}} />);
    const row = await screen.findByTestId('lp-venue-pool');
    expect(row).toHaveTextContent(/Liquidity\s*about \$300\.00 \(twice the SOL side/);
  });

  it('an index that did not answer says so, says it is not "none", and offers to read again', async () => {
    let n = 0;
    const list = vi.fn(async (): Promise<PoolListRead> => (n++ === 0 ? { kind: 'unread', detail: 'the pool index answered HTTP 502' } : okList([])));
    render(<VenuePoolList readers={readersOf(list)} reloadKey={0} usdPerSol={null} onPick={() => {}} />);
    const unread = await screen.findByTestId('lp-venue-unread');
    expect(unread).toHaveTextContent('could not be listed (the pool index answered HTTP 502)');
    expect(unread).toHaveTextContent('says nothing about how many there are');
    expect(screen.queryByTestId('lp-venue-pool')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    await screen.findByTestId('lp-venue-empty');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('an empty venue says no pool is open yet, and the footnotes count what could not be listed', async () => {
    render(
      <VenuePoolList readers={readersOf(async () => okList([], { unread: 2, otherPairs: 1, truncated: true }))} reloadKey={0} usdPerSol={null} onPick={() => {}} />,
    );
    await screen.findByTestId('lp-venue-empty');
    const notes = screen.getByTestId('lp-venue-notes');
    expect(notes).toHaveTextContent('2 pools the index named could not be read this time.');
    expect(notes).toHaveTextContent('One pool is not a token against SOL.');
    expect(notes).toHaveTextContent('The index holds more pools than it lists');
  });

  it('a build whose readers cannot list renders nothing', async () => {
    const { container } = render(<VenuePoolList readers={readersOf(undefined)} reloadKey={0} usdPerSol={150} onPick={() => {}} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
