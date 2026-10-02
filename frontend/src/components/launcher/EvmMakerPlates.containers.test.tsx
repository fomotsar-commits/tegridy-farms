// The two containers that read the maker's plates: "Read again" must read again, keep the
// keyboard where it was and say what it is doing, and no failure, even a thrown one, may
// leave a block on "Reading..." for good.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { CURVE_LAUNCHER_ABI, CURVE_TOTAL_SUPPLY } from '../../lib/launcher/curve';
import { DOPPLER_PLATES_ABI } from '../../lib/launcher/birthPlates';
import { AIRLOCK_CREATE_EVENT } from '../../lib/launcher/ourLaunches';
import { LAUNCHER_INTEGRATOR_ADDRESS } from '../../lib/launcher/config';
import { ALLOCATION_READING, ALLOCATION_UNREADABLE, CREATE_BUY_UNREADABLE, CURVE_READING } from './makerPlatesCopy';

const TOKEN = getAddress('0x10422e419fe9858f9da77d2f30fecfbb4482e790');
const MAKER = getAddress('0x295c4315fd4c0710d286b69e7cd5cecd289d5e6c');
const LAUNCHER = getAddress('0xf4dfa741ad63b3d95dc3fc10d311cae507ce34de');
const AIRLOCK = getAddress('0xde3599a2ec440b296373a983c85c365da55d9dfa');
const V4_INITIALIZER = getAddress('0x53b4c21a6cb61d64f636abbfa6e8e90e6558e8ad');
const ZERO = '0x0000000000000000000000000000000000000000';
const TX = '0x730b0c9f5f1c272b054f132459d81802950f04b74f7f8342718885c71134b250' as Hex;
const E26 = 10n ** 26n;

const ctl = vi.hoisted(() => ({ throwCurve: false, throwDoppler: false }));
vi.mock('../../lib/launcher/birthPlates', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/launcher/birthPlates')>();
  return {
    ...real,
    readCurveCreateBuy: (...a: Parameters<typeof real.readCurveCreateBuy>) =>
      ctl.throwCurve ? Promise.reject(new Error('a bug nobody caught')) : real.readCurveCreateBuy(...a),
    readDopplerPlates: (...a: Parameters<typeof real.readDopplerPlates>) =>
      ctl.throwDoppler ? Promise.reject(new Error('a bug nobody caught')) : real.readDopplerPlates(...a),
  };
});

const chain = vi.hoisted(() => ({ client: { getTransactionReceipt: vi.fn(), readContract: vi.fn() } }));
vi.mock('wagmi', () => ({ usePublicClient: () => chain.client }));

import { CurveMakerCreateBuy, MakerPlatesCard } from './EvmMakerPlates';

function curveReceipt() {
  const ev = (name: 'LaunchCreated' | 'CurveBuy') => CURVE_LAUNCHER_ABI.find((x) => x.type === 'event' && x.name === name)!;
  const data = (name: 'LaunchCreated' | 'CurveBuy', values: readonly unknown[]) => {
    const e = ev(name);
    const params = (e.type === 'event' ? e.inputs : []) as readonly { type: string; indexed?: boolean }[];
    return encodeAbiParameters(params.filter((i) => !i.indexed), values as never);
  };
  return {
    status: 'success',
    from: MAKER,
    to: LAUNCHER,
    transactionHash: TX,
    logs: [
      {
        address: LAUNCHER,
        topics: encodeEventTopics({ abi: CURVE_LAUNCHER_ABI, eventName: 'LaunchCreated', args: { token: TOKEN, creator: MAKER } }),
        data: data('LaunchCreated', ['Fixture', 'FIX', 963_100_000n * 10n ** 18n, 36_900_000n * 10n ** 18n, 10n ** 17n, 4n * 10n ** 18n, 100, 4000, 2500]),
      },
      {
        address: LAUNCHER,
        topics: encodeEventTopics({ abi: CURVE_LAUNCHER_ABI, eventName: 'CurveBuy', args: { token: TOKEN, buyer: MAKER } }),
        data: data('CurveBuy', [99n * 10n ** 15n, 10n ** 15n, CURVE_TOTAL_SUPPLY / 25n, 99n * 10n ** 15n, 1n]),
      },
    ],
  };
}

