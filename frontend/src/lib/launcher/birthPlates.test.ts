// The maker's plates on the Ethereum rails, read from receipts built with the contracts' own
// ABIs. No launch exists on the Memetics Curve on any chain yet (launchCount 0), so its receipts
// are built here; the Doppler one mirrors a real DopplerERC20V1 birth on Ethereum
// (tx 0x730b0c9f…, block 25038892): one schedule (no cliff, one day), 80% to the sender.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, toEventSelector, toFunctionSelector, type Address, type Hex } from 'viem';
import { dopplerERC20V1Abi } from '@whetstone-research/doppler-sdk/evm';
import { CURVE_LAUNCHER_ABI, CURVE_TOTAL_SUPPLY, previewBuy, saleSupplyForReserveBps } from './curve';
import {
  DOPPLER_PLATES_ABI,
  curveCreateBuyFromReceipt,
  dopplerBirthFromReceipt,
  fetchBirthHint,
  lockWindow,
  readCurveCreateBuy,
  readDopplerPlates,
  type BirthLog,
  type BirthReceipt,
} from './birthPlates';

const LAUNCHER = getAddress('0xf4dfa741ad63b3d95dc3fc10d311cae507ce34de');
const TOKEN = getAddress('0x10422e419fe9858f9da77d2f30fecfbb4482e790');
const OTHER_TOKEN = getAddress('0x00000000000000000000000000000000000000aa');
const MAKER = getAddress('0x295c4315fd4c0710d286b69e7cd5cecd289d5e6c');
const OTHER = getAddress('0x86c2dc44f8d298c6c2d63a9ac9862511505938e0');
const AIRLOCK = getAddress('0xde3599a2ec440b296373a983c85c365da55d9dfa');
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const TX = '0x730b0c9f5f1c272b054f132459d81802950f04b74f7f8342718885c71134b250' as Hex;

const receipt = (logs: BirthLog[], over: Partial<BirthReceipt> = {}): BirthReceipt => ({
  status: 'success',
  from: MAKER,
  transactionHash: TX,
  logs,
  ...over,
});

// ─────────────────────────── the Memetics Curve's own logs ───────────────────────────

const CONFIG = { virtualEth: 210_526_315_789_473_684n, graduationEth: 4n * 10n ** 18n, feeBps: 100 };
const SALE = saleSupplyForReserveBps(369);
const curveEvent = (name: 'LaunchCreated' | 'CurveBuy') =>
  CURVE_LAUNCHER_ABI.find((x) => x.type === 'event' && x.name === name) as Extract<(typeof CURVE_LAUNCHER_ABI)[number], { type: 'event' }>;

function launchCreated(o: { address?: Address; token?: Address; creator?: Address } = {}): BirthLog {
  const ev = curveEvent('LaunchCreated');
  return {
    address: o.address ?? LAUNCHER,
    topics: encodeEventTopics({ abi: CURVE_LAUNCHER_ABI, eventName: 'LaunchCreated', args: { token: o.token ?? TOKEN, creator: o.creator ?? MAKER } }) as Hex[],
    data: encodeAbiParameters(
      ev.inputs.filter((i) => !i.indexed),
      ['Fixture', 'FIX', SALE, CURVE_TOTAL_SUPPLY - SALE, CONFIG.virtualEth, CONFIG.graduationEth, CONFIG.feeBps, 4000, 2500],
    ),
  };
}

/** A real-shaped buy: tokensOut and reserves from previewBuy, the contract's own math. */
function curveBuy(o: { buyer: Address; ethGross: bigint; address?: Address; token?: Address; reserve?: { eth: bigint; tokens: bigint } }): BirthLog & { tokensOut: bigint } {
  const ev = curveEvent('CurveBuy');
  const before = o.reserve ?? { eth: 0n, tokens: SALE };
  const q = previewBuy({ ...CONFIG, ethReserve: before.eth, tokenReserve: before.tokens }, o.ethGross);
  return {
    address: o.address ?? LAUNCHER,
    topics: encodeEventTopics({ abi: CURVE_LAUNCHER_ABI, eventName: 'CurveBuy', args: { token: o.token ?? TOKEN, buyer: o.buyer } }) as Hex[],
    data: encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), [q.ethIn, q.fee, q.tokensOut, before.eth + q.ethIn, before.tokens - q.tokensOut]),
    tokensOut: q.tokensOut,
  };
}

const WANT = { launcher: LAUNCHER, token: TOKEN, creator: MAKER };

