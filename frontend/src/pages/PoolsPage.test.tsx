import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * `/pools` answers "can this venue host liquidity pools?" from a LIVE CHAIN PROBE, never
 * from copy. These tests keep its states apart, and hold that a fee is shown only when
 * the chain returned it: a failed or pending read shows no number at all.
 */

// Warms the page's module graph at collection time. NOT dead code: mount() re-imports the
// page under vi.resetModules(), and the first of those is a cold load inside a test body,
// on the 5s clock, that grows with machine load. Paid here, where no timeout runs, every
// re-import is a few ms.
import './PoolsPage';

const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
// The LP section has its own tests (components/solana/lp); here only WHEN it mounts matters.
vi.mock('../components/solana/lp/SolanaLpSection', () => ({ default: () => <div data-testid="lp-section" /> }));
// LP's own switch, steerable per test (spec addendum D24): the page's words about what this
// site can do with the pools follow it. Every other test sees 'off' (the reads-only page),
// whatever is committed; the committed value is pinned in lpWriteFlag.test.ts.
const lp = vi.hoisted(() => ({ mode: 'off' as 'off' | 'on' | 'withdraw-only' }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => lp.mode,
}));

const PROGRAM = '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y';

const LIVE = {
  kind: 'live',
  programId: PROGRAM,
  config: {
    address: 'CfG1111111111111111111111111111111111111111',
    index: 0, disableCreatePool: false,
    // Deliberately not any tier this repo has ever written down: the page must
    // read these off chain, with nothing of its own to fall back to.
    tradeFeeRate: 3000n, protocolFeeRate: 250_000n, fundFeeRate: 0n,
    createPoolFee: 300_000_000n, creatorFeeRate: 0n,
    protocolOwner: 'Own1', fundOwner: 'Own2',
  },
} as const;

async function mount() {
  vi.resetModules();
  const { default: PoolsPage } = await import('./PoolsPage');
  return render(<MemoryRouter><PoolsPage /></MemoryRouter>);
}

/** The first read has answered: the status card is past its loading line. */
async function settled() {
  await waitFor(() => expect(readVenue).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Reading the venue/i)).not.toBeInTheDocument());
}

/** No fee figure of any kind on the page: no percentage stat, no SOL price, no badge. */
function expectNoFeeNumbers() {
  // The whole page's text, so a figure inside a sentence counts too, not only a stat.
  expect(document.body.textContent).not.toMatch(/\d\s*%|\d\s*SOL\b/);
  expect(screen.queryByText(/^\d+(\.\d+)?%$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/\d SOL$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/% a trade/)).not.toBeInTheDocument();
  expect(screen.queryByText('PROPOSAL')).not.toBeInTheDocument();
  expect(screen.queryByText(/proposed/i)).not.toBeInTheDocument();
}

beforeEach(() => { vi.clearAllMocks(); });

describe('when this build has no program id', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-program-id' }); });

  it('says the page has no id to read, and names the SPENT id it never reads', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/has no program id to read/i)).toBeInTheDocument());
    expect(screen.getByText(/permanently spent/i)).toBeInTheDocument();
    expect(screen.getByText('Spent id')).toBeInTheDocument();
  });

  it('does not say the AMM is being redeployed: that is a claim about the chain it never read', async () => {
    await mount();
    await settled();
    expect(screen.queryByText(/being redeployed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/once its program is redeployed/i)).not.toBeInTheDocument();
  });

  it('shows no fee numbers, because none were read', async () => {
    await mount();
    await settled();
    expectNoFeeNumbers();
    expect(screen.getByText(/no fee tier was read/i)).toBeInTheDocument();
  });

  it('never claims in the present tense that a pool can be opened', async () => {
    // The regression this pins: the hero asserted "anyone can open a pool" above
    // a status card that said the venue was not there, so a reader met the
    // capability claim before the correction.
    await mount();
    await settled();
    expect(screen.queryByText(/anyone can open a pool/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no pool can be opened here yet/i)).toBeInTheDocument();
  });
});

describe('when the program is live but has no AmmConfig', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'no-config', programId: PROGRAM }); });

  it('calls it one instruction from open, NOT "coming soon"', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/one instruction from open/i)).toBeInTheDocument());
  });

  it('names the missing instruction without proposing rates for it', async () => {
    await mount();
    await settled();
    expect(screen.queryByText(/create_amm_config\(/)).not.toBeInTheDocument();
    expect(screen.queryByText(/120000|40000|150000000/)).not.toBeInTheDocument();
    expectNoFeeNumbers();
    expect(screen.getByText(/create_amm_config/)).toBeInTheDocument();
  });
});

describe('when the venue is live', () => {
  beforeEach(() => { readVenue.mockResolvedValue(LIVE); });

  it('restores the present-tense capability claim only when the probe says live', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    // Twice: once in the hero, once in the live status card.
    expect(screen.getAllByText(/anyone can open a pool/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no pool can be opened here yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/How it works:/i)).not.toBeInTheDocument();
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

  // The page also offers "Open a pool" on the public tier, which charges its own fee. This card
  // reads the graduation tier only, so it must say which tier it is, or its "Open a pool" figure
  // reads as the price of opening a pool here.
  it('names the tier it reads, and says pools opened here use the public tier', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    const sheet = screen.getByRole('region', { name: 'Fee sheet' });
    expect(sheet).toHaveTextContent(/tier 0, graduated launch pools/);
    expect(sheet).toHaveTextContent(/fee on tier 0/);
    expect(sheet).toHaveTextContent(/Pools opened from this site use the public fee tier/);
  });
});

describe('when the chain cannot be read', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'proxy timed out' }); });

  it('says plainly that the fee tiers could not be read just now', async () => {
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/fee tiers could not be read just now/i)).toBeInTheDocument());
    expect(screen.getByText(/outage on our side/i)).toBeInTheDocument();
  });

  it('shows no fee numbers, and no guess at them', async () => {
    // The bug this pins: a failed read fell back to an old proposal and printed
    // its rates as what the venue "will" charge, while mainnet charged others.
    await mount();
    await settled();
    expectNoFeeNumbers();
  });

  it('says nothing about the venue that the failed read did not return', async () => {
    await mount();
    await settled();
    expect(screen.queryByText(/being redeployed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/once its program is redeployed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no trade on chain is paying/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no pool to\s+deposit into today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/redeployed program will run/i)).not.toBeInTheDocument();
  });

  it('reads again on "Try again", and shows the fees once the chain answers', async () => {
    readVenue
      .mockResolvedValueOnce({ kind: 'unreadable', detail: 'proxy timed out' })
      .mockResolvedValueOnce(LIVE);
    await mount();
    const retry = await screen.findByRole('button', { name: /try again/i });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('0.3%')).toBeInTheDocument());
    expect(readVenue).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/could not be read just now/i)).not.toBeInTheDocument();
  });
});

describe('while the first read is in flight', () => {
  beforeEach(() => { readVenue.mockReturnValue(new Promise(() => {})); });

  it('shows no fee numbers until the chain answers', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Reading the venue/i)).toBeInTheDocument());
    expectNoFeeNumbers();
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
    await waitFor(() => expect(screen.getByText(/has no program id to read/i)).toBeInTheDocument());
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
