// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { rpcWithFallback } from '../../../../scripts/lib/rpc-fallback.mjs';
import { buildPool, key, viewOf } from '../lp/testkit.fixture';
import type { PoolView } from '../lp/poolFinder';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import type { JupiterApi } from './jupiterApi';

/**
 * The keeper's wallet read for a trip through our own pools: one RPC call, on a public RPC that
 * answers 429 when pressed. The pools' reserves alone say whether any size pays, so the wallet
 * is read only for a pair or loop that pays at some size. Pools priced by the program's maths.
 */

const NOW = 10_000_000n;
const SOL = 10n ** 9n;
const USDC = 10n ** 6n;

let pools: PoolView[] = [];
vi.mock('../lp/poolList', async (orig) => ({
  ...(await orig<typeof import('../lp/poolList')>()),
  listPools: vi.fn(async () => ({ kind: 'ok', list: { pools, chainNow: NOW } })),
  readMarketPrices: vi.fn(async () => ({ kind: 'ok', usd: new Map([[SOL_QUOTE.mint, 200], [USDC_QUOTE.mint, 1]]) })),
  arbitrage: vi.fn(() => null),
  rowTokenFee: vi.fn(() => null),
}));
vi.mock('../lp/tokenSafety', async (orig) => ({ ...(await orig<typeof import('../lp/tokenSafety')>()), readTokenSafety: vi.fn(async () => new Map()) }));
vi.mock('./plan', async (orig) => ({ ...(await orig<typeof import('./plan')>()), poolProblem: vi.fn(() => null) }));
vi.mock('./rule', async (orig) => ({ ...(await orig<typeof import('./rule')>()), tokenGate: vi.fn(() => null) }));

const { runCycle, DEFAULT_SETTINGS } = await import('./cycle');
const { DEFAULT_LIMITS } = await import('./plan');

const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, minProfitUsd: 0.01, allowRaydium: true, raydiumPrograms: [], outsidePools: [] };

function pool(mint: PublicKey, quote: typeof SOL_QUOTE, quoteReserve: bigint, tokenReserve: bigint): PoolView {
  return viewOf(buildPool({ mint, address: key(), quote, quoteReserve, tokenReserve }), { sol: quoteReserve, tok: tokenReserve });
}

/** A pass over `list` on a chain where the keeper holds nothing: every wallet read it makes. */
async function pass(list: PoolView[]) {
  pools = list;
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method !== 'getMultipleAccounts') throw new Error(`unexpected ${method}`);
    return { value: (params[0] as string[]).map(() => null) };
  });
  const log = vi.fn();
  const r = await runCycle({ rpc, jupiter: {} as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log }, settings);
  return { r, reads: rpc.mock.calls.length, lines: log.mock.calls.map((c) => String(c[0])) };
}

const token = key();
const usdcSol = pool(new PublicKey(USDC_QUOTE.mint), SOL_QUOTE, 50n * SOL, 10_000n * USDC);
const tokenSol = pool(token, SOL_QUOTE, 50n * SOL, 10n ** 9n);

describe('runCycle: the wallet read for trips through our own pools', () => {
  // KWIF's two SOL pools and TBB's loop on 2026-11-06: a wide gap into a pool holding dust.
  it('reads nothing when the gap is into a pool too empty for any size to pay', async () => {
    const kwif = key();
    const kwifMain = pool(kwif, SOL_QUOTE, 135_957_677n, 66_327_358_089n);
    const kwifDust = pool(kwif, SOL_QUOTE, 5n, 2_138n);
    const tokenUsdcDust = pool(token, USDC_QUOTE, 74n, 137n);
    const { r, reads, lines } = await pass([kwifMain, kwifDust, tokenSol, tokenUsdcDust, usdcSol]);
    expect(r.loops).toBe(2);
    expect(reads).toBe(0);
    expect(lines.filter((l) => /our pools/.test(l))).toEqual([]);
    expect(r.sent).toBe(0);
  });

  it('reads the wallet for a pair that pays at some size, and sizes the trip to what it holds', async () => {
    const mint = key();
    const { r, reads } = await pass([pool(mint, SOL_QUOTE, 50n * SOL, 10n ** 9n), pool(mint, SOL_QUOTE, 50n * SOL, 9n * 10n ** 8n)]);
    expect(reads).toBe(1);
    expect(r.sent).toBe(0);
  });

  it('reads the wallet for the way round a loop that pays, not the way that loses', async () => {
    const tokenUsdcDear = pool(token, USDC_QUOTE, 10_500n * USDC, 10n ** 9n);
    const { r, reads } = await pass([tokenSol, tokenUsdcDear, usdcSol]);
    expect(r.loops).toBe(2);
    expect(reads).toBe(1);
    expect(r.sent).toBe(0);
  });
});

describe('runCycle: a read the main RPC takes and never answers (the robot, 2026-11-16 01:52Z)', () => {
  const open: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((e) => e.close()));
  });
  /** A JSON-RPC endpoint on this computer: a chain where the keeper holds nothing, or one that takes each call and never answers. */
  async function endpoint(answers: boolean) {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (!answers) return;
        const call = JSON.parse(body) as { params: [string[]] };
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: call.params[0].map(() => null) } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const e = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };
    open.push(e);
    return e;
  }

  it('the pass reads from the next endpoint within the limit, and goes on', async () => {
    const stuck = await endpoint(false);
    const second = await endpoint(true);
    const line = rpcWithFallback({ urls: [stuck.url, second.url], answerMs: 300 });
    const mint = key();
    pools = [pool(mint, SOL_QUOTE, 50n * SOL, 10n ** 9n), pool(mint, SOL_QUOTE, 50n * SOL, 9n * 10n ** 8n)];
    const started = Date.now();
    const r = await runCycle({ rpc: line.call, jupiter: {} as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() }, settings);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(r.sent).toBe(0);
    // The wallet read: taken by the stuck one, given up at the limit, answered by the second.
    expect(line.counts).toMatchObject({ calls: 1, answeredByFallback: 1, busy: { [stuck.url]: 1, [second.url]: 0 } });
  }, 10_000);
});