describe("the Memetics Curve: the maker's create-buy from the launch receipt", () => {
  it("counts only the creator's own CurveBuy logs as the maker's, and the rest as other wallets", () => {
    const mine = curveBuy({ buyer: MAKER, ethGross: 10n ** 17n });
    const theirs = curveBuy({ buyer: OTHER, ethGross: 5n * 10n ** 16n, reserve: { eth: 99n * 10n ** 15n, tokens: SALE - mine.tokensOut } });
    const r = curveCreateBuyFromReceipt(receipt([launchCreated(), mine, theirs]), WANT);
    expect(r).toEqual({
      kind: 'ok',
      value: { tx: TX, creator: MAKER, makerTokens: mine.tokensOut, othersTokens: theirs.tokensOut, others: 1 },
    });
    // The fixture is real-sized: a 0.1 ETH opening buy on this config is a few hundred million tokens.
    expect(mine.tokensOut > 10n ** 26n && mine.tokensOut < SALE).toBe(true);
  });

  it('ignores a CurveBuy from another address and a CurveBuy for another token', () => {
    const mine = curveBuy({ buyer: MAKER, ethGross: 10n ** 17n });
    const fake = curveBuy({ buyer: MAKER, ethGross: 10n ** 18n, address: OTHER_TOKEN });
    const elsewhere = curveBuy({ buyer: MAKER, ethGross: 10n ** 18n, token: OTHER_TOKEN });
    const r = curveCreateBuyFromReceipt(receipt([launchCreated(), fake, mine, elsewhere]), WANT);
    expect(r.kind === 'ok' && r.value.makerTokens).toBe(mine.tokensOut);
    expect(r.kind === 'ok' && r.value.others).toBe(0);
  });

  it('reads a launch with no opening buy as a read zero', () => {
    const r = curveCreateBuyFromReceipt(receipt([launchCreated()]), WANT);
    expect(r).toEqual({ kind: 'ok', value: { tx: TX, creator: MAKER, makerTokens: 0n, othersTokens: 0n, others: 0 } });
  });

  it('refuses a transaction whose LaunchCreated is from another address, for another token, or by another creator', () => {
    const buy = curveBuy({ buyer: MAKER, ethGross: 10n ** 17n });
    for (const created of [launchCreated({ address: OTHER_TOKEN }), launchCreated({ token: OTHER_TOKEN }), launchCreated({ creator: OTHER })]) {
      expect(curveCreateBuyFromReceipt(receipt([created, buy]), WANT).kind).toBe('unreadable');
    }
  });

  it('refuses a reverted transaction', () => {
    const r = curveCreateBuyFromReceipt(receipt([launchCreated()], { status: 'reverted' }), WANT);
    expect(r.kind).toBe('unreadable');
  });
});

describe('the Memetics Curve: the server is a hint, and every failure is unreadable, never 0', () => {
  const client = (r: unknown) => ({ getTransactionReceipt: vi.fn(async () => (r instanceof Error ? Promise.reject(r) : r)), readContract: vi.fn() });
  const want = { chainId: 1, ...WANT };

  it('reads the hinted receipt on the launch chain', async () => {
    const c = client(receipt([launchCreated(), curveBuy({ buyer: MAKER, ethGross: 10n ** 17n })]));
    const hint = vi.fn(async () => TX);
    const r = await readCurveCreateBuy(c, want, hint);
    expect(hint).toHaveBeenCalledWith('curve', 1, TOKEN);
    expect(c.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
    expect(r.kind).toBe('ok');
  });

  it.each([
    ['the lookup fails', async () => Promise.reject(new Error('HTTP 502')), receipt([launchCreated()])],
    ['the lookup finds none yet', async () => null, receipt([launchCreated()])],
    ['the receipt read fails', async () => TX, new Error('rpc down')],
    ['the receipt is malformed', async () => TX, { status: 'success', logs: 'nope' }],
  ])('%s', async (_label, hint, r) => {
    const out = await readCurveCreateBuy(client(r), want, hint as () => Promise<Hex | null>);
    expect(out.kind).toBe('unreadable');
  });

  it('with no chain reader at all', async () => {
    expect((await readCurveCreateBuy(undefined, want, async () => TX)).kind).toBe('unreadable');
  });
});

describe('fetchBirthHint: our own endpoint, strict about its answer', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (body: unknown, status = 200) =>
    vi.fn(async () => ({ ok: status === 200, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) }));

  it('asks /api/aggregator for this rail, chain and token', async () => {
    const f = reply({ tx: TX, block: 1 });
    vi.stubGlobal('fetch', f);
    expect(await fetchBirthHint('curve', 4663, TOKEN)).toBe(TX);
    const url = new URL(String((f.mock.calls[0] as unknown[])[0]), 'https://memetics.finance');
    expect(url.pathname).toBe('/api/aggregator');
    expect(Object.fromEntries(url.searchParams)).toEqual({ resource: 'curve-birth', chain: '4663', token: TOKEN });
    vi.stubGlobal('fetch', reply({ tx: null, block: null }));
    expect(await fetchBirthHint('doppler', 1, TOKEN)).toBeNull();
  });

  it('throws on an error status, a non-JSON body and a malformed hash', async () => {
    for (const f of [reply({ error: 'x' }, 502), reply('<html>'), reply({ tx: '0x1234' }), reply({})]) {
      vi.stubGlobal('fetch', f);
      await expect(fetchBirthHint('curve', 1, TOKEN)).rejects.toThrow();
    }
  });
});

