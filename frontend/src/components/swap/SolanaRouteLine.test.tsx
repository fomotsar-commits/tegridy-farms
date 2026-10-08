import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, configure } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The routing disclosure is a best-execution claim, so the cases that matter are the
 * ones where OUR POOL LOSES or does not exist. `useSolanaRoute` and `SolanaRouteLine`
 * are mounted together, as the page mounts them; the hook caches the venue probe in
 * MODULE SCOPE, so each case re-imports both after `vi.resetModules()`. The pools read
 * is faked at its seam (`swap/venuePools`); pricing them is `venuePools.test.ts`'s.
 */

// Each case re-imports the hook and the line; in a whole run on a busy machine one
// took over 5 s. The waits are bounded for that, and none is what a case asserts.
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 15_000 });

const readVenue = vi.fn();
const readVenuePools = vi.fn();
const quoteVenuePools = vi.fn();

vi.mock('../../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../../lib/solana/swap/venuePools', () => ({
  readVenuePools: (...a: unknown[]) => readVenuePools(...a),
  quoteVenuePools: (...a: unknown[]) => quoteVenuePools(...a),
  // The hook wraps the pool index's fetch with it; with the read faked, nothing calls the result.
  rememberingFetch: () => fetch,
}));
vi.mock('../../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}), browserRpc: () => async () => null }));

const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';

const LIVE_VENUE = {
  kind: 'live' as const,
  programId: PROGRAM,
  config: {
    address: 'Cfg1', index: 0, disableCreatePool: false,
    tradeFeeRate: 2500n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n,
    createPoolFee: 150_000_000n, creatorFeeRate: 0n,
    protocolOwner: 'Own1', fundOwner: 'Own2',
  },
};

/** What a read of our pools hands the quote. Opaque here: only its identity is followed. */
const POOLS_READ = { kind: 'ok', marker: 'the pools as read' };
const ours = (out: bigint, poolAddress = 'PooL1') => ({ venue: 'own-pool', outAmount: out, label: 'venue pool', poolAddress });
const quoted = (...candidates: ReturnType<typeof ours>[]) => ({ state: 'quoted', candidates });

interface Props {
  inputMint?: string;
  outputMint?: string;
  amountInRaw?: bigint | null;
  aggregatorQuote?: { outAmount: string; priceImpactPct?: string } | null;
  aggregatorPending?: boolean;
  retry?: number;
  ownUnavailable?: string | null;
  aggregatorFail?: 'no-route' | 'unavailable' | null;
}

async function harness() {
  vi.resetModules();
  const { SolanaRouteLine } = await import('./SolanaRouteLine');
  const { useSolanaRoute } = await import('./useSolanaRoute');
  return function Harness(props: Props) {
    const route = useSolanaRoute({
      inputMint: props.inputMint ?? SOL,
      outputMint: props.outputMint ?? BAYLA,
      // `??` would swallow an EXPLICIT null, the one thing these cases need to pass.
      amountInRaw: 'amountInRaw' in props ? props.amountInRaw ?? null : 1_000_000_000n,
      aggregatorQuote: 'aggregatorQuote' in props ? props.aggregatorQuote ?? null : { outAmount: '1000000' },
      aggregatorPending: props.aggregatorPending,
      retry: props.retry,
    });
    return <SolanaRouteLine route={route} ownUnavailable={props.ownUnavailable} aggregatorFail={props.aggregatorFail} />;
  };
}

async function mount(props: Props = {}) {
  const Harness = await harness();
  const view = render(<MemoryRouter><Harness {...props} /></MemoryRouter>);
  return { ...view, Harness, update: (next: Props) => view.rerender(<MemoryRouter><Harness {...next} /></MemoryRouter>) };
}

beforeEach(() => {
  vi.clearAllMocks();
  readVenuePools.mockResolvedValue(POOLS_READ);
  quoteVenuePools.mockReturnValue({ state: 'absent', candidates: [] });
});

describe('when the venue AMM is not deployed', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('says the aggregator is the only venue, and links to why', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/no pool for this pair/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /why/i })).toHaveAttribute('href', '/pools');
  });

  it('never claims we compared anything we could not', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Jupiter\. We have no pool for this pair\./)).toBeInTheDocument());
    expect(screen.queryByText(/more than/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checked/)).not.toBeInTheDocument();
    // With no program id there is nothing to read a pool from.
    expect(readVenuePools).not.toHaveBeenCalled();
  });

  it('still states what the router does before an amount is typed', async () => {
    await mount({ amountInRaw: null });
    await waitFor(() => expect(screen.getByText(/not deployed yet/i)).toBeInTheDocument());
  });
});

