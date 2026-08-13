// The typed client for OUR OWN bonding curve — `tegridy-launch`.
//
// THE PROGRAM IS LIVE ON MAINNET since 2026-08-08 —
// `CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED`, slot 438,055,726, `global`
// initialized. `PROGRAM_ID` in `program.ts` is that address.
//
// This banner said "NOT DEPLOYED. Not mainnet, not devnet" for four days after the
// deploy. The discipline it was describing is unchanged and is not conditional on
// the program being absent: no surface may imply a market it has not read, and none
// may render a price, volume, holder count or market cap it did not get from chain.
// `readDeployment` is still the first call any of them makes — because a comment
// cannot know what is deployed and an account read can.
//
// ⚠ GRADUATION DOES NOT WORK YET. cp-swap's AmmConfig does not exist, so
// `migrate_to_amm` fails AmmNotConfigured (6015). `isAmmConfigured` is how a surface
// finds that out; do not present graduation as available.
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