// ─────────────────────────────── Doppler's own logs ───────────────────────────────

const dEvent = <N extends 'VestingScheduleCreated' | 'VestingAllocated' | 'Transfer'>(name: N, args: Record<string, unknown>, address: Address = TOKEN): BirthLog => {
  const ev = DOPPLER_PLATES_ABI.find((x) => x.type === 'event' && x.name === name)!;
  const params = (ev.type === 'event' ? ev.inputs : []) as readonly { name?: string; type: string; indexed?: boolean }[];
  const data = params.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: DOPPLER_PLATES_ABI, eventName: name, args } as never) as Hex[],
    data: encodeAbiParameters(data, data.map((i) => args[i.name!]) as never),
  };
};
const E26 = 10n ** 26n;
const DAY = 86_400n;

/** The real birth's token logs, in order, plus the Airlock's own log as noise. */
function dopplerBirth(extra: BirthLog[] = [], schedule = { cliff: 0n, duration: DAY }): BirthReceipt {
  return receipt([
    dEvent('VestingScheduleCreated', { scheduleId: 0n, ...schedule }),
    dEvent('VestingAllocated', { beneficiary: MAKER, scheduleId: 0n, amount: 8n * E26 }),
    dEvent('Transfer', { from: ZERO, to: TOKEN, amount: 8n * E26 }),
    dEvent('Transfer', { from: ZERO, to: AIRLOCK, amount: 2n * E26 }),
    dEvent('Transfer', { from: AIRLOCK, to: OTHER, amount: 2n * E26 }),
    { address: AIRLOCK, topics: [toEventSelector('Create(address,address,address,address)')], data: '0x' },
    ...extra,
  ]);
}

describe("Doppler: the maker's allocation, schedule and create-buy from the birth receipt", () => {
  it('reads the real birth: 80% of a 1B supply to the sender, one schedule, nothing transferred to the maker', () => {
    const r = dopplerBirthFromReceipt(dopplerBirth(), TOKEN);
    expect(r).toEqual({
      kind: 'ok',
      value: {
        tx: TX,
        maker: MAKER,
        birthSupply: 10n * E26,
        makerAmount: 8n * E26,
        makerSchedules: [{ id: 0n, cliff: 0n, duration: DAY }],
        othersAmount: 0n,
        others: 0,
        toMaker: 0n,
      },
    });
  });

  it("counts another beneficiary apart from the maker, and a transfer to the maker as what it received", () => {
    const r = dopplerBirthFromReceipt(
      dopplerBirth([
        dEvent('VestingAllocated', { beneficiary: OTHER, scheduleId: 0n, amount: E26 }),
        dEvent('Transfer', { from: AIRLOCK, to: MAKER, amount: 3n * 10n ** 24n }),
      ]),
      TOKEN,
    );
    expect(r.kind === 'ok' && [r.value.makerAmount, r.value.othersAmount, r.value.others, r.value.toMaker]).toEqual([8n * E26, E26, 1, 3n * 10n ** 24n]);
  });

  it("ignores another contract's look-alike logs", () => {
    const r = dopplerBirthFromReceipt(
      dopplerBirth([
        dEvent('VestingAllocated', { beneficiary: MAKER, scheduleId: 0n, amount: 9n * E26 }, OTHER_TOKEN),
        dEvent('Transfer', { from: ZERO, to: MAKER, amount: 9n * E26 }, OTHER_TOKEN),
      ]),
      TOKEN,
    );
    expect(r.kind === 'ok' && [r.value.makerAmount, r.value.birthSupply, r.value.toMaker]).toEqual([8n * E26, 10n * E26, 0n]);
  });

  it('refuses a receipt with no allocation by this token, an unknown schedule, no mint, or a revert', () => {
    const own = dopplerBirth().logs;
    const [, allocated, mint] = own;
    const isMint = (l: BirthLog) => l.topics[0] === mint!.topics[0] && l.topics[1] === mint!.topics[1];
    const cases: [BirthReceipt, RegExp][] = [
      [receipt(own.filter((l) => l.topics[0] !== allocated!.topics[0])), /allocated nothing/],
      [receipt([dEvent('VestingAllocated', { beneficiary: MAKER, scheduleId: 7n, amount: E26 }), ...own]), /schedule/],
      [receipt(own.filter((l) => !isMint(l))), /supply at birth/],
      [{ ...dopplerBirth(), status: 'reverted' }, /did not succeed/],
    ];
    for (const [c, why] of cases) {
      const r = dopplerBirthFromReceipt(c, TOKEN);
      expect(r.kind === 'unreadable' && r.detail).toMatch(why);
    }
  });
});

