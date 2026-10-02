import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * `/pools` answers "can this venue host liquidity pools?" from a LIVE CHAIN PROBE, never
 * from copy. These tests keep its states apart, and hold that a fee is shown only when
 * the chain returned it: a failed or pending read shows no number at all.
 */

const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
// The LP section has its own tests (components/solana/lp); here only WHEN it mounts matters.
vi.mock('../components/solana/lp/SolanaLpSection', () => ({ default: () => <div data-testid="lp-section" /> }));

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
