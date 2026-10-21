// @vitest-environment node
// PDA derivation needs the Node realm (see cpswap/program.test.ts); this file also reads the
// recorded swaps off disk.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';

import { quoteSwapAsRaydium } from './quote';
import { decodeAmmConfig, decodeBitmapExtension, decodePoolState, decodeTickArray, deriveTickArray, type TickArrayView } from './program';

/**
 * REAL SWAPS, REPLAYED.
 *
 * __fixtures__/mainnet-swaps.json (scripts/record-clmm-swap-replay.mjs) holds swaps that ran
 * on the live range program whose code the venue's copy shares, each with the pool, its fee
 * tier, its far-band map and the bands near its price exactly as they stood in the slot
 * before, with no other write in between. Fed what the swap was asked (amount, direction,
 * exact in or out, price limit) and when it ran, the quote must land on what the program's
 * event says it did: both amounts, the fee, and the pool's price, tick and liquidity after.
 */

interface RecordedSwap {
  pool: string;
  readSlot: number;
  accounts: Record<string, { kind: string; owner: string; lamports: number; gz: string }>;
  tx: { signature: string; slot: number; blockTime: number; kind: 'swap' | 'swap_v2'; data: string; accounts: string[]; zeroForOne: boolean; event: string };
}

const REC = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', 'mainnet-swaps.json'), 'utf8')) as { program: string; swaps: RecordedSwap[] };
const PROGRAM = new PublicKey(REC.program);

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u128 = (d: DataView, o: number) => d.getBigUint64(o, true) | (d.getBigUint64(o + 8, true) << 64n);

/** swap.rs / swap_v2.rs args: amount, other_amount_threshold, sqrt_price_limit_x64, is_base_input. */
function args(b: Uint8Array) {
  const d = view(b);
  return { amount: d.getBigUint64(8, true), threshold: d.getBigUint64(16, true), limit: u128(d, 24), isBaseInput: b[40] === 1 };
}

/** pool.rs `SwapEvent`, after its 8-byte discriminator. */
function event(b: Uint8Array) {
  const d = view(b);
  return {
    amount0: d.getBigUint64(136, true), transferFee0: d.getBigUint64(144, true),
    amount1: d.getBigUint64(152, true), transferFee1: d.getBigUint64(160, true),
    zeroForOne: b[168] === 1, sqrtPriceX64: u128(d, 169), liquidity: u128(d, 185), tick: d.getInt32(201, true),
    tradeFees: b.length >= 221 ? [d.getBigUint64(205, true), d.getBigUint64(213, true)] : null,
  };
}

const bytes = (gz: string) => Uint8Array.from(gunzipSync(Buffer.from(gz, 'base64')));

describe('the recording', () => {
  it('holds real swaps across fee kinds: dynamic fee or not, fees in either coin only, spacing 1 to 60', () => {
    expect(REC.swaps.length).toBeGreaterThanOrEqual(20);
    expect(new Set(REC.swaps.map((s) => s.pool)).size).toBeGreaterThanOrEqual(5);
    const pools = REC.swaps.map((s) => decodePoolState(s.pool, bytes(s.accounts[s.pool]!.gz))!);
    expect(pools.some((p) => p.dynamicFeeInfo)).toBe(true);
    expect(pools.some((p) => !p.dynamicFeeInfo)).toBe(true);
    expect(new Set(pools.map((p) => p.feeOn))).toEqual(new Set([0, 1, 2]));
    for (const spacing of [1, 10, 60]) expect(pools.some((p) => p.tickSpacing === spacing), `spacing ${spacing}`).toBe(true);
    expect(new Set(REC.swaps.map((s) => s.tx.kind))).toEqual(new Set(['swap', 'swap_v2']));
  });
});

describe.each(REC.swaps.map((s) => [s.tx.signature.slice(0, 12), s] as const))('swap %s…', (_, s) => {
  const pool = decodePoolState(s.pool, bytes(s.accounts[s.pool]!.gz))!;
  const [configAddress, configRaw] = Object.entries(s.accounts).find(([, a]) => a.kind === 'config')!;
  const config = decodeAmmConfig(configAddress, bytes(configRaw.gz))!;
  const extRaw = Object.entries(s.accounts).find(([, a]) => a.kind === 'extension');
  const extension = extRaw ? decodeBitmapExtension(extRaw[0], bytes(extRaw[1].gz)) : null;
  const bands = new Map<number, TickArrayView>();
  for (const [address, a] of Object.entries(s.accounts)) {
    if (a.kind !== 'tickArray') continue;
    const t = decodeTickArray(address, bytes(a.gz))!;
    bands.set(t.startTickIndex, t);
  }
  const ask = args(Buffer.from(s.tx.data, 'base64'));
  const ev = event(Buffer.from(s.tx.event, 'base64'));

  it('was a plain swap of untaxed coins, read before it ran', () => {
    expect(s.readSlot).toBeLessThan(s.tx.slot);
    expect(ev.zeroForOne).toBe(s.tx.zeroForOne);
    expect([ev.transferFee0, ev.transferFee1]).toEqual([0n, 0n]);
    expect(pool && config).toBeTruthy();
    expect(config.address).toBe(pool.ammConfig);
  });

  it('the quote lands where the program did', () => {
    // These swaps ran in Raydium's own program, whose fee ceiling is 10%.
    const q = quoteSwapAsRaydium({
      pool, config, extension, band: (start) => bands.get(start),
      zeroForOne: s.tx.zeroForOne, isBaseInput: ask.isBaseInput, amount: ask.amount,
      sqrtPriceLimitX64: ask.limit, blockTimestamp: s.tx.blockTime,
    });
    expect(q.kind, JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe('ok');
    if (q.kind !== 'ok') return;
    expect([q.amount0, q.amount1]).toEqual([ev.amount0, ev.amount1]);
    expect([q.sqrtPriceX64, q.tick, q.liquidity]).toEqual([ev.sqrtPriceX64, ev.tick, ev.liquidity]);
    if (ev.tradeFees) expect([q.tradeFee0, q.tradeFee1]).toEqual(ev.tradeFees);
    // The swap's own slippage line held, as the program checked it.
    if (ask.isBaseInput) expect(q.amountOut >= ask.threshold).toBe(true);
    else expect(q.amountIn <= ask.threshold).toBe(true);
    // Every band the quote walked was one the swap passed, so the account list it builds works.
    for (const start of q.bands) expect(s.tx.accounts).toContain(deriveTickArray(PROGRAM, new PublicKey(s.pool), start).toBase58());
  });
});
