import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RECORDING, recordedTier } from '../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { BUNGALOWS } from '../lib/bungalows';

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
vi.mock('../components/solana/lp/SolanaLpSection', async () => {
  const { useLayoutEffect } = await import('react');
  // The real section claims the door's place when it mounts and draws its own door there.
  function Section({ door }: { door?: { claim(): void } }) {
    useLayoutEffect(() => door?.claim(), [door]);
    return <div data-testid="lp-section" />;
  }
  return { default: Section };
});
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

// jsdom has no scrollIntoView. The page calls it on the status card, so this is the record.
const scrolled = vi.fn();
const proto = Element.prototype as { scrollIntoView?: unknown };
beforeAll(() => { proto.scrollIntoView = scrolled; });
afterAll(() => { delete proto.scrollIntoView; });

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
    // `relative isolate` is what its CardArt layer needs; `scroll-mt-5` is the air above it when a
    // failed Refresh scrolls it back into view (e2e measures where, under the tab strip).
    expect(card.className).toBe('relative isolate rounded-2xl p-6 scroll-mt-5');
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

  // Owner, 2026-10-13: as few words as possible. The hero's eyebrow and its Details drop-down said what the
  // tab strip, the Rates card and the status card say; "Nothing to claim." is the section's own first line.
  it('says each thing once: no eyebrow, no hero Details, and the share card leaves "Nothing to claim" to the earn line', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    const hero = screen.getByRole('heading', { level: 1 }).parentElement!;
    expect(hero).not.toHaveTextContent('Venue AMM · Solana');
    expect(hero.querySelector('details')).toBeNull();
    expect(within(hero).queryByText('Details')).toBeNull();
    const share = screen.getByRole('heading', { level: 2, name: 'Deposit a pair, hold your share' }).parentElement!;
    expect(share).toHaveTextContent("No lock, but the team's vault can pause removing.");
    expect(within(share).queryByText(/^Nothing to claim\./)).toBeNull();
    // The section's own first line says it (SolanaLpSection.test.tsx pins "Fees grow your pool shares. Nothing to claim.").
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

  // Island, answer twenty-two: a slow phone showed "No pool can be opened here yet" for seconds
  // while eight pools were open. Until the read lands the hero says nothing at all.
  it('says nothing about pools in the hero until the chain answers', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText(/Reading the venue/i)).toBeInTheDocument());
    expect(screen.queryByText(/No pool can be opened here yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add two coins/i)).not.toBeInTheDocument();
  });
});