function dopplerReceipt() {
  const log = (eventName: 'VestingScheduleCreated' | 'VestingAllocated' | 'Transfer', args: Record<string, unknown>) => {
    const ev = DOPPLER_PLATES_ABI.find((x) => x.type === 'event' && x.name === eventName)!;
    const params = (ev.type === 'event' ? ev.inputs : []) as readonly { name?: string; type: string; indexed?: boolean }[];
    const data = params.filter((i) => !i.indexed);
    return { address: TOKEN, topics: encodeEventTopics({ abi: DOPPLER_PLATES_ABI, eventName, args } as never), data: encodeAbiParameters(data, data.map((i) => args[i.name!]) as never) };
  };
  return {
    status: 'success',
    from: MAKER,
    to: AIRLOCK,
    transactionHash: TX,
    logs: [
      log('VestingScheduleCreated', { scheduleId: 0n, cliff: 0n, duration: 86_400n }),
      log('VestingAllocated', { beneficiary: MAKER, scheduleId: 0n, amount: 8n * E26 }),
      log('Transfer', { from: ZERO, to: TOKEN, amount: 8n * E26 }),
      log('Transfer', { from: ZERO, to: AIRLOCK, amount: 2n * E26 }),
      {
        address: AIRLOCK,
        topics: encodeEventTopics({ abi: [AIRLOCK_CREATE_EVENT], eventName: 'Create', args: { numeraire: ZERO } }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [TOKEN, V4_INITIALIZER, MAKER]),
      },
    ],
  };
}

/** Our lookup fails once (a Blockscout 502), then names the transaction. */
const flakyLookup = () => {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 502, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ tx: TX, block: 1 }) };
  });
};

beforeEach(() => {
  ctl.throwCurve = false;
  ctl.throwDoppler = false;
  chain.client.getTransactionReceipt.mockReset();
  chain.client.readContract.mockReset();
  chain.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getAssetData') return [ZERO, MAKER, MAKER, MAKER, V4_INITIALIZER, MAKER, ZERO, 9n * E26, 10n * E26, LAUNCHER_INTEGRATOR_ADDRESS];
    if (functionName === 'vestingStart') return 1_778_105_483n;
    if (functionName === 'vestingOf') return [8n * E26, 0n];
    throw new Error(`no stub for ${functionName}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('/eth-curve block: Read again', () => {
  it('reads again after a failed lookup, keeps the keyboard on the block, and says what it is doing', async () => {
    chain.client.getTransactionReceipt.mockResolvedValue(curveReceipt());
    const lookup = flakyLookup();
    vi.stubGlobal('fetch', lookup);
    render(<CurveMakerCreateBuy chainId={1} launcher={LAUNCHER} token={TOKEN} creator={MAKER} />);
    const again = await screen.findByRole('button', { name: 'Read again' });
    expect(screen.getByRole('status')).toHaveTextContent(CREATE_BUY_UNREADABLE);

    again.focus();
    fireEvent.click(again);
    expect(document.activeElement, 'focus fell to the page when the button went away').not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole('status'));
    expect(screen.getByRole('status')).toHaveTextContent(CURVE_READING);

    await screen.findByText(/^The maker's create-buy: 4\.00% of the supply/);
    expect(screen.getByRole('status')).toHaveTextContent(/The maker's create-buy: 4\.00%/);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(chain.client.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('a read that throws ends as "could not read", never as "Reading..." for good', async () => {
    ctl.throwCurve = true;
    vi.stubGlobal('fetch', vi.fn());
    render(<CurveMakerCreateBuy chainId={1} launcher={LAUNCHER} token={TOKEN} creator={MAKER} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(CREATE_BUY_UNREADABLE));
    expect(screen.queryByText(CURVE_READING)).not.toBeInTheDocument();
  });
});

describe('/launch card: Read again', () => {
  it('reads again after a failed lookup, keeps the keyboard on the card, and says what it is doing', async () => {
    chain.client.getTransactionReceipt.mockResolvedValue(dopplerReceipt());
    const lookup = flakyLookup();
    vi.stubGlobal('fetch', lookup);
    render(<MakerPlatesCard client={chain.client} token={TOKEN} />);
    const again = await screen.findByRole('button', { name: 'Read again' });
    expect(screen.getByRole('status')).toHaveTextContent(ALLOCATION_UNREADABLE);

    again.focus();
    fireEvent.click(again);
    expect(document.activeElement, 'focus fell to the page when the button went away').not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole('status'));
    expect(screen.getByRole('status')).toHaveTextContent(ALLOCATION_READING);

    await screen.findByText(/^The maker's allocation: 80\.00% of the supply/);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(chain.client.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('a read that throws ends as "could not read", never as "Reading..." for good', async () => {
    ctl.throwDoppler = true;
    vi.stubGlobal('fetch', vi.fn());
    render(<MakerPlatesCard client={chain.client} token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(ALLOCATION_UNREADABLE));
    expect(screen.queryByText(ALLOCATION_READING)).not.toBeInTheDocument();
  });
});
