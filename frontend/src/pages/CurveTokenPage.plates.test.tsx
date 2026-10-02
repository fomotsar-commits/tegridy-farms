// /eth-curve/:token shows the maker's create-buy (rulings 3 and 4) right under the wrong-chain
// banner, above the market numbers and the trade panel, read from the launch's own receipt on
// the chain the token resolved on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { CURVE_LAUNCHER_ABI, CURVE_TOTAL_SUPPLY } from '../lib/launcher/curve';

const TOKEN = getAddress('0x10422e419fe9858f9da77d2f30fecfbb4482e790');
const CREATOR = getAddress('0x295c4315fd4c0710d286b69e7cd5cecd289d5e6c');
const LAUNCHER = getAddress('0xf4dfa741ad63b3d95dc3fc10d311cae507ce34de');
const TX = '0x730b0c9f5f1c272b054f132459d81802950f04b74f7f8342718885c71134b250' as Hex;

const chain = vi.hoisted(() => {
  const state = { clientFor: [] as unknown[], receipt: null as unknown, reads: 0 };
  // One client per chain, as wagmi gives: a new object each render would re-run the read.
  const client = {
    getTransactionReceipt: async () => {
      state.reads += 1;
      return state.receipt;
    },
    readContract: async () => 0n,
  };
  return Object.assign(state, { client });
});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useReadContract: () => ({ data: 'FIX' }),
  useReadContracts: () => ({
    data: [
      {
        status: 'success',
        result: { creator: CREATOR, virtualEth: 10n ** 17n, ethReserve: 0n, tokenReserve: 10n ** 26n, graduationEth: 4n * 10n ** 18n, graduated: false },
      },
      { status: 'failure' },
      { status: 'failure' },
    ],
    isLoading: false,
  }),
  useWriteContract: () => ({ writeContract: () => {}, isPending: false }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isSuccess: false }),
  usePublicClient: ({ chainId }: { chainId: number }) => {
    chain.clientFor.push(chainId);
    return chain.client;
  },
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> });
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ trackPageView: () => {} }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => <div data-testid="wrong-chain" /> }));
vi.mock('../components/launcher/CurveTradePanel', () => ({ CurveTradePanel: () => <div data-testid="trade-panel" /> }));
vi.mock('../components/launcher/EvmCurveChart', () => ({ EvmCurveChart: () => null }));

import CurveTokenPage from './CurveTokenPage';

function birthReceipt() {
  const created = CURVE_LAUNCHER_ABI.find((x) => x.type === 'event' && x.name === 'LaunchCreated')!;
  const bought = CURVE_LAUNCHER_ABI.find((x) => x.type === 'event' && x.name === 'CurveBuy')!;
  const data = (ev: typeof created | typeof bought, values: readonly unknown[]) => {
    const params = (ev.type === 'event' ? ev.inputs : []) as readonly { name?: string; type: string; indexed?: boolean }[];
    return encodeAbiParameters(params.filter((i) => !i.indexed), values as never);
  };
  return {
    status: 'success',
    from: CREATOR,
    transactionHash: TX,
    logs: [
      {
        address: LAUNCHER,
        topics: encodeEventTopics({ abi: CURVE_LAUNCHER_ABI, eventName: 'LaunchCreated', args: { token: TOKEN, creator: CREATOR } }),
        data: data(created, ['Fixture', 'FIX', 963_100_000n * 10n ** 18n, 36_900_000n * 10n ** 18n, 10n ** 17n, 4n * 10n ** 18n, 100, 4000, 2500]),
      },
      {
        address: LAUNCHER,
        topics: encodeEventTopics({ abi: CURVE_LAUNCHER_ABI, eventName: 'CurveBuy', args: { token: TOKEN, buyer: CREATOR } }),
        data: data(bought, [99n * 10n ** 15n, 10n ** 15n, CURVE_TOTAL_SUPPLY / 25n, 99n * 10n ** 15n, 1n]),
      },
    ],
  };
}

const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tx: TX, block: 1 }) }));

beforeEach(() => {
  chain.clientFor = [];
  chain.reads = 0;
  chain.receipt = birthReceipt();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("/eth-curve/:token: the maker's create-buy", () => {
  it('reads it on the resolved chain and shows it under the banner, above the numbers and the trade panel', async () => {
    render(
      <MemoryRouter initialEntries={[`/eth-curve/${TOKEN}?c=1`]}>
        <Routes>
          <Route path="/eth-curve/:token" element={<CurveTokenPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const figure = await screen.findByText(
      "The maker's create-buy: 4.00% of the supply (40,000,000 tokens), bought in the launch transaction, before anyone else could buy.",
    );
    const block = screen.getByTestId('curve-maker-create-buy');
    expect(block).toContainElement(figure);
    expect(block).toHaveTextContent("No lock: the Memetics Curve has no way to lock a maker's tokens.");
    expect(before(screen.getByTestId('wrong-chain'), block)).toBe(true);
    expect(before(block, screen.getByText('Market cap'))).toBe(true);
    expect(before(block, screen.getByTestId('trade-panel'))).toBe(true);
    expect(chain.clientFor).toContain(1);
    expect(chain.reads).toBe(1);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), 'https://memetics.finance');
    expect(Object.fromEntries(url.searchParams)).toEqual({ resource: 'curve-birth', chain: '1', token: TOKEN });
  });
});
