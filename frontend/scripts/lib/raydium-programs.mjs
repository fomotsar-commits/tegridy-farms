/**
 * Raydium's programs as Jupiter named them on 2026-10-31 (AMM v4, CLMM, CP-Swap, LaunchLab).
 * The price keeper refuses them in Jupiter's leg even when Jupiter's venue list does not
 * answer or renames them (owner ruling 2026-10-13: no money to Raydium, ever; the owner let
 * the keeper alone use Raydium on 2026-10-31, KEEPER_ALLOW_RAYDIUM).
 *
 * Kept here, out of src/: nothing the site ships may name a Raydium key
 * (src/test/siteNoRaydiumKeys.test.ts), and only scripts/price-keeper.mjs needs these.
 */
export const RAYDIUM_PROGRAMS = Object.freeze([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
]);

/**
 * The programs whose swaps the robot builds itself (src/lib/solana/keeper/directLegs.ts takes
 * them as inputs, since src/ may not name them): Raydium CPMM (cp-swap), and AMM v4 with its
 * authority, PDA ["amm authority"] of AMM v4.
 */
export const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_AMM_V4_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
/** Raydium's concentrated pools (CLMM): a leg of a trip the engine hands over (scripts/lib/arb-legs.mjs). */
export const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
