// The owner on a phone, 2026-10-03: "theres no way to add to the lp on the mobile solana lp tab".
//
// Measured on production at 390x664: the tab opened on an empty address box and nothing
// else to press; after Find pools, the answer began 15px below the bottom of the screen
// and the "Open a pool" button sat 490px lower, so the press looked as if it had done
// nothing. And with no pool on the venue yet, "Add liquidity" appears nowhere: opening
// the pool IS how the first liquidity goes in, and nothing said so.
//
// So: a visitor standing in a Solana room gets one button that looks its token up; a
// lookup they asked for is brought onto the screen; and the card for a token with no
// pool says that opening one is how liquidity is first added.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
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

const bayla = BUNGALOWS.find((b) => b.id === 'bayla');
if (!bayla?.address) throw new Error('the BAYLA room has no mint');
const BAYLA = bayla.address;

const token = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'BAYLA', symbol: 'BAYLA', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});
const noPools = (mint: string): PoolSearchRead => ({
  kind: 'ok',
  search: {
    mint,
    known: { launchPool: key().toBase58(), standard: [{ index: 1, config: TIER1_ADDRESS.toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
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

function mount(path = '/solana-lp') {
  const r = readers();
  const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()) });
  render(
    <MemoryRouter initialEntries={[path]}>
      <LpInner readers={r} writes={{ mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
  return r;
}

const scrolled = vi.fn();
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

describe('a visitor in a Solana room', () => {
  it('gets one button that looks the room\'s own token up, by its address', async () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    const r = mount();
    const finder = await screen.findByTestId('lp-finder');
    fireEvent.click(within(finder).getByRole('button', { name: 'Find BAYLA pools' }));
    await waitFor(() => expect(r.findPools).toHaveBeenCalled());
    // What was looked up is the room's mint: the token card prints the address it read.
    expect(await screen.findByTestId('token-safety')).toHaveTextContent(BAYLA);
    // The address goes into the box, so what was looked up is on screen and can be checked.
    expect(within(finder).getByLabelText('Token mint address')).toHaveValue(BAYLA);
    expect(await screen.findByTestId('lp-create')).toBeTruthy();
  });

  it('is not offered a shortcut in a room whose token is not on Solana, or in no room', async () => {
    mount();
    const finder = await screen.findByTestId('lp-finder');
    expect(within(finder).queryByRole('button', { name: /^Find .+ pools$/ })).toBeNull();
    cleanup();
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    mount();
    const again = await screen.findByTestId('lp-finder');
    expect(within(again).queryByRole('button', { name: /^Find .+ pools$/ })).toBeNull();
  });
});

describe('a lookup the visitor asked for is brought onto the screen', () => {
  it('pressing Find pools scrolls to the answer', async () => {
    mount();
    const finder = await screen.findByTestId('lp-finder');
    fireEvent.change(within(finder).getByLabelText('Token mint address'), { target: { value: BAYLA } });
    expect(scrolled).not.toHaveBeenCalled();
    fireEvent.click(within(finder).getByRole('button', { name: 'Find pools' }));
    await screen.findByTestId('lp-create');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
  });

  it('the room button scrolls to the answer too', async () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    mount();
    const finder = await screen.findByTestId('lp-finder');
    fireEvent.click(within(finder).getByRole('button', { name: 'Find BAYLA pools' }));
    await screen.findByTestId('lp-create');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
  });

  it('a link that carries a token does not move the page by itself', async () => {
    mount(`/solana-lp?mint=${BAYLA}`);
    await screen.findByTestId('lp-create');
    expect(scrolled).not.toHaveBeenCalled();
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

  it('the finder says how adding works before anything is looked up', async () => {
    mount();
    const finder = await screen.findByTestId('lp-finder');
    expect(finder).toHaveTextContent('To add liquidity, look a token up. A pool that passes its checks gets an Add liquidity button; a token with no pool yet gets Open a pool.');
  });
});
