// The maker's plates on the Ethereum rails (island rulings 3 and 4), read from the launch's own
// transaction. Our server names that transaction (api/_lib/evm-birth.js) and its answer is only
// a HINT: this file reads the receipt on chain and keeps only logs it can check (from the curve
// launcher or the token itself, about this token, by its creator). A read that fails comes back
// as `unreadable` with a reason, never as 0. The words live in components/launcher/makerPlatesCopy.ts.

import { decodeEventLog, getAddress, parseAbi, toEventSelector, type Abi, type Address, type Hex } from 'viem';
import { CURVE_LAUNCHER_ABI } from './curve';

export type PlatesRead<T> = { kind: 'ok'; value: T } | { kind: 'unreadable'; detail: string };

const unreadable = (detail: string) => ({ kind: 'unreadable', detail }) as const;

export interface BirthLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export interface BirthReceipt {
  status: 'success' | 'reverted';
  from: Address;
  transactionHash: Hex;
  logs: readonly BirthLog[];
}

/** Minimal read surface; a viem PublicClient satisfies it, tests supply a fake. */
export interface PlatesReadClient {
  // `any` for the same contravariance reason as tokenDossier.ts's AirlockReadClient.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  getTransactionReceipt?(args: any): Promise<unknown>;
  readContract(args: any): Promise<unknown>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;

/** The receipt an RPC returned, if it has the shape this file reads. RPC answers are input. */
export function asBirthReceipt(raw: unknown): BirthReceipt | null {
  const r = raw as Partial<Record<keyof BirthReceipt, unknown>> | null;
  if (!r || typeof r !== 'object') return null;
  if (r.status !== 'success' && r.status !== 'reverted') return null;
  if (typeof r.from !== 'string' || !ADDRESS_RE.test(r.from)) return null;
  if (typeof r.transactionHash !== 'string' || !HASH_RE.test(r.transactionHash)) return null;
  if (!Array.isArray(r.logs)) return null;
  for (const l of r.logs as unknown[]) {
    const log = l as Partial<Record<keyof BirthLog, unknown>> | null;
    if (!log || typeof log.address !== 'string' || !ADDRESS_RE.test(log.address)) return null;
    if (typeof log.data !== 'string' || !HEX_RE.test(log.data)) return null;
    if (!Array.isArray(log.topics) || !log.topics.every((t) => typeof t === 'string' && HASH_RE.test(t))) return null;
  }
  return r as BirthReceipt;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** An address as the 32-byte topic it is indexed under. */
export const addressTopic = (a: Address): Hex => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const topicIs = (log: BirthLog, i: number, want: Hex) => typeof log.topics[i] === 'string' && same(log.topics[i]!, want);

function eventOf(abi: Abi, name: string) {
  const ev = abi.find((x) => x.type === 'event' && x.name === name);
  if (!ev || ev.type !== 'event') throw new Error(`no ${name} event in the ABI`);
  return { abi: [ev] as Abi, topic: toEventSelector(ev) };
}

/** The log's arguments, or null when it does not decode as that one event. */
function decodeAs(ev: { abi: Abi; topic: Hex }, log: BirthLog): Record<string, unknown> | null {
  if (!topicIs(log, 0, ev.topic)) return null;
  try {
    const d = decodeEventLog({ abi: ev.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    return d.args as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─────────────────────────────── the server's hint ───────────────────────────────

export const BIRTH_ENDPOINT = '/api/aggregator';
export type BirthHintFetch = (rail: 'curve' | 'doppler', chainId: number, token: Address) => Promise<Hex | null>;

/** The birth transaction our server names: a hash to check, `null` for "none in the history", or a throw. */
export const fetchBirthHint: BirthHintFetch = async (rail, chainId, token) => {
  const q = new URLSearchParams({ resource: rail === 'curve' ? 'curve-birth' : 'doppler-birth', chain: String(chainId), token });
  const res = await fetch(`${BIRTH_ENDPOINT}?${q}`);
  if (!res.ok) throw new Error(`the lookup answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { tx?: unknown } | null;
  if (body?.tx === null) return null;
  if (typeof body?.tx === 'string' && HASH_RE.test(body.tx)) return body.tx as Hex;
  throw new Error('the lookup answered without a transaction');
};

/** An error's first line, bounded: viem's messages run to a page of request body. */
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160);

type ReceiptRead = { kind: 'receipt'; receipt: BirthReceipt } | { kind: 'none' } | { kind: 'unreadable'; detail: string };

async function birthReceipt(
  client: PlatesReadClient | undefined | null,
  rail: 'curve' | 'doppler',
  chainId: number,
  token: Address,
  fetchHint: BirthHintFetch,
): Promise<ReceiptRead> {
  if (!client || typeof client.getTransactionReceipt !== 'function') return unreadable('no chain reader is available');
  let hash: Hex | null;
  try {
    hash = await fetchHint(rail, chainId, token);
  } catch (e) {
    return unreadable(`its launch transaction could not be looked up: ${why(e)}`);
  }
  if (hash === null) return { kind: 'none' };
  try {
    const receipt = asBirthReceipt(await client.getTransactionReceipt({ hash }));
    return receipt ? { kind: 'receipt', receipt } : unreadable('its launch transaction came back in a shape we cannot read');
  } catch (e) {
    return unreadable(`its launch transaction could not be read: ${why(e)}`);
  }
}

// ──────────────────────────── the Memetics Curve (/eth-curve) ────────────────────────────

const LAUNCH_CREATED = eventOf(CURVE_LAUNCHER_ABI as unknown as Abi, 'LaunchCreated');
const CURVE_BUY = eventOf(CURVE_LAUNCHER_ABI as unknown as Abi, 'CurveBuy');

export interface CurveCreateBuy {
  tx: Hex;
  creator: Address;
  /** Σ tokensOut of the creator's own CurveBuy logs in the launch transaction. */
  makerTokens: bigint;
  /** Σ tokensOut of every other buyer in that transaction (only a contract caller can make one). */
  othersTokens: bigint;
  others: number;
}

/**
 * The maker's create-buy from the launch receipt: exactly one LaunchCreated from the launcher
 * with topic1 = token and topic2 = creator, then the launcher's CurveBuy logs for this token.
 */
export function curveCreateBuyFromReceipt(
  receipt: BirthReceipt,
  want: { launcher: Address; token: Address; creator: Address },
): PlatesRead<CurveCreateBuy> {
  if (receipt.status !== 'success') return unreadable('its launch transaction did not succeed');
  const fromLauncher = receipt.logs.filter((l) => same(l.address, want.launcher));
  const created = fromLauncher.filter(
    (l) => topicIs(l, 1, addressTopic(want.token)) && topicIs(l, 2, addressTopic(want.creator)) && decodeAs(LAUNCH_CREATED, l) !== null,
  );
  if (created.length !== 1) return unreadable('the transaction we were pointed to does not create this token for its maker');

  let makerTokens = 0n;
  let othersTokens = 0n;
  const others = new Set<string>();
  for (const l of fromLauncher) {
    if (!topicIs(l, 1, addressTopic(want.token))) continue;
    const buy = decodeAs(CURVE_BUY, l);
    if (!buy || typeof buy.tokensOut !== 'bigint' || typeof buy.buyer !== 'string') continue;
    if (same(buy.buyer, want.creator)) makerTokens += buy.tokensOut;
    else {
      othersTokens += buy.tokensOut;
      others.add(buy.buyer.toLowerCase());
    }
  }
  return { kind: 'ok', value: { tx: receipt.transactionHash, creator: want.creator, makerTokens, othersTokens, others: others.size } };
}

/** Find, fetch and check the launch transaction. Not found yet is unreadable: the launch exists. */
export async function readCurveCreateBuy(
  client: PlatesReadClient | undefined | null,
  want: { chainId: number; launcher: Address; token: Address; creator: Address },
  fetchHint: BirthHintFetch = fetchBirthHint,
): Promise<PlatesRead<CurveCreateBuy>> {
  const r = await birthReceipt(client, 'curve', want.chainId, want.token, fetchHint);
  if (r.kind === 'unreadable') return r;
  if (r.kind === 'none') return unreadable('its launch transaction is not in the indexed history yet');
  return curveCreateBuyFromReceipt(r.receipt, want);
}

// ───────────────────────────────── Doppler (/launch) ─────────────────────────────────

/** DopplerERC20V1's own events and getters; birthPlates.test.ts pins each against the SDK's ABI. */
export const DOPPLER_PLATES_ABI = parseAbi([
  'event VestingScheduleCreated(uint256 indexed scheduleId, uint64 cliff, uint64 duration)',
  'event VestingAllocated(address indexed beneficiary, uint256 indexed scheduleId, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'function vestingStart() view returns (uint256)',
  'function vestedTotalAmount() view returns (uint256)',
  'function vestingOf(address beneficiary, uint256 scheduleId) view returns (uint256 totalAmount, uint256 releasedAmount)',
]);

const SCHEDULE_CREATED = eventOf(DOPPLER_PLATES_ABI as Abi, 'VestingScheduleCreated');
const VESTING_ALLOCATED = eventOf(DOPPLER_PLATES_ABI as Abi, 'VestingAllocated');
const TRANSFER = eventOf(DOPPLER_PLATES_ABI as Abi, 'Transfer');
const ZERO_TOPIC = addressTopic('0x0000000000000000000000000000000000000000');

export interface VestingPlate {
  id: bigint;
  /** Seconds after vestingStart: nothing is releasable before it. */
  cliff: bigint;
  /** Seconds after vestingStart: everything is releasable from then. */
  duration: bigint;
}

export interface DopplerBirth {
  tx: Hex;
  /** The wallet that sent the launch transaction: the best "maker" the chain gives. */
  maker: Address;
  /** Σ the token's mints (Transfer from 0) in that transaction: the whole supply at birth. */
  birthSupply: bigint;
  makerAmount: bigint;
  makerSchedules: readonly VestingPlate[];
  othersAmount: bigint;
  others: number;
  /** Σ the token's Transfer logs to the maker in that transaction (a create-buy would land here). */
  toMaker: bigint;
}

/** The maker's allocation, its schedules and anything else it received, from the birth receipt. */
export function dopplerBirthFromReceipt(receipt: BirthReceipt, token: Address): PlatesRead<DopplerBirth> {
  if (receipt.status !== 'success') return unreadable('its launch transaction did not succeed');
  const own = receipt.logs.filter((l) => same(l.address, token));
  const schedules = new Map<bigint, { cliff: bigint; duration: bigint }>();
  for (const l of own) {
    const s = decodeAs(SCHEDULE_CREATED, l);
    if (s && typeof s.scheduleId === 'bigint' && typeof s.cliff === 'bigint' && typeof s.duration === 'bigint') {
      schedules.set(s.scheduleId, { cliff: s.cliff, duration: s.duration });
    }
  }
  const allocations = own.flatMap((l) => {
    const a = decodeAs(VESTING_ALLOCATED, l);
    return a && typeof a.beneficiary === 'string' && typeof a.scheduleId === 'bigint' && typeof a.amount === 'bigint'
      ? [{ beneficiary: a.beneficiary as Address, scheduleId: a.scheduleId, amount: a.amount }]
      : [];
  });
  if (allocations.length === 0) return unreadable('the transaction we were pointed to allocated nothing from this token');
  if (allocations.some((a) => !schedules.has(a.scheduleId))) {
    return unreadable('an allocation names a vesting schedule its transaction did not create');
  }

  let birthSupply = 0n;
  let toMaker = 0n;
  const maker = getAddress(receipt.from.toLowerCase());
  for (const l of own) {
    const t = decodeAs(TRANSFER, l);
    if (!t || typeof t.amount !== 'bigint') continue;
    if (topicIs(l, 1, ZERO_TOPIC)) birthSupply += t.amount;
    if (topicIs(l, 2, addressTopic(maker))) toMaker += t.amount;
  }
  if (birthSupply === 0n) return unreadable('the supply at birth could not be read from its launch transaction');

  let makerAmount = 0n;
  let othersAmount = 0n;
  const ids = new Set<bigint>();
  const others = new Set<string>();
  for (const a of allocations) {
    if (same(a.beneficiary, maker)) {
      makerAmount += a.amount;
      ids.add(a.scheduleId);
    } else {
      othersAmount += a.amount;
      others.add(a.beneficiary.toLowerCase());
    }
  }
  const makerSchedules = [...ids].map((id) => ({ id, ...schedules.get(id)! }));
  return {
    kind: 'ok',
    value: { tx: receipt.transactionHash, maker, birthSupply, makerAmount, makerSchedules, othersAmount, others: others.size, toMaker },
  };
}

/** When the maker's plates unlock: nothing before the earliest cliff, all of it by the latest end. */
export function lockWindow(vestingStart: bigint, plates: readonly VestingPlate[]): { cliffAt: bigint; endAt: bigint } | null {
  if (plates.length === 0) return null;
  const cliffs = plates.map((p) => vestingStart + p.cliff);
  const ends = plates.map((p) => vestingStart + p.duration);
  return { cliffAt: cliffs.reduce((a, b) => (b < a ? b : a)), endAt: ends.reduce((a, b) => (b > a ? b : a)) };
}

export type DopplerPlates =
  | { kind: 'none' }
  | { kind: 'read'; birth: DopplerBirth; vestingStart: bigint | null; released: bigint | null }
  | { kind: 'unreadable'; detail: string };

async function readBigint(client: PlatesReadClient, token: Address, functionName: string, args?: readonly unknown[]) {
  const v = await client.readContract({ address: token, abi: DOPPLER_PLATES_ABI, functionName, args });
  if (typeof v !== 'bigint') throw new Error(`${functionName} did not return a number`);
  return v;
}

/**
 * The maker's allocation and its lock. "None" needs two reads that agree: our server found no
 * VestingAllocated in the token's history AND the token says vestedTotalAmount() is 0.
 */
export async function readDopplerPlates(
  client: PlatesReadClient | undefined | null,
  token: Address,
  fetchHint: BirthHintFetch = fetchBirthHint,
): Promise<DopplerPlates> {
  const r = await birthReceipt(client, 'doppler', 1, token, fetchHint);
  if (r.kind === 'unreadable') return r;
  if (r.kind === 'none') {
    try {
      const vested = await readBigint(client!, token, 'vestedTotalAmount');
      return vested === 0n
        ? { kind: 'none' }
        : unreadable('the token says it allocated tokens at birth, but its launch transaction was not found');
    } catch (e) {
      return unreadable(`could not read whether this token allocated anything at birth: ${why(e)}`);
    }
  }
  const birth = dopplerBirthFromReceipt(r.receipt, token);
  if (birth.kind === 'unreadable') return birth;
  const b = birth.value;
  if (b.makerSchedules.length === 0) return { kind: 'read', birth: b, vestingStart: null, released: null };

  const [start, ...vested] = await Promise.allSettled([
    readBigint(client!, token, 'vestingStart'),
    ...b.makerSchedules.map((s) => client!.readContract({ address: token, abi: DOPPLER_PLATES_ABI, functionName: 'vestingOf', args: [b.maker, s.id] })),
  ]);
  let released: bigint | null = 0n;
  for (const v of vested) {
    const pair = v.status === 'fulfilled' ? v.value : null;
    if (!Array.isArray(pair) || typeof pair[1] !== 'bigint' || released === null) released = null;
    else released += pair[1];
  }
  return { kind: 'read', birth: b, vestingStart: start!.status === 'fulfilled' ? start!.value : null, released };
}
