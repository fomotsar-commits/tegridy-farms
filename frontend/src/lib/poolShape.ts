// What a pool row may say about a pool's shape, from the registry alone.
//
// Lives outside the component so it can be tested directly, and so VenuePoolIndex
// keeps a component-only export (a non-component export there breaks fast refresh for
// the whole module).
import { MIN_BOOST_BPS, MAX_BOOST_BPS } from './constants';

/**
 * The lock ladder's endpoints, as multipliers, from the contract constants
 * rather than a literal.
 *
 * ⚠️ THIS SHIPPED AS "1.00×–4.00×" AND THAT WAS WRONG AT THE BOTTOM END.
 * `MIN_BOOST_BPS` is 4_000, i.e. **0.4x at seven days** — LighthouseLadder.sol:98
 * says so in its own trailing comment, constants.ts carries the same pair, and
 * lighthouseLadder.ts:47 calls it "TOWELI parity". Advertising a 1.00× floor
 * tells a short-lock staker they get a full share when the contract gives them
 * four tenths of one, which overstates the worst case by 2.5×. It is derived
 * here so the next re-tune of the ladder cannot leave this string behind.
 */
const BOOST_FLOOR = `${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`;
const BOOST_CEILING = `${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`;

const LADDER_TERMS = `Lock ladder · 7d–4y, ${BOOST_FLOOR}–${BOOST_CEILING}`;

/**
 * What the row can honestly say about a pool's shape, from the registry alone.
 *
 * ⚠️ "Streamflow", not "Streamflow · locked", for a Streamflow row. The registry
 * records the PROGRAM and nothing about lock terms: there is no lock field, and the
 * retired BAYLA pool ran flat weights. Asserting "locked" from `chain` alone is
 * exactly the kind of claim this file's header forbids — a property nothing was read
 * to establish. The room states its own terms.
 *
 * ⚠️ AND A SOLANA POOL IS NO LONGER ALWAYS STREAMFLOW. Which program it is, is named
 * by which FIELD carries its address: `stakePool` is Streamflow, `ladderPool` is the
 * venue's own bayla-ladder. A bungalow mid-migration has BOTH, and the row says so
 * rather than picking one and quietly dropping the other — a pool listed nowhere is
 * a pool a staker cannot find their way back to.
 */
export function poolShape(b: {
  poolKind?: 'plain' | 'ladder';
  chain: string;
  stakePool?: string;
  ladderPool?: string;
}): string {
  if (b.chain === 'solana') {
    if (b.ladderPool && b.stakePool) return 'Streamflow + lock ladder';
    if (b.ladderPool) return LADDER_TERMS;
    return 'Streamflow';
  }
  if (b.poolKind === 'ladder') return LADDER_TERMS;
  return 'No lock';
}