describe('when the venue AMM is live', () => {
  beforeEach(() => { readVenue.mockResolvedValue(LIVE_VENUE); });

  it('routes AWAY when the aggregator pays more, and says so', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(999_000n)));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Jupiter pays 0\.1% more than our pool\./)).toBeInTheDocument());
    // One sentence: it names both venues, and nothing trails it.
    expect(screen.getByTestId('solana-route-line').textContent).toBe('RouteJupiter pays 0.1% more than our pool.');
  });

  it('loses by one raw unit: the line sends the trade to Jupiter', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(999_999n)));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Jupiter pays under 0\.001% more than our pool\./)).toBeInTheDocument());
    expect(screen.queryByText(/Our pool pays/)).not.toBeInTheDocument();
  });

  it('keeps a tie: the trade stays in our pool', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(1_000_000n)));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Our pool matches Jupiter, so the trade stays here\./)).toBeInTheDocument());
  });

  it('says an own-pool win as the route, now that the page sends the trade there', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(1_010_000n)));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Our pool pays 1% more than Jupiter\./)).toBeInTheDocument());
    // The sentence that stood here while every swap went to Jupiter whatever this line said.
    expect(screen.queryByText(/executes via Jupiter/)).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't wired/)).not.toBeInTheDocument();
  });

  it('renders an own-pool win as a COMPARISON, never as the route, when a swap in it cannot be prepared here', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(1_010_000n)));
    await mount({ aggregatorQuote: { outAmount: '1000000' }, ownUnavailable: 'the swap code did not load' });
    await waitFor(() =>
      expect(
        screen.getByText('Our own pool quotes 1% more output than Jupiter, but a swap in it cannot be prepared here right now (the swap code did not load), so this swap executes via Jupiter.'),
      ).toBeInTheDocument(),
    );
    // The load-bearing half: no claim of a fill the trader is not getting.
    expect(screen.queryByText(/Our pool pays/)).not.toBeInTheDocument();
  });

  it('says the trade cannot fill when only our pool quoted and a swap in it cannot be prepared', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(1_010_000n)));
    await mount({ aggregatorQuote: null, ownUnavailable: 'the pool program could not be checked' });
    await waitFor(() => expect(screen.getByText(/Only our own pool quoted this pair, .* so it cannot fill\./)).toBeInTheDocument());
  });

  it('takes the best of several pools', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(1_005_000n, 'PooLB'), ours(1_010_000n, 'PooLA')));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Our pool pays 1% more than Jupiter\./)).toBeInTheDocument());
  });

  // The quote's cost is each pool's own (venuePools.test.ts pins that on account bytes),
  // so the route must hand the quote the pools exactly as they were read, with the token
  // that is paid in and the amount on screen.
  it('quotes the pools it read, for the pay token and the amount on screen', async () => {
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(quoteVenuePools).toHaveBeenCalled());
    expect(quoteVenuePools).toHaveBeenLastCalledWith(POOLS_READ, SOL, 1_000_000_000n);
    const [, inputMint, outputMint, opts] = readVenuePools.mock.calls[0]!;
    expect([inputMint, outputMint]).toEqual([SOL, BAYLA]);
    expect((opts as { programId: { toBase58(): string } }).programId.toBase58()).toBe(PROGRAM);
  });

  it('falls back to the aggregator when no pool exists for the pair', async () => {
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/no pool for this pair/i)).toBeInTheDocument());
    // …and it does NOT offer the /pools explainer, because the venue IS live:
    // the honest reason here is "no pool for this pair", not "not deployed".
    expect(screen.queryByRole('link', { name: /why/i })).not.toBeInTheDocument();
  });

  it('reports a FAILED own-pool read as unquotable, never as pool-absent', async () => {
    readVenuePools.mockRejectedValue(new Error('rpc down'));
    quoteVenuePools.mockImplementation((read: { kind: string }) => ({ state: read.kind === 'unread' ? 'error' : 'absent', candidates: [] }));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    // (Wait on the SETTLED copy: the in-flight state also says "Routed to Jupiter".)
    await waitFor(() => expect(screen.getByText(/could not be quoted this time/i)).toBeInTheDocument());
    expect(screen.getByText(/Jupiter\. Our pool could not be quoted this time\./)).toBeInTheDocument();
    expect(screen.queryByText(/no pool for this pair/i)).not.toBeInTheDocument();
  });

  it('says a pool that exists and cannot be priced is unquotable, never absent', async () => {
    quoteVenuePools.mockReturnValue({ state: 'error', candidates: [] });
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/could not be quoted this time/i)).toBeInTheDocument());
    expect(screen.queryByText(/no pool for this pair/i)).not.toBeInTheDocument();
  });

  it('says a pool that was read and cannot be traded is that, not a passing failure and not absent', async () => {
    // A frozen vault, swaps switched off, a token that takes a fee on every transfer.
    quoteVenuePools.mockReturnValue({ state: 'unquotable', candidates: [] });
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Jupiter\. Our pool for this pair cannot be traded right now\./)).toBeInTheDocument());
    expect(screen.queryByText(/this time|no pool for this pair/i)).not.toBeInTheDocument();
  });

  it('reads again on the next amount after a read that failed, and when Try again is pressed', async () => {
    readVenuePools.mockResolvedValueOnce({ kind: 'unread', detail: 'HTTP 502' });
    quoteVenuePools.mockImplementation((read: { kind: string }) => (read.kind === 'unread' ? { state: 'error', candidates: [] } : quoted(ours(1_010_000n))));
    const { update } = await mount({ amountInRaw: 1_000_000_000n });
    await waitFor(() => expect(screen.getByText(/could not be quoted this time/i)).toBeInTheDocument());
    // A failed read is not kept as the answer: the next amount asks again, and finds the pool.
    update({ amountInRaw: 2_000_000_000n });
    await waitFor(() => expect(screen.getByText(/Our pool pays/)).toBeInTheDocument());
    expect(readVenuePools).toHaveBeenCalledTimes(2);

    // And so does Try again, with the amount as it was.
    readVenuePools.mockResolvedValueOnce({ kind: 'unread', detail: 'HTTP 502' });
    update({ outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountInRaw: 2_000_000_000n, retry: 0 });
    await waitFor(() => expect(screen.getByText(/could not be quoted this time/i)).toBeInTheDocument());
    update({ outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountInRaw: 2_000_000_000n, retry: 1 });
    await waitFor(() => expect(screen.getByText(/Our pool pays/)).toBeInTheDocument());
    expect(readVenuePools).toHaveBeenCalledTimes(4);
  });

  it('says it is still checking while the own-pool read is in flight, not that no pool exists', async () => {
    // A read that never resolves = the in-flight window of a pair's first amount.
    readVenuePools.mockReturnValue(new Promise(() => {}));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Checking our pools/i)).toBeInTheDocument());
    expect(screen.queryByText(/no pool for this pair/i)).not.toBeInTheDocument();
  });

  it('says a pair with no pairing coin was not looked for, never that it has no pool', async () => {
    quoteVenuePools.mockReturnValue({ state: 'not-searched', candidates: [] });
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Our pools pair a token with SOL, USDC or BAYLA, so there is none for this pair\./)).toBeInTheDocument());
    expect(screen.queryByText(/no pool for this pair/i)).not.toBeInTheDocument();
  });

  it('reads a pair’s pools once: a new amount, and a flip of the pair, quote from the same read', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(999_000n)));
    const { update } = await mount({ amountInRaw: 1_000_000_000n });
    await waitFor(() => expect(screen.getByText(/Jupiter pays .* more than our pool./)).toBeInTheDocument());
    update({ amountInRaw: 2_000_000_000n });
    await waitFor(() => expect(quoteVenuePools).toHaveBeenLastCalledWith(POOLS_READ, SOL, 2_000_000_000n));
    update({ inputMint: BAYLA, outputMint: SOL, amountInRaw: 5_000_000n });
    await waitFor(() => expect(quoteVenuePools).toHaveBeenLastCalledWith(POOLS_READ, BAYLA, 5_000_000n));
    expect(readVenuePools).toHaveBeenCalledTimes(1);
  });

  it('reads again for another pair, and shows nothing of the old pair’s pools meanwhile', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(1_010_000n)));
    const { update } = await mount();
    await waitFor(() => expect(screen.getByText(/Our pool pays/)).toBeInTheDocument());
    readVenuePools.mockReturnValue(new Promise(() => {}));
    update({ outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    await waitFor(() => expect(screen.getByText(/Checking our pools/i)).toBeInTheDocument());
    expect(screen.queryByText(/Our pool pays/)).not.toBeInTheDocument();
    expect(readVenuePools).toHaveBeenCalledTimes(2);
  });

  it('makes no decision while the aggregator’s answer for this amount is on its way', async () => {
    quoteVenuePools.mockReturnValue(quoted(ours(1_010_000n)));
    await mount({ aggregatorPending: true });
    // The pools are read meanwhile, and one standing line holds the place: no route is named yet.
    await waitFor(() => expect(readVenuePools).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('solana-route-line').textContent).toBe('RouteComparing our pools with Jupiter…'));
    expect(screen.queryByText(/pays|matches/)).not.toBeInTheDocument();
  });

  it('does not cache an unreadable venue read for the rest of the session', async () => {
    // First probe fails, second succeeds: the module-scope cache must retry
    // after an 'unreadable', so a transient RPC failure cannot pin "could not
    // be checked" until the next full page load. Both mounts share ONE module
    // instance (no vi.resetModules between them) so the real cache is on trial.
    readVenue
      .mockResolvedValueOnce({ kind: 'unreadable', detail: 'boom' })
      .mockResolvedValue(LIVE_VENUE);
    const Harness = await harness();
    const el = <MemoryRouter><Harness amountInRaw={null} aggregatorQuote={null} /></MemoryRouter>;
    const first = render(el);
    await waitFor(() => expect(screen.getByText(/could not be checked/i)).toBeInTheDocument());
    first.unmount();
    render(el);
    // The venue reads as live now. With no amount typed there is no route to name, and the failure is not repeated.
    await waitFor(() => expect(readVenue).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/could not be checked/i)).not.toBeInTheDocument());
    expect(screen.queryByTestId('solana-route-line')).toBeNull();
  });
});

