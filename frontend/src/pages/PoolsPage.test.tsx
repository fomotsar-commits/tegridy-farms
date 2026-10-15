import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RECORDING, recordedTier } from '../lib/solana/cpswap/mainnetVenueReplay.fixture';

/**
 * `/pools` answers "can this venue host liquidity pools?" from a LIVE CHAIN PROBE, never
 * from copy. These tests keep its states apart, and hold that a fee is shown only when
 * the chain returned it: a failed or pending read shows no number at all.
 */

const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}), browserRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
// The LP section has its own tests (components/solana/lp), its Rates and Swap routes cards
// included; here only WHEN and WHERE it mounts matters.
vi.mock('../components/solana/lp/SolanaLpSection', () => ({
  default: () => <div data-testid="lp-section" />,
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
  // The public tier, read in the same pass: rates apart from the launch tier's, so each figure is found once.
  publicTier: {
    kind: 'ok',
    config: {
      address: 'CfG2222222222222222222222222222222222222222',
      index: 1, disableCreatePool: false,
      tradeFeeRate: 20_000n, protocolFeeRate: 100_000n, fundFeeRate: 0n,
      createPoolFee: 120_000_000n, creatorFeeRate: 0n,
      protocolOwner: 'Own1', fundOwner: 'Own2',
    },
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

  // Owner, 2026-10-14: the actions first. Nothing stands between the hero and the section;
  // the status card follows it, after what holding a share means.
  it('puts the LP section right under the hero, and the status card after it', async () => {
    await mount();
    const section = await screen.findByTestId('lp-section');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.parentElement!.nextElementSibling).toContainElement(section);
    const card = screen.getByRole('region', { name: 'Venue status' });
    expect(section.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // `relative isolate` is what its CardArt layer needs, on both tabs.
    expect(card.className).toBe('relative isolate rounded-2xl p-6');
  });

  // Owner, 2026-10-14: "drop the duplicate fee cards". The section's Rates card is the one
  // place a rate is printed, from its own read, so no second figure can disagree with it.
  it('drops the PROPOSAL badge, and prints no fee card or figure of its own', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.queryByText('PROPOSAL')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Fee sheet' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%/);
    // The live card no longer points at a fee sheet below it.
    expect(screen.getByRole('region', { name: 'Venue status' })).not.toHaveTextContent(/Fees below are read from that config\./);
  });

  it('says it in prose with no em dash', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('—');
  });
});

// Tier 0 exactly as mainnet returned it (scripts/record-pools-venue-fixture.mjs): 0.25% trade
// fee, 20% of it to the venue, and a 0.05% creator fee that the program charges on top in
// every pool the launch program opens. The sheet is about those pools, so a trade on one
// costs 0.3%, and the creator's part is its own line.
describe('on tier 0 as mainnet holds it (recorded)', () => {
  beforeEach(() => {
    readVenue.mockResolvedValue({ kind: 'live', programId: RECORDING.program, config: recordedTier(0), publicTier: { kind: 'ok', config: recordedTier(1) } });
  });

  it('says anyone can open a pool, which tier 0 allows', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(recordedTier(0).disableCreatePool).toBe(false);
    expect(screen.getByRole('region', { name: 'Venue status' })).toHaveTextContent(/anyone can open a pool and provide\s+liquidity on chain/);
  });
});

// The rates are the LP section's own read (both tiers), so the venue read asks for the venue alone.
describe('the venue read asks for the venue alone', () => {
  it('one read, and no public tier asked of it', async () => {
    readVenue.mockResolvedValue({ kind: 'live', programId: RECORDING.program, config: recordedTier(0), publicTier: { kind: 'not-asked' } });
    await mount();
    await waitFor(() => expect(readVenue).toHaveBeenCalled());
    expect(readVenue).toHaveBeenCalledTimes(1);
    expect(readVenue.mock.calls[0]![3]).toEqual({ publicTier: false });
  });
});

// "Anyone can open a pool" is a claim about the tier the page read: with opening switched
// off there, it must not be made.
describe('when the tier it reads is closed to new pools', () => {
  beforeEach(() => {
    readVenue.mockResolvedValue({ kind: 'live', programId: RECORDING.program, config: { ...recordedTier(0), disableCreatePool: true }, publicTier: { kind: 'ok', config: recordedTier(1) } });
  });

  it('never says anyone can open a pool, and says opening is switched off', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.queryByText(/anyone can open a pool/i)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Venue status' })).toHaveTextContent(/opening new pools on fee tier 0 is switched off/i);
  });

});

describe('when the chain cannot be read', () => {
  beforeEach(() => { readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'proxy timed out' }); });

  it('says plainly that the chain could not be read, and that it is an outage', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/The chain could not be read/i)).toBeInTheDocument());
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

  it('reads again on Refresh, and mounts the actions once the chain answers', async () => {
    readVenue
      .mockResolvedValueOnce({ kind: 'unreadable', detail: 'proxy timed out' })
      .mockResolvedValueOnce(LIVE);
    await mount();
    await screen.findByText(/outage on our side/i);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTestId('lp-section')).toBeInTheDocument();
    expect(readVenue).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/outage on our side/i)).not.toBeInTheDocument();
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

  // Where a swap goes is the LP section's Swap routes card (its own tests); this page says what the AMM is.
  it('says the AMM is Raydium with one added instruction', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/one added instruction/i)).toBeInTheDocument());
    expect(screen.queryByText(/still goes through\s+Jupiter|sending it to our pool/i)).toBeNull();
    expect(screen.queryByText(/verbatim fork/i)).toBeNull();
  });

  // The team's vault can switch withdrawals off on any pool (update_pool_status, admin only),
  // so the page may not promise a removal "any time"; it says the pause on screen instead.
  it('never promises withdrawing any time, and says on screen that the vault can pause removing', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/can pause removing/i)).toBeVisible());
    expect(document.body.textContent).not.toMatch(/withdraw any ?time/i);
    expect(screen.getByText(/can switch removing off on a pool/i)).toBeInTheDocument();
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
    const status = screen.getByRole('region', { name: 'Venue status' });
    expect(status.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      publicTier: LIVE.publicTier,
    });
  beforeEach(() => { lp.mode = 'off'; live(); });

  it("'off': reads only, and says adding and removing are not switched on", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.getByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeInTheDocument();
    expect(screen.getByText(/This site only reads pools so far\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Find a pool on the Solana LP tab' })).toHaveAttribute('href', '/solana-lp');
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
      screen.getByText(/This site can add and remove liquidity, and open new pools on the public fee tier \(the pools section above says whether it can right now\)\./),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/once (the public fee tier|that tier) exists/i);
    expect(screen.getByRole('link', { name: 'Add or remove liquidity on the Solana LP tab' })).toHaveAttribute('href', '/solana-lp');
    expect(screen.queryByText(/does not open pools/i)).toBeNull();
    // The swap's routing card has no switch of its own to speak of; this is the LP one.
    expect(screen.queryByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeNull();
    expect(screen.queryByText(/only reads pools so far/i)).toBeNull();
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
