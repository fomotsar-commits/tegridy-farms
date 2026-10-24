// The typed client for OUR OWN bonding curve — `tegridy-launch`.
//
// WHICH PROGRAM. `PROGRAM_ID` in `program.ts` is the restart id `64WBTe…`, flipped for
// website release 2, which the owner deploys only after the program exists on
// mainnet and the Squads vault holds its upgrade authority and `global.authority`.
// The 2026-08 program (`SPENT_PROGRAM_ID`, `CpFnacr…`) was deployed 2026-08-08 and
// CLOSED on 2026-08-13 together with the cp-swap fork it was to graduate into; both
// of those ids are permanently SPENT and kept only as the record.
//
// This banner has been wrong in both directions before — "NOT DEPLOYED" for four days
// after the 2026-08 deploy, then "LIVE ON MAINNET" for nine days after the close. The
// discipline it states is conditional on neither: no surface may imply a market it has
// not read, and none may render a price, volume, holder count or market cap it did not
// get from chain. `readDeployment` is still the first call any of them makes — with
// the caveat recorded in `program.ts`: a closed program's stub stays
// executable-flagged, so only the ProgramData account can tell live from spent. The
// write gate (`write/config.ts`) reads that account.
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
