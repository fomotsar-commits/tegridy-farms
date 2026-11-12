// @vitest-environment node
//
// The robot's pricing against the pool program with the keeper's fee itself: 18 real swaps on a
// local validator (keeperFeeReplay.fixture.json; its `about` says how they were made). For each,
// the robot decodes the tier and the pool as it does on mainnet and quotes the swap as that tier
// charges the signer (chargedTo, KEEPER_FREE_SWAPS): the quote is what came out, to the unit.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeAmmConfig, decodePoolState } from './program';
import { vaultAmountWithoutFee } from './math';
import { chargedTo, quoteOwnPool } from './read';

interface Raw { owner: string; data: string }
interface Swap { who: 'keeper' | 'stranger'; named: boolean; dir: string; inputMint: string; amountIn: string; got: string; blockTime: number; before: { tier: Raw; pool: Raw; vault0: Raw; vault1: Raw } }
const fixture = JSON.parse(readFileSync(new URL('./keeperFeeReplay.fixture.json', import.meta.url), 'utf8')) as { keeper: string; stranger: string; tier: string; pool: string; swaps: Swap[] };

const bytes = (r: Raw) => Uint8Array.from(Buffer.from(r.data, 'base64'));
const amountOf = (r: Raw) => Buffer.from(r.data, 'base64').readBigUInt64LE(64);

/** What the robot reads before a swap: the tier, and the pool with its reserves less the fees parked in its vaults. */
function read(s: Swap) {
  const config = decodeAmmConfig(fixture.tier, bytes(s.before.tier))!;
  const pool = decodePoolState(fixture.pool, bytes(s.before.pool))!;
  const [vault0Amount, vault1Amount] = [amountOf(s.before.vault0), amountOf(s.before.vault1)];
  const reserve0 = vaultAmountWithoutFee(vault0Amount, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0)!;
  const reserve1 = vaultAmountWithoutFee(vault1Amount, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1)!;
  return { config, snapshot: { pool, vault0Amount, vault1Amount, reserve0, reserve1 } };
}
const payerOf = (s: Swap) => (s.who === 'keeper' ? fixture.keeper : fixture.stranger);

describe('the robot’s quotes, replayed against the keeper-fee build', () => {
  it('holds the swaps it says: the keeper before and after it is named, and a stranger, both ways', () => {
    const count = (who: string, named: boolean) => fixture.swaps.filter((s) => s.who === who && s.named === named).length;
    expect([count('keeper', false), count('keeper', true), count('stranger', true)]).toEqual([2, 8, 8]);
    expect(new Set(fixture.swaps.map((s) => s.dir))).toEqual(new Set(['0to1', '1to0']));
  });

  it('reads the keeper the tier named, and none before', () => {
    for (const s of fixture.swaps) expect(read(s).config.keeper).toBe(s.named ? fixture.keeper : null);
  });

  it('quotes every swap to the unit as the tier charged its signer', () => {
    for (const s of fixture.swaps) {
      const { config, snapshot } = read(s);
      const q = quoteOwnPool(snapshot, chargedTo(config, payerOf(s)), s.inputMint, BigInt(s.amountIn), s.blockTime);
      expect(q?.outAmount, `${s.who} ${s.named ? 'named' : 'not named'} ${s.dir} ${s.amountIn}`).toBe(BigInt(s.got));
    }
  });

  it('the keeper once named got the bare curve, more than the fee-paying quote it would set without KEEPER_FREE_SWAPS', () => {
    for (const s of fixture.swaps.filter((x) => x.who === 'keeper' && x.named)) {
      const { config, snapshot } = read(s);
      const in0 = s.inputMint === snapshot.pool.token0Mint;
      const [rIn, rOut] = in0 ? [snapshot.reserve0, snapshot.reserve1] : [snapshot.reserve1, snapshot.reserve0];
      const x = BigInt(s.amountIn);
      expect(BigInt(s.got)).toBe((rOut * x) / (rIn + x));
      const charged = quoteOwnPool(snapshot, config, s.inputMint, x, s.blockTime)!;
      expect(charged.outAmount).toBeLessThan(BigInt(s.got));
    }
  });
});
