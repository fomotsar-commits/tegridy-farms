// @vitest-environment node
//
// The one transaction reader the ledger and the pool past share: a page of signatures,
// a page of transactions, a parse that throws on any shape it did not expect, and a
// memory cache that keeps only what the chain has finalized. The fixtures under
// __fixtures__/mainnet-history are the venue's real history (see its README).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IX_DEPOSIT, IX_INITIALIZE } from '../cpswap/program';
import {
  HISTORY_PAGE, HISTORY_PAGES_MAX, TX_CACHE_MAX, cached, parseTx, readSignatures, readTransactions, remember, tokenDelta, type ParsedTx, type SigEntry,
} from './txHistory';
import { PROGRAM, fakeRpcWithHistory, key, txJson } from './testkit.fixture';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(HERE, '__fixtures__', 'mainnet-history', name), 'utf8'));
const k = () => key().toBase58();
const POOL_PROGRAM = PROGRAM.toBase58();
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const entry = (signature: string, over: Partial<SigEntry> = {}): SigEntry => ({ signature, slot: 1, blockTime: null, err: null, confirmationStatus: 'finalized', ...over });
/** A signature unique to this file and test: the cache is module state. The `x` keeps `tag1` and `tag11` apart under the padding. */
const sig = (tag: string, i: number) => `${tag}${i}x`.padEnd(88, '1');
const GET_TX_CONFIG = { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };

/** The raw shape as the tests reach into it to break one field. */
interface Loose {
  version: unknown;
  slot: unknown;
  meta: Record<string, unknown> & { postTokenBalances: { uiTokenAmount: Record<string, unknown> }[]; preBalances: number[] };
  transaction: { message: { instructions: Record<string, unknown>[]; accountKeys: string[] } };
}

/** A small deposit-shaped transaction: two keys, the program, one instruction, one balance. */
function simple(over: Partial<Parameters<typeof txJson>[0]> = {}) {
  const a = k();
  const raw = txJson({
    keys: [a, POOL_PROGRAM],
    instructions: [{ program: POOL_PROGRAM, accounts: [a], data: Uint8Array.from([1, 2, 3]) }],
    balances: [{ account: a, mint: k(), owner: a, pre: 1n, post: 2n }],
    slot: 7,
    blockTime: 1_791_000_000,
    ...over,
  }) as Loose;
  return { a, raw };
}

describe('readSignatures', () => {
  it('asks for one page at confirmed, newest first, and says more only at the page size', async () => {
    const addr = k();
    const calls: [string, unknown[]][] = [];
    const list = Array.from({ length: 25 }, (_, i) => entry(sig('page', i), { slot: 100 - i }));
    const rpc = fakeRpcWithHistory({}, { [addr]: list }, {}, { calls });
    const first = await readSignatures(rpc, addr, {});
    expect(first.entries.map((e) => e.signature)).toEqual(list.slice(0, 20).map((e) => e.signature));
    expect(first.more).toBe(true);
    expect(calls[0]).toEqual(['getSignaturesForAddress', [addr, { limit: HISTORY_PAGE, commitment: 'confirmed' }]]);
    const second = await readSignatures(rpc, addr, { before: first.entries[19]!.signature });
    expect(second.entries.map((e) => e.slot)).toEqual([80, 79, 78, 77, 76]);
    expect(second.more).toBe(false);
    expect(calls[1]).toEqual(['getSignaturesForAddress', [addr, { limit: HISTORY_PAGE, before: sig('page', 19), commitment: 'confirmed' }]]);
  });

  it('exactly a page is "more", one short is not, and an empty history is an empty page', async () => {
    const full = k();
    const short = k();
    const none = k();
    const rpc = fakeRpcWithHistory({}, {
      [full]: Array.from({ length: 20 }, (_, i) => entry(sig('full', i))),
      [short]: Array.from({ length: 19 }, (_, i) => entry(sig('short', i))),
      [none]: [],
    }, {});
    expect((await readSignatures(rpc, full, {})).more).toBe(true);
    expect((await readSignatures(rpc, short, {})).more).toBe(false);
    expect(await readSignatures(rpc, none, {})).toEqual({ entries: [], more: false });
  });

  it('carries confirmed and processed entries as they are, with their status, slot and blockTime', async () => {
    const addr = k();
    const rpc = fakeRpcWithHistory({}, { [addr]: [entry(sig('st', 0), { confirmationStatus: 'confirmed', blockTime: 5 }), entry(sig('st', 1), { confirmationStatus: 'processed', slot: 3 })] }, {});
    const { entries } = await readSignatures(rpc, addr, {});
    expect(entries).toEqual([
      { signature: sig('st', 0), slot: 1, blockTime: 5, err: null, confirmationStatus: 'confirmed' },
      { signature: sig('st', 1), slot: 3, blockTime: null, err: null, confirmationStatus: 'processed' },
    ]);
  });

  it('a malformed entry or list throws; it is never a shorter list', async () => {
    const addr = k();
    const bad = async (answer: unknown) => {
      const rpc: SolanaRpc = async () => answer;
      await expect(readSignatures(rpc, addr, {})).rejects.toThrow();
    };
    await bad({ not: 'a list' });
    await bad([{ slot: 1, err: null }]);
    await bad([{ signature: sig('bad', 0), slot: '1', err: null }]);
    await bad([{ signature: sig('bad', 1), slot: 1, err: null, confirmationStatus: 'weird' }]);
    await bad([{ signature: sig('bad', 2), slot: 1 }]);
    await bad(Array.from({ length: 21 }, (_, i) => entry(sig('over', i))));
  });

  it('the kit keeps "no history" apart from "not configured": an unlisted address throws', async () => {
    const listed = k();
    const rpc = fakeRpcWithHistory({}, { [listed]: [] }, {});
    expect(await readSignatures(rpc, listed, {})).toEqual({ entries: [], more: false });
    await expect(readSignatures(rpc, k(), {})).rejects.toThrow(/no history configured/);
  });

  it('the budget: 20 a page, 5 pages a session', () => {
    expect(HISTORY_PAGE).toBe(20);
    expect(HISTORY_PAGES_MAX * HISTORY_PAGE).toBe(100);
  });
});