describe('when the venue could not be read', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'HTTP 502' }); });

  it('says our pool could not be quoted, never that there is none, and reads no pool', async () => {
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Jupiter\. Our pool could not be quoted this time\./)).toBeInTheDocument());
    expect(readVenuePools).not.toHaveBeenCalled();
  });
});

describe('when Jupiter gave no quote and our venue is not live', () => {
  // "Quoting Jupiter" is for a quote on its way: once Jupiter answered, what each side found is said.
  it('the venue could not be read: ours could not be quoted, beside what Jupiter said, never "Quoting"', async () => {
    readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'HTTP 502' });
    for (const [fail, said] of [['no-route', 'Jupiter has no route for this pair and amount'], ['unavailable', 'Jupiter could not be asked for a quote just now']] as const) {
      const view = await mount({ aggregatorQuote: null, aggregatorFail: fail });
      await waitFor(() => expect(screen.getByTestId('solana-route-line').textContent).toBe(`RouteOur pool could not be quoted this time, and ${said}.`));
      view.unmount();
    }
  });

  it('the venue is not deployed: said beside Jupiter’s no route, never "Quoting"', async () => {
    readVenue.mockResolvedValue({ kind: 'no-program-id' });
    await mount({ aggregatorQuote: null, aggregatorFail: 'no-route' });
    await waitFor(() => expect(screen.getByTestId('solana-route-line').textContent).toBe('RouteOur own pools are not deployed yet, and Jupiter has no route for this pair and amount.'));
  });
});

