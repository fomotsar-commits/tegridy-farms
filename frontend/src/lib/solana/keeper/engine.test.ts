// @vitest-environment node
//
// The engine's handovers as the robot reads them: a record is taken whole or not at all, stands
// 800 ms from its judgement, and arrives on an event stream that is cut into events as it comes.
import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { ENGINE_FRESH_MS, SseParser, engineEventsUrl, engineOutcomeUrl, enginePageUrl, engineRecord, engineStands, followEngine } from './engine';

const key = () => Keypair.generate().publicKey.toBase58();
const MINT = key();
const A = key();
const B = key();
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const row = (over: Record<string, unknown> = {}) => ({
  id: `${A}>${B}@100@1000`, at: 1000, slot: 100, expiresAt: 1800, coin: SOL_QUOTE.mint, mint: MINT, symbol: 'X​Y', decimals: 6,
  legs: [
    { pool: A, dex: 'ours', from: SOL_QUOTE.mint, to: MINT, fee: 0.003, inCut: 0, outCut: 0, accounts: [] },
    { pool: B, dex: 'dlmm', from: MINT, to: SOL_QUOTE.mint, fee: 0.001, inCut: 0, outCut: 0, accounts: [key(), key()] },
  ],
  inRaw: '1000000000', outs: ['2000000000', '1001000000'], netUsd: 0.05, netAllUsd: 0.03, tipUsd: 0.002, gapPct: 1.2,
  mints: { [MINT]: TOKEN_2022 }, usd: { [SOL_QUOTE.mint]: 90, [MINT]: 0.5 },
  ...over,
});

describe('engineRecord: one handover, whole or not at all', () => {
  it('takes a sound record: amounts as bigints, the prices as a map, the ticker stripped of hidden marks', () => {
    const r = engineRecord(row())!;
    expect(r).not.toBeNull();
    expect(r.inRaw).toBe(1_000_000_000n);
    expect(r.outs).toEqual([2_000_000_000n, 1_001_000_000n]);
    expect(r.route).toBe(`${A}>${B}`);
    expect(r.symbol).toBe('XY');
    expect(r.usd.get(SOL_QUOTE.mint)).toBe(90);
    expect(r.mints[MINT]).toBe(TOKEN_2022);
    expect(r.legs[1]!.accounts).toHaveLength(2);
    expect(r.coinMint).toBe(SOL_QUOTE.mint);
    expect(r.tokenMint).toBe(MINT);
  });
  it('takes three legs through a second coin, and a USDC trip', () => {
    const C = key();
    const legs = [
      { pool: A, dex: 'whirlpool', from: USDC_QUOTE.mint, to: SOL_QUOTE.mint, fee: 0.0004, accounts: [] },
      { pool: B, dex: 'pumpswap', from: SOL_QUOTE.mint, to: MINT, fee: 0.003, accounts: [] },
      { pool: C, dex: 'cpmm', from: MINT, to: USDC_QUOTE.mint, fee: 0.0025, accounts: [] },
    ];
    const r = engineRecord(row({ coin: USDC_QUOTE.mint, legs, outs: ['1', '2', '3'] }))!;
    expect(r).not.toBeNull();
    expect(r.legs.map((l) => l.inCut)).toEqual([0, 0, 0]);
  });
  it.each([
    ['a start coin the robot does not hold', { coin: MINT, mint: key() }],
    ['the robot’s own coin as the token', { mint: USDC_QUOTE.mint }],
    ['a broken chain', { legs: [{ pool: A, dex: 'ours', from: SOL_QUOTE.mint, to: MINT, fee: 0 }, { pool: B, dex: 'dlmm', from: key(), to: SOL_QUOTE.mint, fee: 0 }] }],
    ['a trip that does not come back to its coin', { legs: [{ pool: A, dex: 'ours', from: SOL_QUOTE.mint, to: MINT, fee: 0 }, { pool: B, dex: 'dlmm', from: MINT, to: USDC_QUOTE.mint, fee: 0 }] }],
    ['an exchange the robot does not know', { legs: [{ pool: A, dex: 'phoenix', from: SOL_QUOTE.mint, to: MINT, fee: 0 }, { pool: B, dex: 'dlmm', from: MINT, to: SOL_QUOTE.mint, fee: 0 }] }],
    ['one pool twice', { legs: [{ pool: A, dex: 'ours', from: SOL_QUOTE.mint, to: MINT, fee: 0 }, { pool: A, dex: 'dlmm', from: MINT, to: SOL_QUOTE.mint, fee: 0 }] }],
    ['four legs', { legs: Array.from({ length: 4 }, (_, i) => ({ pool: key(), dex: 'ours', from: i === 0 ? SOL_QUOTE.mint : MINT, to: i === 3 ? SOL_QUOTE.mint : MINT, fee: 0 })) }],
    ['no size', { inRaw: '0' }],
    ['a size that is not a whole number', { inRaw: '1.5' }],
    ['fewer pays than legs', { outs: ['1'] }],
    ['a pay of nothing', { outs: ['1', '0'] }],
    ['a fee of one or more', { legs: [{ pool: A, dex: 'ours', from: SOL_QUOTE.mint, to: MINT, fee: 1 }, { pool: B, dex: 'dlmm', from: MINT, to: SOL_QUOTE.mint, fee: 0 }] }],
    ['too many accounts on a leg', { legs: [{ pool: A, dex: 'ours', from: SOL_QUOTE.mint, to: MINT, fee: 0, accounts: Array.from({ length: 17 }, key) }, { pool: B, dex: 'dlmm', from: MINT, to: SOL_QUOTE.mint, fee: 0 }] }],
    ['an account that is not an address', { legs: [{ pool: A, dex: 'ours', from: SOL_QUOTE.mint, to: MINT, fee: 0, accounts: ['not-an-address'] }, { pool: B, dex: 'dlmm', from: MINT, to: SOL_QUOTE.mint, fee: 0 }] }],
    ['an end before its judgement', { expiresAt: 900 }],
    ['no id', { id: '' }],
  ])('refuses %s', (_what, over) => {
    expect(engineRecord(row(over))).toBeNull();
  });
  it('refuses what is not a record at all', () => {
    expect(engineRecord(null)).toBeNull();
    expect(engineRecord('x')).toBeNull();
    expect(engineRecord([])).toBeNull();
  });
});

