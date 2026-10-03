// The owner on a phone, 2026-10-03, three times: "its not available on mobile and ipads",
// "theres no way to add to the lp on the mobile solana lp tab", then, after two fixes that
// were not fixes, "there is still no way to. wtf" and "theres no way to create pools on
// mobile either".
//
// What the phone showed (production, 390x664): a heading, a paragraph, a warning and an
// EMPTY box asking for a 44-character token address. No Create, Add or Remove button
// anywhere on the page until an address was pasted, and a phone has no address to paste.
// After a lookup the "Open a pool" button sat a screen and a half down, and the form it
// opened began with two screens of notes before its first amount box.
//
// So, pinned here:
//   1. Create a pool, Add liquidity and Remove liquidity are buttons on the finder card.
//   2. The tokens with a room on this site are picked by a press, by address, in any room.
//   3. A lookup asked for that way ENDS in a form: the panel opens by itself, once.
//   4. Remove liquidity goes to the positions, which say what an empty list means.
//   5. The form starts with the wallet and the amount boxes; the long notes follow it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import { key } from '../../../lib/solana/lp/testkit.fixture';
import { BUNGALOWS, BUNGALOW_STORAGE_KEY } from '../../../lib/bungalows';
import { TIER1_ADDRESS, fakeLpApi, readyFacts, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { recordedFeeTiers } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
// The public tier's address is the fixture's, as in CreatePoolPanel.test.tsx.
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

// The site's own Solana tokens, from the registry the buttons are built from.
const SITE = BUNGALOWS.flatMap((b) => (b.chain === 'solana' && b.address ? [{ id: b.id, symbol: b.symbol, mint: b.address }] : []));
const bayla = SITE.find((t) => t.id === 'bayla');
if (!bayla) throw new Error('the BAYLA room has no mint');
const BAYLA = bayla.mint;
const OTHER = key().toBase58();

const token = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'BAYLA', symbol: 'BAYLA', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});
const noPools = (mint: string): PoolSearchRead => ({
  kind: 'ok',
  search: {
    mint,
    known: { launchPool: key().toBase58(), standard: [{ index: 1, config: TIER1_ADDRESS.toBase58(), address: key().toBase58() }] },
    index: { kind: 'ok', pools: [], truncated: false },
    pools: [],
    otherPairs: 0,
    knownState: {},
    chainNow: 1_000n,
  },
});

