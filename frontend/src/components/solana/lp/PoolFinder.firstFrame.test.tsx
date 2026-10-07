// The finder's first frame is the three verbs. The site's tokens and the address field come
// after a press: on a phone they pushed the venue's own pools under the fold, and a visitor
// who has not said what they want has nothing to type yet (MAP 3.11, 3.35). A token already
// on the page (a ?mint= link, good or bad) and a finder with no verbs (LP's switch 'off')
// show them from the start: there is nothing to press first.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import { key } from '../../../lib/solana/lp/testkit.fixture';
import { BUNGALOWS } from '../../../lib/bungalows';
import { TIER1_ADDRESS, fakeLpApi, readyFacts, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { recordedFeeTiers } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';

vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: null }), useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

const bayla = BUNGALOWS.find((b) => b.id === 'bayla' && b.chain === 'solana' && b.address);
if (!bayla?.address) throw new Error('the BAYLA room has no Solana mint');
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

function mount(path = '/solana-lp', mode: LpWritesOverrides['mode'] = 'on') {
  const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()) });
  render(
    <MemoryRouter initialEntries={[path]}>
      <LpInner readers={readers()} writes={{ mode, load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
}

const finder = () => screen.findByTestId('lp-finder');
const field = async () => within(await finder()).queryByLabelText('Token mint address');
const chips = async () => within(await finder()).queryByTestId('lp-site-tokens');
const verb = async (name: string) => within(within(await finder()).getByTestId('lp-tasks')).getByRole('button', { name });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('before a press, the first card is the three verbs and nothing else', () => {
  it('no address field and no token chips are in the DOM', async () => {
    mount();
    expect(within(await finder()).getByTestId('lp-tasks')).toBeInTheDocument();
    expect(await field()).toBeNull();
    expect(await chips()).toBeNull();
    expect(within(await finder()).queryByRole('button', { name: 'Find pools' })).toBeNull();
  });

  it('the card’s heading is the verbs’ group name, for screen readers only; the old title is gone', async () => {
    mount();
    const f = await finder();
    const heading = within(f).getByRole('heading', { level: 2, name: 'What do you want to do?' });
    expect(heading).toHaveClass('sr-only');
    expect(f).not.toHaveTextContent('Create a pool, add or remove liquidity');
  });
});

describe('after a press, the token chips and the address field are on the page', () => {
  it.each(['Create a pool', 'Add liquidity', 'Remove liquidity'])('%s', async (name) => {
    mount();
    fireEvent.click(await verb(name));
    expect(await field()).toBeInTheDocument();
    expect(await chips()).toHaveTextContent('Then pick a token with a room on this site');
    expect(within(await finder()).getByRole('button', { name: 'Find pools' })).toBeInTheDocument();
  });
});

describe('with a token already on the page they are there from the start', () => {
  it('a ?mint= link: the field holds the token before any press', async () => {
    mount(`/solana-lp?mint=${BAYLA}`);
    expect(await field()).toHaveValue(BAYLA);
    expect(await chips()).toBeInTheDocument();
  });

  it('a ?mint= link that is not an address: the field holds it with the reason, not silence', async () => {
    mount('/solana-lp?mint=garbage');
    expect(await field()).toHaveValue('garbage');
    expect(await finder()).toHaveTextContent('That does not look like a Solana address.');
  });
});

describe('with no verbs there is nothing to press first', () => {
  it("LP's switch 'off': the field and the chips from the start, under the finder's own visible heading", async () => {
    mount('/solana-lp', 'off');
    const f = await finder();
    expect(within(f).queryByTestId('lp-tasks')).toBeNull();
    expect(await field()).toBeInTheDocument();
    expect(await chips()).toBeInTheDocument();
    const heading = within(f).getByRole('heading', { level: 2, name: 'Find pools for a token' });
    expect(heading).not.toHaveClass('sr-only');
  });

  it("'withdraw-only' still has a verb: hidden until Remove liquidity is pressed", async () => {
    mount('/solana-lp', 'withdraw-only');
    expect(await verb('Remove liquidity')).toBeInTheDocument();
    expect(await field()).toBeNull();
    fireEvent.click(await verb('Remove liquidity'));
    expect(await field()).toBeInTheDocument();
  });
});
