// The typed client for OUR OWN bonding curve — `tegridy-launch`.
//
// ⚠ THE PROGRAM IS NOT DEPLOYED. Not mainnet, not devnet. `PROGRAM_ID` is the
// placeholder the crate compiles against and it returns `null` on mainnet-beta.
// Every surface built on this must say so, must not imply a live market, and
// must never render a price, volume, holder count or market cap that it did not
// read from chain. `readDeployment` is the first call any of them makes.
//
//   math.ts     pure BigInt port of the program's curve.rs, differentially
//               proven against 3,125 Rust-generated vectors. Imports nothing.
//   program.ts  identity, PDA seeds, discriminators, error table, account
//               layouts decoded by byte offset (there is no committed IDL).
//   ix.ts       hand-encoded instruction builders. Pure — no connection, no
//               signing.
//   read.ts     RPC reads, the five-phase classifier, and the honest-unknown
//               types everything above hands to a page.
//
// There is no React here and there must not be.

export * from './math';
export * from './program';
export * from './ix';
export * from './read';
