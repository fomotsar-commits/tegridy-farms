import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RECORDING, recordedTier } from '../lib/solana/cpswap/mainnetVenueReplay.fixture';

/**
 * `/pools` answers "can this venue host liquidity pools?" from a LIVE CHAIN PROBE, never
 * from copy. These tests keep its states apart, and hold that a fee is shown only when
 * the chain returned it: a failed or pending read shows no number at all.
 */

const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
// The LP section has its own tests (components/solana/lp); here only WHEN it mounts matters,
// and that this tab asks for the section's own order, never the Solana LP tab's finder-first.
vi.mock('../components/solana/lp/SolanaLpSection', () => ({
  default: ({ finderFirst = false }: { finderFirst?: boolean }) => <div data-testid="lp-section" data-finder-first={String(finderFirst)} />,
}));
// LP's own switch, steerable per test (spec addendum D24): the page's words about what this
// site can do with the pools follow it. Every other test sees 'off' (the reads-only page),
// whatever is committed; the committed value is pinned in lpWriteFlag.test.ts.
const lp = vi.hoisted(() => ({ mode: 'off' as 'off' | 'on' | 'withdraw-only' }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => lp.mode,
}));

const PROGRAM = '3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y';
/** The routing card's sentence: where the swap sends a trade. */
const SWAP_ROUTES = /to\s+our pool when ours pays at least as much as Jupiter, and through Jupiter\s+when it does not\./i;

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

// The page's module graph is loaded once here, outside any test's own clock: mount() then
// re-runs modules that are already transformed, so a busy machine cannot time the first test out.
beforeAll(async () => { await import('./PoolsPage'); }, 60_000);

async function mount(path = '/pools') {
  vi.resetModules();
  const { default: PoolsPage } = await import('./PoolsPage');
  return render(<MemoryRouter initialEntries={[path]}><PoolsPage /></MemoryRouter>);
}

// A real mint (32 bytes of base58), for the ?mint= the hero's link carries.
const M = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
/** The hero's door to the Solana LP tab: the one link on the page that goes there. */
function solanaLpLink() {
  const links = screen.getAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/solana-lp'));
  expect(links).toHaveLength(1);
  return links[0]!;
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

  it('keeps the status card above the LP section, and the section in its own order', async () => {
    await mount();
    const section = await screen.findByTestId('lp-section');
    expect(section).toHaveAttribute('data-finder-first', 'false');
    const card = screen.getByRole('region', { name: 'Venue status' });
    expect(section.previousElementSibling).toBe(card);
    // The card is this tab's own: nothing the Solana LP tab asks of it (a scroll margin) is on it.
    expect(card.className).toBe('rounded-2xl p-6');
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
    expect(screen.getByText(/read from the chain when this page loads/i)).toBeInTheDocument();
    // The live card points at the fee sheet, which this tab has.
    expect(screen.getByRole('region', { name: 'Venue status' })).toHaveTextContent(/Fees below are read from that config\./);
  });

  it('says it in prose with no em dash', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Fee sheet' }).textContent).not.toContain('—');
    expect(screen.getByRole('region', { name: 'Venue status' }).textContent).not.toContain('—');
  });

  it('a tier that charges no creator fee shows no creator line', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    const sheet = screen.getByRole('region', { name: 'Fee sheet' });
    expect(sheet).not.toHaveTextContent(/creator/i);
  });
});

// Tier 0 exactly as mainnet returned it (scripts/record-pools-venue-fixture.mjs): 0.25% trade
// fee, 20% of it to the venue, and a 0.05% creator fee that the program charges on top in
// every pool the launch program opens. The sheet is about those pools, so a trade on one
// costs 0.3%, and the creator's part is its own line.
describe('on tier 0 as mainnet holds it (recorded)', () => {
  beforeEach(() => {
    readVenue.mockResolvedValue({ kind: 'live', programId: RECORDING.program, config: recordedTier(0) });
  });

  it('says a trade on a launch pool costs 0.3%, never the 0.25% trade fee alone', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    const sheet = screen.getByRole('region', { name: 'Fee sheet' });
    const stat = (label: string) => within(sheet).getByText(label).nextElementSibling?.textContent;
    expect(stat('Trader pays')).toBe('0.3%');
    expect(within(sheet).getByRole('heading', { level: 2 })).toHaveTextContent('0.3% a trade, 0.20% of it to you');
    expect(sheet).toHaveTextContent('0.25% trade fee + 0.05% creator fee');
    expect(sheet).not.toHaveTextContent(/0\.25% a trade/);
  });

  it('shows the creator fee as its own line, and who gets it', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    const sheet = screen.getByRole('region', { name: 'Fee sheet' });
    const creator = within(sheet).getByText('Creator gets');
    expect(creator.nextElementSibling?.textContent).toBe('0.05%');
    expect(creator.parentElement).toHaveTextContent(/to the token.s creator/);
    // LPs and the venue split the trade fee; the creator's part is on top of it.
    expect(within(sheet).getByText('LPs keep').nextElementSibling?.textContent).toBe('0.20%');
    expect(within(sheet).getByText('Venue takes').nextElementSibling?.textContent).toBe('0.05%');
    expect(sheet).toHaveTextContent(/20% of the trade fee/);
    expect(sheet).toHaveTextContent(/the launch program opens every launch pool with it switched on/);
    expect(sheet).toHaveTextContent(/A pool opened on this tier any other way charges only the trade fee/);
  });

  it('says anyone can open a pool, which tier 0 allows', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(recordedTier(0).disableCreatePool).toBe(false);
    expect(screen.getByRole('region', { name: 'Venue status' })).toHaveTextContent(/anyone can open a pool and provide\s+liquidity on chain/);
  });
});