describe('engineStands', () => {
  it('stands under ENGINE_FRESH_MS from the judgement and under its own end, whichever comes first', () => {
    const r = engineRecord(row())!;
    expect(engineStands(r, 1000)).toBe(true);
    expect(engineStands(r, 1000 + ENGINE_FRESH_MS - 1)).toBe(true);
    expect(engineStands(r, 1000 + ENGINE_FRESH_MS)).toBe(false);
    expect(engineStands(engineRecord(row({ expiresAt: 1500 }))!, 1500)).toBe(false);
    expect(engineStands(engineRecord(row({ expiresAt: 1500 }))!, 1499)).toBe(true);
  });
});

describe('the engine’s doors', () => {
  it('are on this computer only', () => {
    const page = enginePageUrl('http://127.0.0.1:8798/state.json');
    expect(engineEventsUrl(page).href).toBe('http://127.0.0.1:8798/events');
    expect(engineOutcomeUrl(page).href).toBe('http://127.0.0.1:8798/outcome');
    expect(() => enginePageUrl('https://engine.example/state.json')).toThrow(/KEEPER_ENGINE_URL/);
    expect(() => enginePageUrl('http://10.0.0.5:8798/state.json')).toThrow(/this computer/);
  });
});

describe('SseParser', () => {
  it('cuts a stream into events across chunk edges, skipping comments and joining data lines', () => {
    const p = new SseParser();
    expect(p.feed('retry: 1000\n\n: ping\n\nevent: handover\ndata: {"a":')).toEqual([]);
    expect(p.feed('1}\n\ndata: first\ndata: second\n\nevent: x\r\ndata: y\r\n\r\n')).toEqual([
      { event: 'handover', data: '{"a":1}' },
      { event: 'message', data: 'first\nsecond' },
      { event: 'x', data: 'y' },
    ]);
  });
});

/** A stream answer whose body yields `chunks` one read at a time, then ends. */
function stream(chunks: string[], ok = true) {
  const enc = new TextEncoder();
  let i = 0;
  const cancel = vi.fn(async () => {});
  return {
    answer: { ok, status: ok ? 200 : 503, body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]!), done: false } : { done: true }), cancel }) } },
    cancel,
  };
}

describe('followEngine', () => {
  it('hands over each record that parses, skips the rest, and stops when told', async () => {
    const good = JSON.stringify(row());
    const s = stream([`event: handover\ndata: ${good}\n\n`, `event: handover\ndata: {"junk":1}\n\nevent: handover\ndata: not json\n\n`, `event: handover\ndata: ${good}\n\n`]);
    const got: string[] = [];
    let stop = false;
    await followEngine({
      url: new URL('http://127.0.0.1:8798/events'),
      fetchImpl: async () => s.answer,
      onRecord: (r) => {
        got.push(r.route);
        if (got.length === 2) stop = true;
      },
      log: vi.fn(),
      stopped: () => stop,
      sleep: async () => {},
    });
    expect(got).toEqual([`${A}>${B}`, `${A}>${B}`]);
    expect(s.cancel).toHaveBeenCalled();
  });
  it('says once when the stream cannot be opened, waits, and tries again until stopped', async () => {
    const log = vi.fn();
    let tries = 0;
    const sleeps: number[] = [];
    await followEngine({
      url: new URL('http://127.0.0.1:8798/events'),
      fetchImpl: async () => {
        tries++;
        return stream([], false).answer;
      },
      onRecord: vi.fn(),
      log,
      stopped: () => sleeps.length >= 3,
      reopenMs: 2_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(tries).toBe(3);
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('answered 503'));
  });
  it('opens again after a stream ends', async () => {
    let opened = 0;
    const got: unknown[] = [];
    await followEngine({
      url: new URL('http://127.0.0.1:8798/events'),
      fetchImpl: async () => {
        opened++;
        return stream([`event: handover\ndata: ${JSON.stringify(row())}\n\n`]).answer;
      },
      onRecord: (r) => got.push(r),
      log: vi.fn(),
      stopped: () => got.length >= 2,
      sleep: async () => {},
    });
    expect(opened).toBe(2);
    expect(got).toHaveLength(2);
  });
});
