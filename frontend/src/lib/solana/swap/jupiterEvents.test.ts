// @vitest-environment node
// deliveredByRoute: what a Jupiter route delivers, from its own events. Checked on a real
// mainnet test run and held to the same answers as the hourly scoreboard's reader
// (scripts/lib/fill-scoreboard-chain.mjs) on every real swap recorded for it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveredByRoute } from './jupiterEvents';
import { jupiterEvents, legsOf } from '../../../../scripts/lib/fill-scoreboard-chain.mjs';

const FIXTURES = join(__dirname, '../../../../scripts/fixtures/fill-scoreboard');
const SIM = JSON.parse(readFileSync(join(FIXTURES, 'simulation.json'), 'utf-8'));
const MAINNET = JSON.parse(readFileSync(join(FIXTURES, 'mainnet.json'), 'utf-8'));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

  it('is null when the events cannot say: nothing, garbage, or no Jupiter event', () => {
    expect(deliveredByRoute(undefined)).toBeNull();
    expect(deliveredByRoute('x')).toBeNull();
    expect(deliveredByRoute([{ instructions: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', data: '0OIl' }] }])).toBeNull();
    expect(deliveredByRoute([{ instructions: [{ program: 'spl-token', parsed: {} }] }])).toBeNull();
  });
});