function readers(): LpReaders {
  return {
    programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, token(m)]))),
    findPools: vi.fn(async (mint: PublicKey) => noPools(mint.toBase58())),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.000005, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => recordedFeeTiers()),
    wallet: vi.fn(async () => { throw new Error('not read in these tests'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not read in these tests'); }),
  };
}

function mount(path = '/solana-lp', mode: LpWritesOverrides['mode'] = 'on') {
  const r = readers();
  const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()) });
  render(
    <MemoryRouter initialEntries={[path]}>
      <LpInner readers={r} writes={{ mode, load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
  return r;
}

const scrolled = vi.fn();
/** What was scrolled to, in order. */
const scrolledTo = () => scrolled.mock.contexts as Element[];
const finder = () => screen.findByTestId('lp-finder');
const task = async (name: string) => within(await finder()).getByRole('button', { name });
const chip = async (symbol: string) => within(within(await finder()).getByTestId('lp-site-tokens')).getByRole('button', { name: symbol });

beforeEach(() => {
  wallet.publicKey = null;
  scrolled.mockClear();
  Element.prototype.scrollIntoView = scrolled;
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});
afterEach(() => {
  cleanup();
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe('what a visitor can do is on the first card, as buttons', () => {
  it('Create a pool, Add liquidity and Remove liquidity, before anything is looked up', async () => {
    mount();
    const tasks = within(await finder()).getByTestId('lp-tasks');
    expect(within(tasks).getAllByRole('button').map((b) => b.textContent)).toEqual(['Create a pool', 'Add liquidity', 'Remove liquidity']);
    // Nothing is chosen for them, and the card is named for what it does.
    for (const b of within(tasks).getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false');
    expect(await finder()).toHaveTextContent('Create a pool, add or remove liquidity');
    // No helper line until one is pressed: on a phone it would push the tokens off the first screen.
    expect(within(tasks).getByTestId('lp-task-line')).toBeEmptyDOMElement();
    expect(within(await finder()).getByTestId('lp-site-tokens')).toHaveTextContent('Then pick a token with a room on this site');
  });

  it('a pressed one says what happens next', async () => {
    mount();
    fireEvent.click(await task('Create a pool'));
    expect(await task('Create a pool')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('lp-task-line')).toHaveTextContent('Pick the token to open a pool for.');
    fireEvent.click(await task('Add liquidity'));
    expect(await task('Create a pool')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('lp-task-line')).toHaveTextContent('If it has no pool yet, your deposit opens one.');
  });

  it('with adding paused, only Remove is offered and the card says so', async () => {
    mount('/solana-lp', 'withdraw-only');
    const tasks = within(await finder()).getByTestId('lp-tasks');
    expect(within(tasks).getAllByRole('button').map((b) => b.textContent)).toEqual(['Remove liquidity']);
    expect(tasks).toHaveTextContent('Adding liquidity and opening pools from this site are paused right now. Removing still works.');
  });

  it('with liquidity switched off, the card is only a finder', async () => {
    mount('/solana-lp', 'off');
    const f = await finder();
    expect(within(f).queryByTestId('lp-tasks')).toBeNull();
    expect(f).toHaveTextContent('Find pools for a token');
    // The site's tokens are still a press away: looking a token up signs nothing.
    expect(within(f).getByTestId('lp-site-tokens')).toBeTruthy();
  });
});

describe("the site's own tokens are picked by a press, in any room", () => {
  it('lists every Solana token with a room here, with no room chosen', async () => {
    expect(SITE.length).toBeGreaterThan(1);
    mount();
    const chips = within(await finder()).getByTestId('lp-site-tokens');
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(SITE.map((t) => t.symbol));
    expect(chips).toHaveTextContent('looked up by its address from this site’s own list, not by its name');
  });

  it("puts the visitor's own room first, and offers no token that is not on Solana", async () => {
    const last = SITE[SITE.length - 1]!;
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, last.id);
    mount();
    const names = within(within(await finder()).getByTestId('lp-site-tokens')).getAllByRole('button').map((b) => b.textContent);
    expect(names[0]).toBe(last.symbol);
    expect(names).toHaveLength(SITE.length);
    expect(names).not.toContain('TOWELI');
  });

  it('a press looks the token up by its address, and the address goes into the box to be checked', async () => {
    const r = mount();
    fireEvent.click(await chip('BAYLA'));
    await waitFor(() => expect(r.findPools).toHaveBeenCalled());
    expect((r.findPools as ReturnType<typeof vi.fn>).mock.calls[0]![0].toBase58()).toBe(BAYLA);
    expect(within(await finder()).getByLabelText('Token mint address')).toHaveValue(BAYLA);
    expect(await screen.findByTestId('token-safety')).toHaveTextContent(BAYLA);
    expect(await chip('BAYLA')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('a lookup asked for with a button ends in a form', () => {
  it('Create a pool, then a token: the form opens by itself, at the top of the screen', async () => {
    mount();
    fireEvent.click(await task('Create a pool'));
    fireEvent.click(await chip('BAYLA'));
    const panel = await screen.findByTestId('lp-create-panel');
    // Nobody pressed Open a pool: the card's own button is still there, and now says it is open.
    expect(within(screen.getByTestId('lp-create')).getByRole('button', { name: 'Open a pool' })).toHaveAttribute('aria-expanded', 'true');
    // The panel's heading is what the page ends on, at the top of the screen.
    const heading = within(panel).getByRole('heading', { name: 'Open a pool for this token' });
    await waitFor(() => expect(scrolledTo()[scrolledTo().length - 1]).toBe(heading));
    expect(scrolled.mock.calls[scrolled.mock.calls.length - 1]![0]).toEqual({ block: 'start' });
  });

  it('Add liquidity on a token with no pool: the form that opens the pool, because that is how the first liquidity goes in', async () => {
    mount();
    fireEvent.click(await task('Add liquidity'));
    fireEvent.click(await chip('BAYLA'));
    expect(await screen.findByTestId('lp-create-panel')).toBeTruthy();
    expect(screen.getByTestId('lp-create')).toHaveTextContent('There is no pool to add liquidity to yet. Opening one is how the first liquidity goes in.');
  });

  it('a token pressed with nothing chosen still ends in a form', async () => {
    mount();
    fireEvent.click(await chip('BAYLA'));
    expect(await screen.findByTestId('lp-create-panel')).toBeTruthy();
  });

  it('a typed address goes to the chosen form too', async () => {
    mount();
    fireEvent.click(await task('Create a pool'));
    fireEvent.change(within(await finder()).getByLabelText('Token mint address'), { target: { value: OTHER } });
    fireEvent.click(within(await finder()).getByRole('button', { name: 'Find pools' }));
    expect(await screen.findByTestId('lp-create-panel')).toHaveTextContent(OTHER);
  });

  it('a typed address with nothing chosen opens nothing: the cards and their buttons, as before', async () => {
    mount();
    fireEvent.change(within(await finder()).getByLabelText('Token mint address'), { target: { value: OTHER } });
    fireEvent.click(within(await finder()).getByRole('button', { name: 'Find pools' }));
    const card = await screen.findByTestId('lp-create');
    await within(card).findByRole('button', { name: 'Open a pool' });
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
  });

  it('with a token already on the page (a link from a wallet app), Create a pool opens its form at once, reading nothing again', async () => {
    const r = mount(`/solana-lp?mint=${BAYLA}`);
    await within(await screen.findByTestId('lp-create')).findByRole('button', { name: 'Open a pool' });
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
    const reads = (r.findPools as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(await task('Create a pool'));
    expect(await screen.findByTestId('lp-create-panel')).toHaveTextContent(BAYLA);
    expect((r.findPools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
    expect(screen.getByTestId('lp-task-line')).toHaveTextContent('The form opens under this token’s checks.');
  });

  it('a link that carries a token opens nothing and does not move the page', async () => {
    mount(`/solana-lp?mint=${BAYLA}`);
    await within(await screen.findByTestId('lp-create')).findByRole('button', { name: 'Open a pool' });
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('acts once: a form the visitor closed is not opened again by a re-read', async () => {
    const r = mount();
    fireEvent.click(await task('Create a pool'));
    fireEvent.click(await chip('BAYLA'));
    const panel = await screen.findByTestId('lp-create-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lp-create-panel')).toBeNull());
    const before = (r.findPools as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(within(await finder()).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect((r.findPools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText('Reading the token and its pools again…')).toBeNull());
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
    // Asked again, it opens again.
    fireEvent.click(await chip('BAYLA'));
    expect(await screen.findByTestId('lp-create-panel')).toBeTruthy();
  });
});

describe('the form starts with what a phone needs', () => {
  it('the wallet button and the amount boxes come before the long notes', async () => {
    mount();
    fireEvent.click(await task('Create a pool'));
    fireEvent.click(await chip('BAYLA'));
    const panel = await screen.findByTestId('lp-create-panel');
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const connect = within(panel).getByRole('button', { name: 'Connect Solana Wallet' });
    const sol = within(panel).getByLabelText('SOL to put in');
    const review = within(panel).getByRole('button', { name: 'Review: open the pool' });
    const notes = within(panel).getByTestId('lp-before-you-open');
    const terms = within(panel).getByTestId('lp-create-terms');
    expect(before(connect, sol)).toBe(true);
    expect(before(sol, review)).toBe(true);
    expect(before(review, terms)).toBe(true);
    expect(before(terms, notes)).toBe(true);
    // The notes are still on the page, whole, and the form says where.
    expect(notes).toHaveTextContent('Put in only what you can afford to lose.');
    expect(terms).toHaveTextContent('Fee to open');
    expect(panel).toHaveTextContent('Read the notes under this form before you review. The main ones are shown again before you sign.');
  });
});

describe('Remove liquidity goes to the positions', () => {
  it('brings them onto the screen, sends focus there and says what is there', async () => {
    mount();
    const positions = await screen.findByTestId('lp-positions');
    fireEvent.click(await task('Remove liquidity'));
    expect(scrolledTo()).toContain(positions);
    expect(document.activeElement).toBe(positions);
    expect(await task('Remove liquidity')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('lp-task-line')).toHaveTextContent('Your pool shares are listed under Your positions.');
    expect(positions).toHaveTextContent('Removing liquidity starts here: each share that can be taken out gets a Remove liquidity button.');
  });

  it('a wallet with no shares is told there is nothing to remove yet, and why', async () => {
    wallet.publicKey = key();
    mount();
    const positions = await screen.findByTestId('lp-positions');
    await within(positions).findByTestId('lp-no-positions');
    expect(positions).toHaveTextContent('So there is nothing to remove yet. A share appears here once this wallet adds liquidity or opens a pool.');
  });
});

describe('a lookup the visitor asked for is brought onto the screen', () => {
  it('pressing Find pools scrolls to the answer', async () => {
    mount();
    fireEvent.change(within(await finder()).getByLabelText('Token mint address'), { target: { value: BAYLA } });
    expect(scrolled).not.toHaveBeenCalled();
    fireEvent.click(within(await finder()).getByRole('button', { name: 'Find pools' }));
    await screen.findByTestId('lp-create');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
  });
});

describe('a token with no pool yet', () => {
  it('is told that opening the pool is how the first liquidity goes in', async () => {
    mount(`/solana-lp?mint=${BAYLA}`);
    const card = await screen.findByTestId('lp-create');
    await waitFor(() => expect(card).toHaveTextContent('There is no pool to add liquidity to yet. Opening one is how the first liquidity goes in.'));
    // The sentence the card already had is kept.
    expect(card).toHaveTextContent('No pool for this token yet. You can open the first one on the public fee tier');
  });
});
