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
//   read.ts     RPC reads, the phase classifier, and the honest-unknown types
//               everything above hands to a page. Written against an interface,
//               so it runs against a fixture with no network.
//   rpc.ts      the one implementation of that interface — JSON-RPC through our
//               own /api/solrpc proxy — plus the mint read and the write seam.
//   geometry.ts plot coordinates for the curve as a function of state. Presentation
//               only; its one quoted number comes from math.ts.
//   config.ts   operator pre-flight for initialize_global / update_global, against
//               every guard the program applies. Also math.ts.
//   format.ts   numbers and phases into words, with no default-to-zero anywhere.
//
// THIS DIRECTORY IS THE ONLY IMPLEMENTATION. The page, the chart and the operator
// CLI were each built with their own transcription of curve.rs; four sources of
// truth for quote maths is a UI that quotes differently than the program executes,
// which takes money from users on every trade. They now all import from here.
//
// There is no React here and there must not be.

export * from './math';
export * from './program';
export * from './ix';
export * from './read';
export * from './rpc';
export * from './geometry';
export * from './config';
export * from './format';