describe('readTransactions', () => {
  it('asks one page of getTransaction at confirmed with version 0 allowed; null is "no record", a real answer', async () => {
    const calls: [string, unknown[]][] = [];
    const { raw } = simple();
    const has = sig('rt', 0);
    const gone = sig('rt', 1);
    const rpc = fakeRpcWithHistory({}, {}, { [has]: raw, [gone]: null }, { calls });
    const map = await readTransactions(rpc, [entry(has), entry(gone)]);
    expect(map.size).toBe(2);
    expect(map.get(has)?.slot).toBe(7);
    expect(map.get(gone)).toBeNull();
    expect(calls).toEqual([
      ['getTransaction', [has, GET_TX_CONFIG]],
      ['getTransaction', [gone, GET_TX_CONFIG]],
    ]);
  });

  it('an empty page asks nothing', async () => {
    const calls: [string, unknown[]][] = [];
    const map = await readTransactions(fakeRpcWithHistory({}, {}, {}, { calls }), []);
    expect(map.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('more than a page is refused before any call; a signature the node never answers throws', async () => {
    const calls: [string, unknown[]][] = [];
    const rpc = fakeRpcWithHistory({}, {}, {}, { calls });
    await expect(readTransactions(rpc, Array.from({ length: 21 }, (_, i) => entry(sig('big', i))))).rejects.toThrow(/20/);
    expect(calls).toEqual([]);
    await expect(readTransactions(rpc, [entry(sig('unk', 0))])).rejects.toThrow(/no transaction configured/);
  });

  it('one malformed transaction fails the whole page: the caller shows unread', async () => {
    const { raw } = simple();
    const good = sig('mal', 0);
    const junk = sig('mal', 1);
    const rpc = fakeRpcWithHistory({}, {}, { [good]: raw, [junk]: { transaction: { message: { accountKeys: 'not a list' } } } }, {});
    await expect(readTransactions(rpc, [entry(good), entry(junk)])).rejects.toThrow();
  });

  // A page is 20 calls at once. When the proxy turned one away, nothing that did answer was kept,
  // so the next press sent all 20 again and could fail the same way for ever.
  it('a refused call fails the page only after every call has settled, and each finalized answer is kept for the next read', async () => {
    const { raw } = simple();
    const [first, refused, slow, notFinal] = [sig('keep', 0), sig('keep', 1), sig('keep', 2), sig('keep', 3)];
    let release: () => void = () => {};
    const waited = new Promise<void>((resolve) => { release = resolve; });
    const rpc: SolanaRpc = async (_method, params) => {
      const [signature] = params as [string];
      if (signature === refused) throw new Error('getTransaction: HTTP 429');
      // Answers AFTER the refusal: a reader that gave up at the first failure would never keep it.
      if (signature === slow) await waited;
      return raw;
    };
    const page = readTransactions(rpc, [entry(first), entry(refused), entry(slow), entry(notFinal, { confirmationStatus: 'confirmed' })]);
    let settled = false;
    void page.catch(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    release();
    await expect(page).rejects.toThrow('getTransaction: HTTP 429');
    expect(cached<ParsedTx>(first)?.slot).toBe(7);
    expect(cached<ParsedTx>(slow)?.slot).toBe(7);
    // Never the refused one, and never one the chain has not finalized.
    expect(cached(refused)).toBeUndefined();
    expect(cached(notFinal)).toBeUndefined();
  });
});

describe('parseTx', () => {
  it('a malformed uiTokenAmount throws', () => {
    const { raw } = simple();
    expect(parseTx('s', raw).post[0]!.amount).toBe(2n);
    raw.meta.postTokenBalances[0]!.uiTokenAmount.amount = '12.5';
    expect(() => parseTx('s', raw)).toThrow();
    raw.meta.postTokenBalances[0]!.uiTokenAmount.amount = 12;
    expect(() => parseTx('s', raw)).toThrow();
    raw.meta.postTokenBalances[0]!.uiTokenAmount.amount = '-5';
    expect(() => parseTx('s', raw)).toThrow();
    delete raw.meta.postTokenBalances[0]!.uiTokenAmount.amount;
    expect(() => parseTx('s', raw)).toThrow();
  });

  it('a meta with no token balances parses to empty pre and post; the caller says unread, never 0', () => {
    const { raw } = simple();
    delete raw.meta.preTokenBalances;
    raw.meta.postTokenBalances = null as unknown as Loose['meta']['postTokenBalances'];
    const p = parseTx('s', raw);
    expect([p.pre, p.post]).toEqual([[], []]);
  });

  it('a v0 transaction appends loaded addresses, writable then readonly, and an instruction may name them', () => {
    const [a, b, w, r] = [k(), k(), k(), k()];
    const raw = txJson({
      keys: [a, b, POOL_PROGRAM],
      loaded: { writable: [w], readonly: [r] },
      instructions: [{ program: POOL_PROGRAM, accounts: [a, w, r], data: Uint8Array.from([9]) }],
      balances: [{ account: w, mint: k(), pre: null, post: 4n }],
      lamports: [{ account: r, pre: 1, post: 2 }],
      slot: 1,
      blockTime: null,
    }) as Loose;
    expect(raw.version).toBe(0);
    const p = parseTx('s', raw);
    expect(p.keys).toEqual([a, b, POOL_PROGRAM, w, r]);
    expect(p.instructions[0]!.accounts).toEqual([a, w, r]);
    expect(p.post).toEqual([{ accountIndex: 3, mint: expect.any(String), owner: null, amount: 4n }]);
    expect([p.preLamports, p.postLamports]).toEqual([[0, 0, 0, 0, 1], [0, 0, 0, 0, 2]]);
  });

  it('a legacy transaction has no loadedAddresses member at all, and parses', () => {
    const { a, raw } = simple();
    expect(raw.version).toBe('legacy');
    expect('loadedAddresses' in raw.meta).toBe(false);
    expect(parseTx('s', raw).keys).toEqual([a, POOL_PROGRAM]);
  });

  it('signers are the first numRequiredSignatures keys', () => {
    const keys = [k(), k(), k(), k()];
    const raw = txJson({ keys, numSigners: 2, instructions: [], balances: [], slot: 1, blockTime: null });
    expect(parseTx('s', raw).signers).toEqual(keys.slice(0, 2));
    const { a, raw: one } = simple();
    expect(parseTx('s', one).signers).toEqual([a]);
  });

  it('inner instructions decode like top-level ones and are kept apart from them', () => {
    const [a, b] = [k(), k()];
    const raw = txJson({
      keys: [a, b, POOL_PROGRAM, TOKEN],
      instructions: [{ program: POOL_PROGRAM, accounts: [a, b], data: IX_DEPOSIT }],
      inner: [{ index: 0, instructions: [{ program: TOKEN, accounts: [a, b], data: Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) }] }],
      balances: [],
      slot: 1,
      blockTime: null,
    });
    const p = parseTx('s', raw);
    expect(p.instructions).toEqual([{ programId: POOL_PROGRAM, accounts: [a, b], data: IX_DEPOSIT }]);
    expect(p.inner).toEqual([{ programId: TOKEN, accounts: [a, b], data: Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) }]);
  });

  it('instruction data round-trips through base58, leading zero bytes included', () => {
    const a = k();
    for (const bytes of [[0, 0, 7, 255], [0], [255, 255, 255, 255, 255], []]) {
      const raw = txJson({ keys: [a, POOL_PROGRAM], instructions: [{ program: POOL_PROGRAM, accounts: [], data: Uint8Array.from(bytes) }], balances: [], slot: 1, blockTime: null });
      expect(Array.from(parseTx('s', raw).instructions[0]!.data)).toEqual(bytes);
    }
  });

  it('an index outside the keys, a bad base58 character, a missing err or a short lamports list throws', () => {
    const { raw } = simple();
    raw.transaction.message.instructions[0]!.programIdIndex = 99;
    expect(() => parseTx('s', raw)).toThrow();
    const two = simple().raw;
    two.transaction.message.instructions[0]!.data = '0OIl';
    expect(() => parseTx('s', two)).toThrow();
    const three = simple().raw;
    delete three.meta.err;
    expect(() => parseTx('s', three)).toThrow();
    const four = simple().raw;
    four.meta.preBalances.pop();
    expect(() => parseTx('s', four)).toThrow();
    const five = simple().raw;
    five.slot = '7';
    expect(() => parseTx('s', five)).toThrow();
    expect(() => parseTx('s', null)).toThrow();
    expect(() => parseTx('s', { slot: 1 })).toThrow();
  });

  it('err, slot, blockTime and the signature are carried', () => {
    const failed = { InstructionError: [2, { Custom: 6001 }] };
    const { raw } = simple({ err: failed, slot: 11, blockTime: null });
    const p = parseTx(sig('carry', 0), raw);
    expect([p.signature, p.slot, p.blockTime, p.err]).toEqual([sig('carry', 0), 11, null, failed]);
  });
});

describe('tokenDelta', () => {
  it('post minus pre by the account index; a side absent is 0; two accounts of one owner stay apart', () => {
    const [a, b, c, owner, mint] = [k(), k(), k(), k(), k()];
    const raw = txJson({
      keys: [a, b, c, POOL_PROGRAM],
      instructions: [],
      balances: [
        { account: a, mint, owner, pre: null, post: 5n },
        { account: b, mint, owner, pre: 7n, post: null },
        { account: c, mint, owner, pre: 10n, post: 13n },
      ],
      slot: 1,
      blockTime: null,
    });
    const tx = parseTx('s', raw);
    expect(tokenDelta(tx, a)).toBe(5n);
    expect(tokenDelta(tx, b)).toBe(-7n);
    expect(tokenDelta(tx, c)).toBe(3n);
    // Named by the transaction and on neither side, or not named at all: it did not move.
    expect(tokenDelta(tx, POOL_PROGRAM)).toBe(0n);
    expect(tokenDelta(tx, k())).toBe(0n);
  });
});

describe('the cache', () => {
  it('a finalized entry is remembered; a confirmed one is read and not kept', async () => {
    const [fin, conf, proc, none] = [sig('c', 0), sig('c', 1), sig('c', 2), sig('c', 3)];
    remember(entry(fin), 'kept');
    remember(entry(conf, { confirmationStatus: 'confirmed' }), 'not yet');
    remember(entry(proc, { confirmationStatus: 'processed' }), 'not yet');
    remember(entry(none, { confirmationStatus: null }), 'not yet');
    expect(cached<string>(fin)).toBe('kept');
    expect([cached(conf), cached(proc), cached(none)]).toEqual([undefined, undefined, undefined]);
    // Not cached is not "not read": the confirmed entry's transaction is still read.
    const { raw } = simple();
    const map = await readTransactions(fakeRpcWithHistory({}, {}, { [conf]: raw }, {}), [entry(conf, { confirmationStatus: 'confirmed' })]);
    expect(map.get(conf)?.slot).toBe(7);
  });

  it('the oldest entry leaves past 2,000', () => {
    for (let i = 0; i < TX_CACHE_MAX; i++) remember(entry(sig('evict', i)), i);
    expect(cached<number>(sig('evict', 0))).toBe(0);
    remember(entry(sig('evict', TX_CACHE_MAX)), TX_CACHE_MAX);
    expect(cached(sig('evict', 0))).toBeUndefined();
    expect(cached<number>(sig('evict', 1))).toBe(1);
    expect(cached<number>(sig('evict', TX_CACHE_MAX))).toBe(TX_CACHE_MAX);
    expect(TX_CACHE_MAX).toBe(2_000);
  });
});

describe('the venue history on mainnet, read 2026-10-04 (fixtures)', () => {
  const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
  const OWNER = '6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY';
  const OWNER_BAYLA_ACCOUNT = '6QraM9GKd3nTyHqvLRtorXgwwXuAVuBEE9EWbgrePgxM';
  const OWNER_LP_ACCOUNT = 'D2CYpjwm38TbHfwdLFw9Eh9hcxoUAMXJdWn33e7YEb93';
  const WSOL_VAULT = '4HjxickXVJ98vdosH9idfKfsombYrk2nNbWZETS8PjVN';
  const BAYLA_VAULT = '8YBj4RCdDKKs4MG6Ck9A3TSciRRocASr12ie7EsxLTe';
  interface Row { signature: string; slot: number; blockTime: number | null; err: unknown; tx: { version: unknown; transaction: { message: { accountKeys: string[] } } } }
  const rows = fixture('pool.baylaSol.transactions.json') as Row[];
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

  it('all eight pool transactions parse: one cp-swap instruction each, legacy, succeeded, balances on both sides', () => {
    expect(rows).toHaveLength(8);
    const kinds: string[] = [];
    for (const row of rows) {
      const p = parseTx(row.signature, row.tx);
      const cp = p.instructions.filter((ix) => ix.programId === POOL_PROGRAM);
      expect(cp, row.signature).toHaveLength(1);
      const disc = cp[0]!.data.subarray(0, 8);
      kinds.push(same(disc, IX_DEPOSIT) ? 'deposit' : same(disc, IX_INITIALIZE) ? 'initialize' : 'other');
      expect(p.err).toBeNull();
      expect(row.tx.version).toBe('legacy');
      expect(p.keys).toEqual(row.tx.transaction.message.accountKeys);
      expect(p.signers).toHaveLength(1);
      expect(p.pre.length).toBeGreaterThan(0);
      expect(p.post.length).toBeGreaterThan(0);
      expect(p.preLamports).toHaveLength(p.keys.length);
      expect([p.slot, p.blockTime]).toEqual([row.slot, row.blockTime]);
    }
    // Newest first: seven deposits, then the initialize that opened the pool.
    expect(kinds).toEqual([...Array<string>(7).fill('deposit'), 'initialize']);
  });

  it("the owner's deposit reads to the base unit: 990,099 lamports and 217,573,519 BAYLA in, 14,677,170 LP out", () => {
    const [row] = fixture('owner.lp.D2CYpj.transactions.json') as Row[];
    const tx: ParsedTx = parseTx(row!.signature, row!.tx);
    expect(tx.signers).toEqual([OWNER]);
    expect(tokenDelta(tx, WSOL_VAULT)).toBe(990_099n);
    expect(tokenDelta(tx, BAYLA_VAULT)).toBe(217_573_519n);
    expect(tokenDelta(tx, OWNER_BAYLA_ACCOUNT)).toBe(-217_573_519n);
    expect(tokenDelta(tx, OWNER_LP_ACCOUNT)).toBe(14_677_170n);
    // The wallet's own SOL: the deposit, the fee and the rent it paid, as one lamport delta.
    expect(tx.preLamports[0]! - tx.postLamports[0]!).toBe(2_483_539);
  });

  it('the fixtures play through the kit: one signature page, then eight transactions, every entry finalized', async () => {
    const sigs = fixture('pool.baylaSol.signatures.json') as SigEntry[];
    const txs = Object.fromEntries(rows.map((r) => [r.signature, r.tx]));
    const calls: [string, unknown[]][] = [];
    const rpc = fakeRpcWithHistory({}, { [POOL]: sigs }, txs, { calls });
    const page = await readSignatures(rpc, POOL, {});
    expect(page.more).toBe(false);
    expect(page.entries.map((e) => e.confirmationStatus)).toEqual(Array<string>(8).fill('finalized'));
    const map = await readTransactions(rpc, page.entries);
    expect(map.size).toBe(8);
    expect([...map.values()].every((t) => t !== null)).toBe(true);
    expect(calls.map(([m]) => m)).toEqual(['getSignaturesForAddress', ...Array<string>(8).fill('getTransaction')]);
  });
});
