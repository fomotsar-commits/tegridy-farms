import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The route line compares quotes and says where the swap is sent. The page submits only
 * the aggregator's transaction, so no state may read as a trade reaching our own pool.
 *
 * The component caches the venue probe in module scope, so each case re-imports the
 * module after `vi.resetModules()` rather than reaching into that cache.
 */

const readVenue = vi.fn();
const readPoolForPair = vi.fn();
const quoteOwnPool = vi.fn();

vi.mock('../../lib/solana/cpswap/read', () => ({
  readVenue: (...a: unknown[]) => readVenue(...a),
  readPoolForPair: (...a: unknown[]) => readPoolForPair(...a),
  quoteOwnPool: (...a: unknown[]) => quoteOwnPool(...a),
}));
vi.mock('../../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
// PDA derivation is realm-sensitive under jsdom — web3.js's Node-realm Buffer
// fails its `instanceof Uint8Array` guard and every derivation throws "Unable to
// find a viable program address nonce". A component test needs jsdom, so the
// derivation is stubbed here; `cpswap/program.test.ts` covers it for real, in
// the node environment, against seeds parsed out of the program source.
vi.mock('../../lib/solana/cpswap/program', () => ({
  deriveAmmConfig: () => ({ toBase58: () => 'Cfg1' }),
  DEFAULT_AMM_CONFIG_INDEX: 0,
}));

const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const PROGRAM = '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y';

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

async function mount(props: {
  amountInRaw?: bigint | null;
  aggregatorQuote?: { outAmount: string; priceImpactPct?: string } | null;
}) {
  vi.resetModules();
  const { SolanaRouteLine } = await import('./SolanaRouteLine');
  // `??` would swallow an EXPLICIT null and hand back the default, which is the
  // one thing these cases need to be able to pass.
  const amountInRaw = 'amountInRaw' in props ? props.amountInRaw ?? null : 1_000_000_000n;
  const aggregatorQuote = 'aggregatorQuote' in props
    ? props.aggregatorQuote ?? null
    : { outAmount: '1000000' };
  return render(
    <MemoryRouter>
      <SolanaRouteLine
        inputMint={SOL}
        outputMint={BAYLA}
        amountInRaw={amountInRaw}
        aggregatorQuote={aggregatorQuote}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  readPoolForPair.mockResolvedValue({ kind: 'absent' });
  quoteOwnPool.mockReturnValue(null);
});

describe('when the venue AMM is not deployed', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('says the aggregator is the only venue, and links to why', async () => {
    await mount({});
    await waitFor(() => expect(screen.getByText(/no pool for this pair/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /why/i })).toHaveAttribute('href', '/pools');
  });

  it('never claims we compared anything we could not', async () => {
    await mount({});
    await waitFor(() => expect(screen.getByText(/every swap on this page is sent through Jupiter/)).toBeInTheDocument());
    expect(screen.queryByText(/more output than/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checked 2 venues/)).not.toBeInTheDocument();
    // With no program id there is nothing to read a pool from.
    expect(readPoolForPair).not.toHaveBeenCalled();
  });

  it('still states what the router does before an amount is typed', async () => {
    await mount({ amountInRaw: null });
    await waitFor(() => expect(screen.getByText(/not deployed yet/i)).toBeInTheDocument());
  });
});

