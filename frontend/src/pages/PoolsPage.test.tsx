import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * `/pools` is the surface that answers "can this venue host liquidity pools?".
 * The whole point of it is that the answer comes from a LIVE CHAIN PROBE rather
 * than from copy, so these tests are about the four states being told apart —
 * especially the two that a lazier page would collapse into "coming soon":
 *
 *   • the AmmConfig has never been created (one instruction, not a wait), and
 *   • the chain could not be read (an outage on OUR side, not a fact about the
 *     venue).
 */

const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));

const PROGRAM = '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y';

async function mount() {
  vi.resetModules();
  const { default: PoolsPage } = await import('./PoolsPage');
  return render(<MemoryRouter><PoolsPage /></MemoryRouter>);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('when nothing is deployed', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('says the AMM is being redeployed and names the SPENT id', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/being redeployed/i)).toBeInTheDocument());
    expect(screen.getByText(/permanently spent/i)).toBeInTheDocument();
    expect(screen.getByText('Spent id')).toBeInTheDocument();
  });

  it('marks the fee sheet a PROPOSAL rather than implying it is charged', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText('PROPOSAL')).toBeInTheDocument());
    expect(screen.getByText(/nothing on chain charges it today/i)).toBeInTheDocument();
  });

  it('never claims in the present tense that a pool can be opened', async () => {
    // The regression this pins: the hero asserted "anyone can open a pool" above
    // a status card that says the program id is permanently spent, so a reader
    // met the capability claim before the correction.
    await mount();
    await waitFor(() => expect(screen.getByText(/being redeployed/i)).toBeInTheDocument());
    expect(screen.queryByText(/anyone can open a pool/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no pool can be opened here yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no pool to\s+deposit into today/i)).toBeInTheDocument();
  });

  it('shows the competitive split — 0.25% paid, 0.21% to LPs, 0.04% to the venue', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText('0.25%')).toBeInTheDocument());
    expect(screen.getByText('0.21%')).toBeInTheDocument();
    expect(screen.getByText('0.04%')).toBeInTheDocument();
    expect(screen.getByText('0.15 SOL')).toBeInTheDocument();
  });
});

describe('when the program is live but has no AmmConfig', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-config', programId: PROGRAM }); });

  it('calls it one instruction from open, NOT "coming soon"', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/one instruction from open/i)).toBeInTheDocument());
  });

  it('prints the exact missing instruction with its arguments', async () => {
    // This is the state that made graduation fail AmmNotConfigured for the whole
    // life of the previous deployment. Nobody should have to reconstruct the
    // call from a doc.
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/create_amm_config\(0, 2500, 120000, 40000, 150000000, 0\)/))
        .toBeInTheDocument());
  });
});

describe('when the venue is live', () => {
  beforeEach(() => {
    readVenue.mockResolvedValue({
      kind: 'live',
      programId: PROGRAM,
      config: {
        address: 'CfG1111111111111111111111111111111111111111',
        index: 0, disableCreatePool: false,
        // Deliberately NOT the proposed rates — the page must read these off
        // chain, not fall back to its own constants.
        tradeFeeRate: 3000n, protocolFeeRate: 250_000n, fundFeeRate: 0n,
        createPoolFee: 300_000_000n, creatorFeeRate: 0n,
        protocolOwner: 'Own1', fundOwner: 'Own2',
      },
    });
  });

  it('restores the present-tense capability claim only when the probe says live', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    // Twice: once in the hero, once in the live status card.
    expect(screen.getAllByText(/anyone can open a pool/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no pool can be opened here yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/How it will work/i)).not.toBeInTheDocument();
  });

  it('drops the PROPOSAL badge and reads the fees from the chain', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.queryByText('PROPOSAL')).not.toBeInTheDocument();
    // 0.3% paid, 25% of the fee to the venue → 0.075% venue / 0.225% LPs.
    expect(screen.getByText('0.3%')).toBeInTheDocument();
    // 0.225 and 0.075 exactly — formed from bigints, not by subtracting floats
    // (0.3 - 0.075 is 0.22499999999999998 in doubles and would display 0.22).
    expect(screen.getByText('0.23%')).toBeInTheDocument();
    expect(screen.getByText('0.07%')).toBeInTheDocument();
    expect(screen.getByText('0.3 SOL')).toBeInTheDocument();
    expect(screen.getByText(/read from the chain on load/i)).toBeInTheDocument();
  });
});

describe('when the chain cannot be read', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'proxy timed out' }); });

  it('blames our own connection, not the venue', async () => {
    // The failure this branch exists to prevent: rendering an outage as
    // "not deployed", which is a claim about the venue we did not verify.
    await mount();
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeInTheDocument());
    expect(screen.getByText(/outage on our side/i)).toBeInTheDocument();
    expect(screen.queryByText(/being redeployed/i)).not.toBeInTheDocument();
  });
});

describe('always', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('states the routing rule and that the AMM is unmodified Raydium', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/unless elsewhere is better/i)).toBeInTheDocument());
    expect(screen.getByText(/There is no tolerance band/i)).toBeInTheDocument();
    expect(screen.getByText(/verbatim fork/i)).toBeInTheDocument();
  });

  it('admits pools cannot be enumerated from a browser', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/curated one, looked up pair by pair/i)).toBeInTheDocument());
  });
});