describe('the hero line follows only what a read returned', () => {
  it('a failed read does not say no pool can be opened', async () => {
    readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'proxy timed out' });
    await mount();
    await settled();
    expect(screen.queryByText(/No pool can be opened here yet/i)).not.toBeInTheDocument();
  });

  it.each([
    ['no program id', { kind: 'no-program-id' }],
    ['a live program with no fee config', { kind: 'no-config', programId: PROGRAM }],
  ])('%s: says no pool can be opened, which that read returned', async (_name, read) => {
    readVenue.mockResolvedValue(read);
    await mount();
    await settled();
    expect(screen.getByText(/No pool can be opened here yet/i)).toBeInTheDocument();
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

  // The Solana LP tab was this page's LP section on a page of its own (owner, 2026-10-24:
  // "remove solana lp keep venue amm"): nothing here sends a reader to it, and the hero is words only.
  it('links nowhere to the Solana LP tab, which this page replaced, in any LP mode', async () => {
    for (const mode of ['on', 'withdraw-only', 'off'] as const) {
      lp.mode = mode;
      const view = await mount();
      await settled();
      expect(screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/solana-lp'))).toEqual([]);
      expect(screen.queryByText(/Solana LP tab/)).toBeNull();
      expect(within(screen.getByRole('heading', { level: 1 }).parentElement!).queryByRole('link')).toBeNull();
      view.unmount();
    }
    lp.mode = 'off';
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
    // The status card's line is the one place this page says it (the hero's Details went on 2026-10-30).
    expect(screen.getByText(/This site only reads pools so far\./)).toBeInTheDocument();
  });

  it("'on': says what the section below can do, and never that it is not switched on", async () => {
    lp.mode = 'on';
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    // SPEC_S2_CREATE 2.6 (K4): opening a pool joins the 'on' copy. Whether the public tier
    // exists is said only by the create card's live read, never by this fixed copy (B review parity-3).
    expect(
      screen.getByText(/This site can add and remove liquidity, and open new pools on the public fee tier \(the pools section above says whether it can right now\)\./),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/once (the public fee tier|that tier) exists/i);
    expect(screen.queryByText(/does not open pools/i)).toBeNull();
    // The swap's routing card has no switch of its own to speak of; this is the LP one.
    expect(screen.queryByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeNull();
    expect(screen.queryByText(/only reads pools so far/i)).toBeNull();
  });

  it("'withdraw-only': adding is paused, taking liquidity out still works", async () => {
    lp.mode = 'withdraw-only';
    await mount();
    await waitFor(() => expect(screen.getByText(/Pools are open/i)).toBeInTheDocument());
    expect(screen.getByText(/This site can take liquidity out; adding liquidity and opening pools are paused\./)).toBeInTheDocument();
    expect(screen.queryByText(/adding and removing\s+liquidity from here is not switched on yet/i)).toBeNull();
  });
});

// Carried over from the Solana LP tab, which put the LP section above the same card.
describe('Refresh on a live venue', () => {
  const UNREADABLE = { kind: 'unreadable', detail: 'proxy timed out' } as const;

  it('keeps the LP section mounted while it reads again', async () => {
    readVenue.mockResolvedValueOnce(LIVE).mockReturnValueOnce(new Promise(() => {}));
    await mount();
    await screen.findByTestId('lp-section');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readVenue).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('lp-section')).toBeInTheDocument();
    expect(screen.queryByText(/Reading the venue/i)).toBeNull();
  });

  // One card, live or not: a failed re-read changes what it says, not which button was pressed.
  it('a re-read that fails keeps keyboard focus on that same Refresh', async () => {
    readVenue.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(UNREADABLE);
    await mount();
    await screen.findByTestId('lp-section');
    const pressed = screen.getByRole('button', { name: 'Refresh' });
    pressed.focus();
    fireEvent.click(pressed);
    await screen.findByText(/The chain could not be read/i);
    expect(screen.queryByTestId('lp-section')).toBeNull();
    expect(document.activeElement).toBe(pressed);
    expect(within(screen.getByRole('region', { name: 'Venue status' })).getByRole('button', { name: 'Refresh' })).toBe(pressed);
  });

  // The section above the card goes away, so the card jumps up the page under the reader.
  it('a re-read that fails brings the card back into view; one that reads live does not scroll', async () => {
    let answer!: (v: unknown) => void;
    readVenue.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(LIVE).mockReturnValueOnce(new Promise((r) => { answer = r; }));
    await mount();
    await screen.findByTestId('lp-section');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readVenue).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readVenue).toHaveBeenCalledTimes(3));
    expect(scrolled).not.toHaveBeenCalled();
    answer(UNREADABLE);
    await screen.findByText(/The chain could not be read/i);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(screen.getByRole('region', { name: 'Venue status' }));
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

// Island, answer twenty-two ("where the door lands"): a room's Add SOL + coin opens its form at
// the top of the page. Its place is held from the first frame, before the venue read and the
// LP section's chunk, so nothing the page draws later lands above it.
describe('the LP door', () => {
  const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
  const DOOR = `/pools?mint=${bayla.address}&task=add&pool=${bayla.venueSolPool}`;
  beforeEach(() => { lp.mode = 'on'; });
  afterEach(() => { lp.mode = 'off'; });

  it('holds the top of the page from the first frame, named for the room, while the venue is read', async () => {
    readVenue.mockReturnValue(new Promise(() => {}));
    await mount(DOOR);
    const door = screen.getByTestId('lp-door');
    expect(within(door).getByRole('heading', { name: bayla.name })).toBeInTheDocument();
    expect(within(door).getByRole('status')).toHaveTextContent('Reading this pool from the chain…');
    expect(door.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hands its place to the LP section once that mounts', async () => {
    readVenue.mockResolvedValue(LIVE);
    await mount(DOOR);
    await screen.findByTestId('lp-section');
    expect(screen.queryByTestId('lp-door')).toBeNull();
  });

  it('a venue that does not read live takes it away', async () => {
    readVenue.mockResolvedValue({ kind: 'unreadable', detail: 'proxy timed out' });
    await mount(DOOR);
    await settled();
    expect(screen.queryByTestId('lp-door')).toBeNull();
  });

  it('is not drawn without task=add, or with adding switched off', async () => {
    readVenue.mockReturnValue(new Promise(() => {}));
    await mount(`/pools?mint=${bayla.address}`);
    expect(screen.queryByTestId('lp-door')).toBeNull();
    lp.mode = 'off';
    await mount(DOOR);
    expect(screen.queryByTestId('lp-door')).toBeNull();
  });
});