describe('while the aggregator has not answered', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('renders the standing line rather than a decision it has not made', async () => {
    await mount({ aggregatorQuote: null });
    await waitFor(() => expect(screen.getByText(/Quoting Jupiter/)).toBeInTheDocument());
    expect(screen.queryByText(/pays|matches/)).not.toBeInTheDocument();
  });
});

describe('the words', () => {
  it('carry no em dash in any state', async () => {
    readVenue.mockResolvedValue(LIVE_VENUE);
    const states: Array<[ReturnType<typeof quoted> | { state: string; candidates: never[] }, Props]> = [
      [quoted(ours(1_010_000n)), {}],
      [quoted(ours(1_010_000n)), { ownUnavailable: 'the swap code did not load' }],
      [quoted(ours(990_000n)), {}],
      [quoted(ours(1_000_000n)), {}],
      [{ state: 'error', candidates: [] }, {}],
      [{ state: 'unquotable', candidates: [] }, {}],
      [{ state: 'not-searched', candidates: [] }, {}],
      [{ state: 'absent', candidates: [] }, {}],
      [quoted(ours(1_010_000n)), { aggregatorPending: true }],
      // Nothing quoted the trade: what each side found is said.
      ...(['error', 'unquotable', 'not-searched', 'absent'] as const).flatMap((state) =>
        (['no-route', 'unavailable'] as const).map((fail): [{ state: string; candidates: never[] }, Props] => [
          { state, candidates: [] },
          { aggregatorQuote: null, aggregatorFail: fail },
        ]),
      ),
      [quoted(ours(1_010_000n)), { aggregatorQuote: null, aggregatorFail: 'unavailable', ownUnavailable: 'the swap code did not load' }],
    ];
    for (const [q, props] of states) {
      quoteVenuePools.mockReturnValue(q);
      const view = await mount(props);
      await waitFor(() => expect(screen.getByTestId('solana-route-line')).toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId('solana-route-line').textContent).not.toMatch(/Checking/));
      expect(screen.getByTestId('solana-route-line').textContent).not.toContain(String.fromCharCode(0x2014));
      view.unmount();
    }
  });
});
