import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The routing disclosure is a best-execution claim rendered to a trader, so the
 * cases that matter are the ones where OUR POOL LOSES or does not exist. A
 * disclosure that only appears when the house wins is an advertisement.
 *
 * The component caches the venue probe in MODULE SCOPE (the AMM's deployment
 * state cannot change between two keystrokes), so each case re-imports the
 * module after `vi.resetModules()` rather than reaching into that cache through
 * an exported test seam.
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
    await waitFor(() => expect(screen.getByText(/Routed to Jupiter/)).toBeInTheDocument());
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

  it('routes AWAY when the aggregator pays more, and says so', async () => {
    readPoolForPair.mockResolvedValue({ kind: 'ok', value: { pool: { address: 'PooL1' } } });
    quoteOwnPool.mockReturnValue({ outAmount: 999_000n, poolAddress: 'PooL1', priceImpact: 0.01 });

    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/so the trade went there/)).toBeInTheDocument());
    expect(screen.getByText(/Checked 2 venues/)).toBeInTheDocument();
  });

  it('keeps the trade in-house when our pool pays more', async () => {
    readPoolForPair.mockResolvedValue({ kind: 'ok', value: { pool: { address: 'PooL1' } } });
    quoteOwnPool.mockReturnValue({ outAmount: 1_010_000n, poolAddress: 'PooL1' });

    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/more output than Jupiter/)).toBeInTheDocument());
  });

  it('falls back to the aggregator when no pool exists for the pair', async () => {
    readPoolForPair.mockResolvedValue({ kind: 'absent' });
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/no pool for this pair/i)).toBeInTheDocument());
    // …and it does NOT offer the /pools explainer, because the venue IS live —
    // the honest reason here is "no pool for this pair", not "not deployed".
    expect(screen.queryByRole('link', { name: /why/i })).not.toBeInTheDocument();
  });

  it('does not let a failed own-pool read block the trade', async () => {
    readPoolForPair.mockRejectedValue(new Error('rpc down'));
    await mount({ aggregatorQuote: { outAmount: '1000000' } });
    await waitFor(() => expect(screen.getByText(/Routed to Jupiter/)).toBeInTheDocument());
  });
});

describe('while the aggregator has not answered', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('renders the standing line rather than a decision it has not made', async () => {
    await mount({ aggregatorQuote: null });
    await waitFor(() => expect(screen.getByText(/Quoting Jupiter/)).toBeInTheDocument());
    expect(screen.queryByText(/Routed to/)).not.toBeInTheDocument();
  });
});