describe('when the venue AMM is live', () => {
  beforeEach(() => { readVenue.mockResolvedValue(LIVE_VENUE); });

  it('says so when the aggregator quotes more, and never that the trade went there because of it', async () => {
    readPoolForPair.mockResolvedValue({ kind: 'ok', value: { pool: { address: 'PooL1' } } });
    quoteOwnPool.mockReturnValue({ outAmount: 999_000n, poolAddress: 'PooL1', priceImpact: 0.01 });

    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Jupiter quotes [\d.,]+% more output than our own pool/)).toBeInTheDocument());
    expect(screen.getByText(/Checked 2 venues/)).toBeInTheDocument();
    // The swap would go through Jupiter whichever quote won, so the win is not the cause.
    expect(screen.queryByText(/so the trade went there/)).not.toBeInTheDocument();
  });

  it('renders an own-pool win as a COMPARISON, never as execution — the page only submits the Jupiter tx', async () => {
    readPoolForPair.mockResolvedValue({ kind: 'ok', value: { pool: { address: 'PooL1' } } });
    quoteOwnPool.mockReturnValue({ outAmount: 1_010_000n, poolAddress: 'PooL1' });

    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/more output than Jupiter/)).toBeInTheDocument());
    // The load-bearing half: no execution claim for a venue nothing executes
    // against. handleSwap sends the Jupiter transaction unconditionally, so
    // "Routed to the venue pool" would tell the trader they are getting a fill
    // they are not. (This pinned the OLD verbatim reason before the fix.)
    expect(screen.queryByText(/Routed to the venue pool/)).not.toBeInTheDocument();
    expect(screen.getByText(/still executes via Jupiter/)).toBeInTheDocument();
  });

  // The quote's cost is the program's: quoteOwnPool charges a pool's creator fee when the
  // pool's own switch is on (cpswap/mainnetVenue.test.ts pins that on mainnet's tier 0), so
  // the route must hand it the pool it read and the tier the venue read returned, never a
  // trimmed copy without the creator rate.
  it('quotes the pool it read against the tier the venue read returned, creator rate and all', async () => {
    const venue = { ...LIVE_VENUE, config: { ...LIVE_VENUE.config, creatorFeeRate: 500n } };
    readVenue.mockResolvedValue(venue);
    const snapshot = { pool: { address: 'PooL1', enableCreatorFee: true } };
    readPoolForPair.mockResolvedValue({ kind: 'ok', value: snapshot });
    quoteOwnPool.mockReturnValue({ outAmount: 999_000n, poolAddress: 'PooL1', priceImpact: 0.01 });
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(quoteOwnPool).toHaveBeenCalled());
    expect(quoteOwnPool).toHaveBeenCalledWith(snapshot, venue.config, SOL, 1_000_000_000n);
  });

  it('falls back to the aggregator when no pool exists for the pair', async () => {
    readPoolForPair.mockResolvedValue({ kind: 'absent' });
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/no pool for this pair/i)).toBeInTheDocument());
    // …and it does NOT offer the /pools explainer, because the venue IS live —
    // the honest reason here is "no pool for this pair", not "not deployed".
    expect(screen.queryByRole('link', { name: /why/i })).not.toBeInTheDocument();
  });

  it('reports a FAILED own-pool read as unquotable, never as pool-absent', async () => {
    readPoolForPair.mockRejectedValue(new Error('rpc down'));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    // Pre-fix this rendered "This venue has no pool for this pair" — a
    // fabricated finding from a degraded read. (Wait on the SETTLED copy: the
    // in-flight state also says "Routed to Jupiter".)
    await waitFor(() => expect(screen.getByText(/could not be quoted this time/i)).toBeInTheDocument());
    expect(screen.getByText(/every swap on this page is sent through Jupiter/)).toBeInTheDocument();
    expect(screen.queryByText(/no pool for this pair/i)).not.toBeInTheDocument();
  });

  it('says it is still checking while the own-pool read is in flight, not that no pool exists', async () => {
    // A read that never resolves = the in-flight window on every keystroke.
    readPoolForPair.mockReturnValue(new Promise(() => {}));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Checking our own pool/i)).toBeInTheDocument());
    expect(screen.queryByText(/no pool for this pair/i)).not.toBeInTheDocument();
  });

  it('does not cache an unreadable venue read for the rest of the session', async () => {
    // First probe fails, second succeeds — the module-scope cache must retry
    // after an 'unreadable', so a transient RPC failure cannot pin "could not
    // be checked" until the next full page load. Both mounts share ONE module
    // instance (no vi.resetModules between them) so the real cache is on trial.
    readVenue
      .mockResolvedValueOnce({ kind: 'unreadable', detail: 'boom' })
      .mockResolvedValue(LIVE_VENUE);
    vi.resetModules();
    const { SolanaRouteLine } = await import('./SolanaRouteLine');
    const el = (
      <MemoryRouter>
        <SolanaRouteLine inputMint={SOL} outputMint={BAYLA} amountInRaw={null} aggregatorQuote={null} />
      </MemoryRouter>
    );
    const first = render(el);
    await waitFor(() => expect(screen.getByText(/could not be checked/i)).toBeInTheDocument());
    first.unmount();
    render(el);
    await waitFor(() => expect(screen.getByText(/We compare quotes from our own pools and Jupiter\./)).toBeInTheDocument());
    expect(readVenue).toHaveBeenCalledTimes(2);
  });

  // The open-a-pool form says this site's swap goes through Jupiter (lp/LpDisclosures.tsx).
  // Every state of this line has to agree: it names where the swap is sent, and never
  // gives a quote, a missing pool or a failed read as the reason the swap went to Jupiter.
  const OWN = { kind: 'ok', value: { pool: { address: 'PooL1' } } };
  const AGG = { outAmount: '1000000' };
  it.each([
    { state: 'before an amount is typed', amountInRaw: null, settled: /our own pools and Jupiter/ },
    { state: 'the aggregator quotes more', own: 999_000n, aggregatorQuote: AGG, settled: /Checked 2 venues/ },
    { state: 'our own pool quotes more', own: 1_010_000n, aggregatorQuote: AGG, settled: /more output than Jupiter/ },
    { state: 'only our own pool quotes', own: 1_010_000n, aggregatorQuote: null, settled: /Only our own pool quoted/ },
    { state: 'no pool for the pair', aggregatorQuote: AGG, settled: /no pool for this pair/ },
    { state: 'the own-pool read failed', failed: true, aggregatorQuote: AGG, settled: /could not be quoted this time/ },
    { state: 'the own-pool read is in flight', inFlight: true, aggregatorQuote: AGG, settled: /Checking our own pool/ },
  ])('says the swap goes through Jupiter: $state', async ({ settled, own, failed, inFlight, ...props }) => {
    if (own !== undefined) {
      readPoolForPair.mockResolvedValue(OWN);
      quoteOwnPool.mockReturnValue({ outAmount: own, poolAddress: 'PooL1' });
    }
    if (failed) readPoolForPair.mockRejectedValue(new Error('rpc down'));
    if (inFlight) readPoolForPair.mockReturnValue(new Promise(() => {}));

    await mount(props);
    await waitFor(() => expect(screen.getByText(settled)).toBeInTheDocument());
    const line = screen.getByText('Route').closest('p')?.textContent ?? '';
    expect(line).toMatch(/sent through Jupiter|executes via Jupiter/);
    expect(line).not.toMatch(/whichever pays more|Routed to|went there/);
  });
});

describe('while the aggregator has not answered', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('renders the standing line rather than a decision it has not made', async () => {
    await mount({ aggregatorQuote: null });
    await waitFor(() => expect(screen.getByText(/Quoting Jupiter/)).toBeInTheDocument());
    expect(screen.queryByText(/no pool for this pair|sent through/)).not.toBeInTheDocument();
  });
});
