// /launch/:token shows the maker's allocation and its lock (rulings 3 and 4) right after the
// token header, loaded on its own: the slow dossier reads below never hold it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { DOPPLER_PLATES_ABI } from '../lib/launcher/birthPlates';
import { AIRLOCK_CREATE_EVENT } from '../lib/launcher/ourLaunches';
import { LAUNCHER_INTEGRATOR_ADDRESS } from '../lib/launcher/config';
import { BOUGHT_NONE } from '../components/launcher/makerPlatesCopy';

const TOKEN = getAddress('0x10422e419fe9858f9da77d2f30fecfbb4482e790');
const MAKER = getAddress('0x295c4315fd4c0710d286b69e7cd5cecd289d5e6c');
const AIRLOCK = getAddress('0xde3599a2ec440b296373a983c85c365da55d9dfa');
const V4_INITIALIZER = getAddress('0x53b4c21a6cb61d64f636abbfa6e8e90e6558e8ad');
const ZERO = '0x0000000000000000000000000000000000000000';
const TX = '0x730b0c9f5f1c272b054f132459d81802950f04b74f7f8342718885c71134b250' as Hex;
const E26 = 10n ** 26n;

function log(eventName: 'VestingScheduleCreated' | 'VestingAllocated' | 'Transfer', args: Record<string, unknown>) {
  const ev = DOPPLER_PLATES_ABI.find((x) => x.type === 'event' && x.name === eventName)!;
  const params = (ev.type === 'event' ? ev.inputs : []) as readonly { name?: string; type: string; indexed?: boolean }[];
  const data = params.filter((i) => !i.indexed);
  return {
    address: TOKEN,
    topics: encodeEventTopics({ abi: DOPPLER_PLATES_ABI, eventName, args } as never),
    data: encodeAbiParameters(data, data.map((i) => args[i.name!]) as never),
  };
}
const airlockCreate = {
  address: AIRLOCK,
  topics: encodeEventTopics({ abi: [AIRLOCK_CREATE_EVENT], eventName: 'Create', args: { numeraire: ZERO } }),
  data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [TOKEN, V4_INITIALIZER, MAKER]),
};

// The dossier's first read (getCode) never answers, so the page stays on its loading line.
const client = vi.hoisted(() => ({
  getCode: () => new Promise(() => {}),
  getLogs: () => new Promise(() => {}),
  getTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
}));
vi.mock('wagmi', () => ({ usePublicClient: () => client }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> });
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import LaunchTokenPage from './LaunchTokenPage';

function stubReads(vestedTotal = 8n * E26) {
  client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getAssetData') return [ZERO, MAKER, MAKER, MAKER, V4_INITIALIZER, MAKER, ZERO, 9n * E26, 10n * E26, LAUNCHER_INTEGRATOR_ADDRESS];
    if (functionName === 'vestingStart') return 1_778_105_483n;
    if (functionName === 'vestingOf') return [8n * E26, 8n * E26];
    if (functionName === 'vestedTotalAmount') return vestedTotal;
    throw new Error(`no stub for ${functionName}`);
  });
}

beforeEach(() => {
  client.getTransactionReceipt.mockResolvedValue({
    status: 'success',
    from: MAKER,
    to: AIRLOCK,
    transactionHash: TX,
    logs: [
      log('VestingScheduleCreated', { scheduleId: 0n, cliff: 0n, duration: 86_400n }),
      log('VestingAllocated', { beneficiary: MAKER, scheduleId: 0n, amount: 8n * E26 }),
      log('Transfer', { from: ZERO, to: TOKEN, amount: 8n * E26 }),
      log('Transfer', { from: ZERO, to: AIRLOCK, amount: 2n * E26 }),
      airlockCreate,
    ],
  });
  stubReads();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tx: TX, block: 25_038_892 }) })));
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={[`/launch/${TOKEN}`]}>
      <Routes>
        <Route path="/launch/:token" element={<LaunchTokenPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("/launch/:token: the maker's allocation", () => {
  it('sits right after the header, before the dossier, and does not wait for it', async () => {
    renderPage();
    // Its one-day vesting ended on 2026-05-07, so the card says so (today is after that).
    const line = await screen.findByText(
      `The maker's allocation: 80.00% of the supply (800,000,000 tokens) to ${MAKER}, not locked any more: its vesting ended on 2026-05-07 22:11 UTC, so all of it can be claimed now; 800,000,000 tokens claimed so far.`,
    );
    const card = screen.getByTestId('maker-plates');
    expect(card).toContainElement(line);
    expect(card).toHaveTextContent(BOUGHT_NONE);
    const heading = screen.getByRole('heading', { level: 1 });
    const loading = screen.getByText(/Reading this token on-chain/);
    expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
  });

  // The wizard's default is no premine: its launch must still show the maker's wallet and
  // what the maker bought, the same plates as the other rails.
  it('a launch with no premine shows the maker and what it bought', async () => {
    client.getTransactionReceipt.mockResolvedValue({
      status: 'success',
      from: MAKER,
      to: AIRLOCK,
      transactionHash: TX,
      logs: [log('Transfer', { from: ZERO, to: AIRLOCK, amount: 10n * E26 }), airlockCreate],
    });
    stubReads(0n);
    renderPage();
    const line = await screen.findByText(`No allocation at birth. The maker's wallet is ${MAKER}.`);
    const card = screen.getByTestId('maker-plates');
    expect(card).toContainElement(line);
    expect(card).toHaveTextContent(BOUGHT_NONE);
  });
});
