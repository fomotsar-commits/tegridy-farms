// @vitest-environment node
//
// The robot's zero fee, as our pool program charges it once the keeper's fee (PR #1198, merged
// 2026-11-12) is on mainnet: states/config.rs `swap_fee_rates` hands a tier's keeper rates of 0,
// its creator fee taken on the output. The robot must price its own swaps the same way
// (chargedTo, then quoteOwnPool), or each minimum it sets is wrong: KEEPER_FREE_SWAPS turns it on.
import { describe, it, expect } from 'vitest';
import { AMM_CONFIG_KEEPER_OFFSET, AMM_CONFIG_OFFSETS, CREATOR_FEE_ON_BOTH, decodeAmmConfig, type AmmConfigView } from './program';
import { chargedTo, quoteOwnPool } from './read';
import { buildPool, configBytes, key, viewOf } from '../lp/testkit.fixture';
import { SOL_QUOTE } from '../lp/quotes';

const NOW = 10_000_000;
const SOL = 10n ** 9n;
const robot = key();
const stranger = key();

/** A public tier of ours: 1% trade fee, 16% of it the protocol's, a 0.5% creator fee, and `keeper`. */
function tier(keeper: ReturnType<typeof key> | null): AmmConfigView {
  const d = configBytes(1, 10_000n, 160_000n);
  new DataView(d.buffer).setBigUint64(AMM_CONFIG_OFFSETS.creatorFeeRate, 5_000n, true);
  if (keeper) d.set(keeper.toBytes(), AMM_CONFIG_KEEPER_OFFSET);
  return decodeAmmConfig('T', d)!;
}

// A public pool: creator fee on, on both tokens, so on the input (as every public pool of ours).
const token = key();
const view = viewOf(buildPool({ mint: token, quote: SOL_QUOTE, quoteReserve: 50n * SOL, tokenReserve: 10n ** 12n }), { sol: 50n * SOL, tok: 10n ** 12n });
const snapshot = { ...view.snapshot, pool: { ...view.snapshot.pool, creatorFeeOn: CREATOR_FEE_ON_BOTH, enableCreatorFee: true } };
const [solIn, tokenIn] = [SOL_QUOTE.mint, token.toBase58()];
const reserves = (inputMint: string) => {
  const in0 = inputMint === snapshot.pool.token0Mint;
  return in0 ? [snapshot.reserve0, snapshot.reserve1] : [snapshot.reserve1, snapshot.reserve0];
};
/** Upstream's swap_base_input_without_fees: what x·y = k pays for `x` in, rounded down. */
const curve = (x: bigint, rIn: bigint, rOut: bigint) => (rOut * x) / (rIn + x);

describe('the tier names its keeper', () => {
  it('reads the keeper a tier names, and none from zeros (every tier on mainnet today, every Raydium config)', () => {
    expect(tier(robot).keeper).toBe(robot.toBase58());
    expect(tier(null).keeper).toBeNull();
  });
});

describe('chargedTo: the tier as it charges one payer', () => {
  it('charges its keeper no trade fee and no creator fee, so no protocol or fund share', () => {
    const c = chargedTo(tier(robot), robot.toBase58());
    expect(c).toMatchObject({ tradeFeeRate: 0n, creatorFeeRate: 0n, keeperFree: true, protocolFeeRate: 160_000n });
  });

  it('charges anyone else, and anyone on a tier with no keeper, as before: the same tier back', () => {
    const named = tier(robot);
    expect(chargedTo(named, stranger.toBase58())).toBe(named);
    const none = tier(null);
    expect(chargedTo(none, robot.toBase58())).toBe(none);
  });
});

describe('quoteOwnPool for the keeper', () => {
  it('pays the bare curve, both ways, on a pool that takes its creator fee on the input, where a stranger pays the fees', () => {
    const named = tier(robot);
    for (const inputMint of [solIn, tokenIn]) {
      const [rIn, rOut] = reserves(inputMint);
      for (const x of [1n, 12_345n, 10n ** 9n, 7n * SOL, 3n * 10n ** 11n]) {
        const free = quoteOwnPool(snapshot, chargedTo(named, robot.toBase58()), inputMint, x, NOW)!;
        expect(free.outAmount, `${inputMint} ${x}`).toBe(curve(x, rIn, rOut));
        expect(free.result).toMatchObject({ tradeFee: 0n, protocolFee: 0n, fundFee: 0n, creatorFee: 0n });
        expect(free.creatorFeeOnInput).toBe(false);
        const paid = quoteOwnPool(snapshot, chargedTo(named, stranger.toBase58()), inputMint, x, NOW);
        if (x < 1_000n) continue; // the fee rounds up to a unit; a tiny swap may pay out nothing
        expect(paid!.outAmount).toBeLessThan(free.outAmount);
        expect(paid!.result.tradeFee).toBeGreaterThan(0n);
        expect(paid!.result.creatorFee).toBeGreaterThan(0n);
        expect(paid!.creatorFeeOnInput).toBe(true);
      }
    }
  });

  it('refuses rates of 0 with the creator fee on the input, as the program does (6006): the keeper’s goes on the output', () => {
    const zeroOnInput = { ...tier(robot), tradeFeeRate: 0n, creatorFeeRate: 0n };
    expect(quoteOwnPool(snapshot, zeroOnInput, solIn, SOL, NOW)).toBeNull();
    expect(quoteOwnPool(snapshot, chargedTo(tier(robot), robot.toBase58()), solIn, SOL, NOW)).not.toBeNull();
  });

  it('refuses a pool whose creator-fee mode the program cannot price, keeper or not', () => {
    const odd = { ...snapshot, pool: { ...snapshot.pool, creatorFeeOn: 9 } };
    expect(quoteOwnPool(odd, chargedTo(tier(robot), robot.toBase58()), solIn, SOL, NOW)).toBeNull();
  });
});
