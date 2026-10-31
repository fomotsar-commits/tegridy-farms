// @vitest-environment node
// deliveredByRoute: what a Jupiter route delivers, from its own events. Checked on a real
// mainnet test run and held to the same answers as the hourly scoreboard's reader
// (scripts/lib/fill-scoreboard-chain.mjs) on every real swap recorded for it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveredByRoute } from './jupiterEvents';
import { jupiterEvents, jupiterFill, legsOf } from '../../../../scripts/lib/fill-scoreboard-chain.mjs';
import { base58, unbase58 } from '../../../../scripts/lib/venue-volume-chain.mjs';

const FIXTURES = join(__dirname, '../../../../scripts/fixtures/fill-scoreboard');
const SIM = JSON.parse(readFileSync(join(FIXTURES, 'simulation.json'), 'utf-8'));
const MAINNET = JSON.parse(readFileSync(join(FIXTURES, 'mainnet.json'), 'utf-8'));
// Test runs of Jupiter V2 builds (2026-10-23), shaped as transactions.
const V2 = JSON.parse(readFileSync(join(FIXTURES, 'v2-simulation.json'), 'utf-8'));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
// The vault's fee accounts, each with its mint (what jupiter.ts derives and builds with).
const FEES = { '2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa': SOL, '3gGzyz6cushQWNTAYRj4qJoQJyGcqdctXh98vNwBRvZ6': USDC };
type V2Tx = { feeAccount: string; meta: { innerInstructions: Array<{ instructions: Array<{ programId?: string; data?: string }> }> } };
const v2 = (name: string): V2Tx => structuredClone(V2.txs[name]);

describe('deliveredByRoute', () => {
  it('reads a real test run: the USDC the route delivered, net of our fee taken from it', () => {
    const got = deliveredByRoute(SIM.value.innerInstructions);
    expect(got?.mint).toBe(USDC);
    // Within a basis point or so of Jupiter's quote at the moment it was recorded.
    const quoted = BigInt(SIM.quote.outAmount);
    const diff = got!.amount > quoted ? got!.amount - quoted : quoted - got!.amount;
    expect(diff * 10_000n).toBeLessThan(quoted * 20n);
    expect(SIM.quote.platformFee.feeBps).toBe(50);
  });

  it('agrees with the hourly reader on every recorded mainnet swap', () => {
    let compared = 0;
    for (const tx of Object.values(MAINNET.txs) as Array<{ meta: { innerInstructions: Array<{ instructions: unknown[] }> } }>) {
      const ev = jupiterEvents(tx.meta.innerInstructions.flatMap((g) => g.instructions));
      const legs = legsOf(ev.net);
      const mine = deliveredByRoute(tx.meta.innerInstructions);
      if (!legs) {
        expect(mine).toBeNull();
        continue;
      }
      const fee = ev.fee?.mint === legs.outMint ? ev.fee.amount : 0n;
      expect(mine).toEqual({ mint: legs.outMint, amount: (ev.net as Record<string, bigint>)[legs.outMint]! - fee });
      compared++;
    }
    expect(compared).toBe(5);
  });

  it('reads Jupiter V2 test runs: one SwapsEvent, and our fee a transfer to a fee account, taken off an output', () => {
    const got = (name: string) => deliveredByRoute(v2(name).meta.innerInstructions, FEES);
    expect(got('solToBayla')).toEqual({ mint: BAYLA, amount: 14_916_650_298n });
    expect(got('baylaToSol')).toEqual({ mint: SOL, amount: 315_158_228n }); // the quote, to the lamport
    expect(got('usdcToBayla')).toEqual({ mint: BAYLA, amount: 14_700_008_842n });
    expect(got('baylaToUsdc')).toEqual({ mint: USDC, amount: 13_186_308n });
    expect(got('solToUsdcShared')).toEqual({ mint: USDC, amount: 10_405_066n });
  });

  it('agrees with the hourly reader on every V2 test run (it reads a token where it landed)', () => {
    for (const name of Object.keys(V2.txs)) {
      const t = v2(name);
      const hit = jupiterFill(t, t.feeAccount) as { outMint: string; deliveredOut: bigint };
      expect({ name, got: deliveredByRoute(t.meta.innerInstructions, FEES) }).toEqual({ name, got: { mint: hit.outMint, amount: hit.deliveredOut } });
    }
  });

  it('is null for a V2 SwapsEvent shorter than its own hop count', () => {
    const t = v2('usdcToBayla');
    const ev = t.meta.innerInstructions
      .flatMap((g) => g.instructions)
      .find((ix) => ix.programId === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' && unbase58(ix.data!).subarray(8, 16).toString('hex') === '982f4eebc0606e6a')!;
    ev.data = base58(unbase58(ev.data!).subarray(0, -1));
    expect(deliveredByRoute(t.meta.innerInstructions, FEES)).toBeNull();
  });

  it('is null when the events cannot say: nothing, garbage, or no Jupiter event', () => {
    expect(deliveredByRoute(undefined)).toBeNull();
    expect(deliveredByRoute('x')).toBeNull();
    expect(deliveredByRoute([{ instructions: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', data: '0OIl' }] }])).toBeNull();
    expect(deliveredByRoute([{ instructions: [{ program: 'spl-token', parsed: {} }] }])).toBeNull();
  });
});