// "Anyone can open a pool" is a claim about the tier the page read: with opening switched
// off there, it must not be made.
describe('when the tier it reads is closed to new pools', () => {
  beforeEach(() => {
    readVenue.mockResolvedValue({ kind: 'live', programId: RECORDING.program, config: { ...recordedTier(0), disableCreatePool: true } });
  });

  it('never says anyone can open a pool, and says opening is switched off', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.queryByText(/anyone can open a pool/i)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Venue status' })).toHaveTextContent(/opening new pools on fee tier 0 is switched off/i);
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

  // The card says what the swap DOES. While every Solana swap executed through Jupiter it
  // had to say so (review 2026-09-30); the swap now sends each trade where it pays more.
  it('says the swap compares our pools and sends the trade where it pays more, and that the AMM is Raydium with one added instruction', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/side by side with Jupiter/i)).toBeInTheDocument());
    expect(screen.getByText(SWAP_ROUTES)).toBeInTheDocument();
    expect(screen.queryByText(/still goes through\s+Jupiter|sending it to our pool/i)).toBeNull();
    expect(screen.getByText(/one added instruction/i)).toBeInTheDocument();
    expect(screen.queryByText(/verbatim fork/i)).toBeNull();
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
    // The section is lazy: its loading line is on screen first, so that counts as mounting.
    expect(screen.queryByText(/Loading the pool finder/)).toBeNull();
  });

  // The hero says "No pool can be opened here yet" until the read says live, so the link
  // under it may not say what can be done on that tab, in any LP mode.
  it('links from the hero to the Solana LP tab, claiming nothing while the venue is not live', async () => {
    for (const mode of ['on', 'withdraw-only', 'off'] as const) {
      lp.mode = mode;
      const view = await mount();
      await settled();
      expect(solanaLpLink()).toHaveAttribute('href', '/solana-lp');
      expect(solanaLpLink()).toHaveTextContent(/^Go to the Solana LP tab$/);
      view.unmount();
    }
    lp.mode = 'off';
  });

  it('the link claims nothing while the first read is still in flight', async () => {
    lp.mode = 'on';
    readVenue.mockReturnValue(new Promise(() => {}));
    await mount();
    await waitFor(() => expect(screen.getByText(/Reading the venue/i)).toBeInTheDocument());
    expect(solanaLpLink()).toHaveTextContent(/^Go to the Solana LP tab$/);
    lp.mode = 'off';
  });

  it('the link carries the token being looked at, and nothing else from the URL', async () => {
    const first = await mount(`/pools?mint=${M}&amount=5`);
    await settled();
    expect(solanaLpLink()).toHaveAttribute('href', `/solana-lp?mint=${M}`);
    first.unmount();
    await mount('/pools?mint=not%20a%20mint%3Cb%3E&amount=5');
    await settled();
    expect(solanaLpLink()).toHaveAttribute('href', '/solana-lp');
  });

  it('keeps "The program" as its last section, where the LP disclosure says it is', async () => {
    await mount();
    await settled();
    const program = screen.getByRole('region', { name: 'The program' });
    expect(program).toHaveTextContent(/one added instruction/i);
    // Calling the added instruction is not free (the record's rent and Metaplex's fee), so the
    // card says who pays, and never that it takes nothing or moves no funds.
    expect(program).toHaveTextContent(/It cannot move pool funds\. Whoever calls it pays a small one-time fee for the record\./);
    expect(program).not.toHaveTextContent(/takes nothing from its caller|moves no funds/i);
    expect(program).toHaveTextContent(/A browser cannot list pools itself/i);
    const sheet = screen.getByRole('region', { name: 'Fee sheet' });
    expect(sheet.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(screen.getByRole('link', { name: 'Find a pool on the Solana LP tab' })).toHaveAttribute('href', '/solana-lp');
    expect(screen.getByText(SWAP_ROUTES)).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: 'Add or remove liquidity on the Solana LP tab' })).toHaveAttribute('href', '/solana-lp');
    expect(screen.queryByText(/does not open pools/i)).toBeNull();
    // The swap's routing card has no switch of its own to speak of; this is the LP one.
    expect(screen.queryByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeNull();
    expect(screen.queryByText(/only reads pools so far/i)).toBeNull();
    // The swap's own routing is a different matter, and reads the same in every LP mode.
    expect(screen.getByText(SWAP_ROUTES)).toBeInTheDocument();
  });

  it("'withdraw-only': adding is paused, taking liquidity out still works", async () => {
    lp.mode = 'withdraw-only';
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.getByText(/Adding liquidity and opening pools from here are paused; taking yours out still works\./)).toBeInTheDocument();
    expect(screen.getByText(/This site can take liquidity out; adding liquidity and opening pools are paused\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Take your liquidity out on the Solana LP tab' })).toHaveAttribute('href', '/solana-lp');
    expect(screen.queryByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeNull();
  });
});
