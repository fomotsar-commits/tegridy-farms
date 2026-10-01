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
// The LP section has its own tests (components/solana/lp); here only WHEN it mounts matters.
vi.mock('../components/solana/lp/SolanaLpSection', () => ({ default: () => <div data-testid="lp-section" /> }));
// LP's own switch, steerable per test (spec addendum D24): the page's words about what this
// site can do with the pools follow it. Every other test sees the shipped 'off'.
const lp = vi.hoisted(() => ({ mode: 'off' as 'off' | 'on' | 'withdraw-only' }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => lp.mode,
}));

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

  it('mounts the LP finder', async () => {
    await mount();
    expect(await screen.findByTestId('lp-section')).toBeInTheDocument();
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

  // Review 2026-09-30: this card said the swap "takes" our pool when it pays more, but
  // every Solana swap executes through Jupiter (SolanaRouteLine says so on the swap).
  it('says the swap compares our pools but still trades through Jupiter, and that the AMM is unmodified Raydium', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/side by side with Jupiter/i)).toBeInTheDocument());
    expect(screen.getByText(/still goes through\s+Jupiter/i)).toBeInTheDocument();
    expect(screen.queryByText(/takes the one that pays/i)).toBeNull();
    expect(screen.getByText(/verbatim fork/i)).toBeInTheDocument();
  });

  it('says the browser cannot list pools itself, and how the server index fills that gap', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/A browser cannot list pools itself/i)).toBeInTheDocument());
    expect(screen.getByText(/returns addresses only/i)).toBeInTheDocument();
  });

  it('mounts the LP finder only when the venue reads as live', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/being redeployed/i)).toBeInTheDocument());
    expect(screen.queryByTestId('lp-section')).not.toBeInTheDocument();
  });
});

// Addendum D24 (C8): the two "not switched on yet" sentences follow LP's own switch, so
// flipping it (or the e2e build, where it is already 'on') never leaves this page saying
// something false. The routing card is about the swap and stays in every mode.
describe("what this site can do with the pools follows LP's own switch", () => {
  const live = () =>
    readVenue.mockResolvedValue({
      kind: 'live',
      programId: PROGRAM,
      config: {
        address: 'CfG1111111111111111111111111111111111111111',
        index: 0, disableCreatePool: false,
        tradeFeeRate: 2500n, protocolFeeRate: 200_000n, fundFeeRate: 0n,
        createPoolFee: 0n, creatorFeeRate: 500n,
        protocolOwner: 'Own1', fundOwner: 'Own2',
      },
    });
  beforeEach(() => { lp.mode = 'off'; live(); });

  it("'off': reads only, and says adding and removing are not switched on", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.getByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeInTheDocument();
    expect(screen.getByText(/This site only reads pools so far\./)).toBeInTheDocument();
    expect(screen.getByText(/still goes through\s+Jupiter/i)).toBeInTheDocument();
  });

  it("'on': says what the section below can do, and never that it is not switched on", async () => {
    lp.mode = 'on';
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    // SPEC_S2_CREATE 2.6 (K4): opening a pool joins the 'on' copy. Whether the public tier
    // exists is said only by the create card's live read, never by this fixed copy (B review parity-3).
    expect(
      screen.getByText(/below you can add liquidity to a pool whose checks pass, take yours out, or open a new pool on the public fee tier \(the pools section says whether that can be done right now\)\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This site can add and remove liquidity, and open new pools on the public fee tier \(the pools section below says whether it can right now\)\./),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/once (the public fee tier|that tier) exists/i);
    expect(screen.queryByText(/does not open pools/i)).toBeNull();
    // The swap's routing card keeps its own "not switched on yet" (addendum D24); this is the LP one.
    expect(screen.queryByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeNull();
    expect(screen.queryByText(/only reads pools so far/i)).toBeNull();
    // The swap's own routing is a different matter: still through Jupiter, in every mode.
    expect(screen.getByText(/still goes through\s+Jupiter/i)).toBeInTheDocument();
  });

  it("'withdraw-only': adding is paused, taking liquidity out still works", async () => {
    lp.mode = 'withdraw-only';
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.getByText(/Adding liquidity and opening pools from here are paused; taking yours out still works\./)).toBeInTheDocument();
    expect(screen.getByText(/This site can take liquidity out; adding liquidity and opening pools are paused\./)).toBeInTheDocument();
    expect(screen.queryByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeNull();
  });
});
