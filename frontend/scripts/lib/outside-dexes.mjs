/**
 * The arbitrage scanner's exchange keys (scripts/lib/arb-chain.mjs `DEXES`, feat/arb-scanner) and
 * each one's program, verified on chain 2026-11-05. The price keeper maps a scanner trip's legs
 * through this, then asks Jupiter's own venue list for each program's label, so every leg of a
 * trip between two outside pools is held to the exchange the scanner priced.
 *
 * Kept here, out of src/: three are Raydium's, and nothing the site ships may name a Raydium key
 * (src/test/siteNoRaydiumKeys.test.ts). Without KEEPER_ALLOW_RAYDIUM the keeper still refuses
 * those three (scripts/lib/raydium-programs.mjs).
 */
export const OUTSIDE_DEX_PROGRAMS = Object.freeze({
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  ammV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
});