describe('lockWindow: the dates come from the schedule', () => {
  it('nothing before start + cliff, all of it by start + duration', () => {
    expect(lockWindow(1_000n, [{ id: 0n, cliff: 90n * DAY, duration: 365n * DAY }])).toEqual({ cliffAt: 1_000n + 90n * DAY, endAt: 1_000n + 365n * DAY });
  });

  it('across two schedules: the earliest cliff and the latest end', () => {
    const w = lockWindow(0n, [
      { id: 0n, cliff: 30n, duration: 100n },
      { id: 1n, cliff: 10n, duration: 400n },
    ]);
    expect(w).toEqual({ cliffAt: 10n, endAt: 400n });
  });
});

describe('readDopplerPlates: two reads must agree before "none", and unread is never 0', () => {
  const START = 1_778_105_483n;
  function client(o: { receipt?: unknown; reads?: Record<string, unknown> } = {}) {
    return {
      getTransactionReceipt: vi.fn(async () => o.receipt ?? dopplerBirth()),
      readContract: vi.fn(async (args: { functionName: string; args?: unknown[] }) => {
        const v = o.reads?.[args.functionName];
        if (v instanceof Error || v === undefined) throw v ?? new Error(`no stub for ${args.functionName}`);
        return typeof v === 'function' ? (v as (a?: unknown[]) => unknown)(args.args) : v;
      }),
    };
  }

  it('reads the start and what was released for each of the maker\'s schedules', async () => {
    const c = client({ reads: { vestingStart: START, vestingOf: (a?: unknown[]) => [8n * E26, a?.[1] === 0n ? 5n * E26 : 0n] } });
    const p = await readDopplerPlates(c, TOKEN, async () => TX);
    expect(p.kind === 'read' && [p.vestingStart, p.released, p.birth.makerAmount]).toEqual([START, 5n * E26, 8n * E26]);
    expect(c.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'vestingOf', args: [MAKER, 0n] }));
  });

  it('a failed vestingOf read leaves "released" unread, not 0; a failed vestingStart leaves the dates unread', async () => {
    const p = await readDopplerPlates(client({ reads: { vestingStart: new Error('x'), vestingOf: new Error('y') } }), TOKEN, async () => TX);
    expect(p.kind === 'read' && [p.vestingStart, p.released]).toEqual([null, null]);
  });

  it('"none" only when our server found no allocation AND the token says vestedTotalAmount() is 0', async () => {
    expect(await readDopplerPlates(client({ reads: { vestedTotalAmount: 0n } }), TOKEN, async () => null)).toEqual({ kind: 'none' });
    expect((await readDopplerPlates(client({ reads: { vestedTotalAmount: E26 } }), TOKEN, async () => null)).kind).toBe('unreadable');
    expect((await readDopplerPlates(client({ reads: { vestedTotalAmount: new Error('revert') } }), TOKEN, async () => null)).kind).toBe('unreadable');
  });

  it('a failed lookup or receipt read is unreadable', async () => {
    expect((await readDopplerPlates(client(), TOKEN, async () => Promise.reject(new Error('502')))).kind).toBe('unreadable');
    const broken = { getTransactionReceipt: async () => Promise.reject(new Error('rpc')), readContract: async () => 0n };
    expect((await readDopplerPlates(broken, TOKEN, async () => TX)).kind).toBe('unreadable');
  });
});

describe('DOPPLER_PLATES_ABI is DopplerERC20V1 as the SDK ships it', () => {
  it('each event has the SDK ABI selector, and each getter its signature', () => {
    for (const item of DOPPLER_PLATES_ABI) {
      const sdk = dopplerERC20V1Abi.find((x) => x.type === item.type && 'name' in x && x.name === item.name);
      expect(sdk, `${item.name} is in the SDK's DopplerERC20V1 ABI`).toBeTruthy();
      if (item.type === 'event') expect(toEventSelector(item)).toBe(toEventSelector(sdk as never));
      else {
        expect(toFunctionSelector(item)).toBe(toFunctionSelector(sdk as never));
        expect((sdk as unknown as { outputs: { type: string }[] }).outputs.map((o) => o.type)).toEqual(item.outputs.map((o) => o.type));
      }
    }
  });
});
