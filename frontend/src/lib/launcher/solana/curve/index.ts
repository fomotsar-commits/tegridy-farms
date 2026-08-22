// The typed client for OUR OWN bonding curve — `tegridy-launch`.
//
// ⛔ THE RAIL IS NOT RUNNING. `tegridy-launch` was deployed to mainnet 2026-08-08 at
// `CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED` (slot 438,055,726, `global`
// initialized) and CLOSED on 2026-08-13, together with the cp-swap fork it was to
// graduate into. Both ProgramData accounts are gone, so both ids are permanently
// SPENT. `PROGRAM_ID` in `program.ts` is that spent address — kept as the record and
// as the registry cross-check, not as a target. Graduation never worked at any point:
// cp-swap's AmmConfig was never created, so `migrate_to_amm` failed AmmNotConfigured
// (6015) for the program's whole life.
//
// This banner has been wrong in both directions — it said "NOT DEPLOYED" for four days
// after the deploy, then said "LIVE ON MAINNET" for nine days after the close. The
// discipline it exists to state is conditional on neither: no surface may imply a
// market it has not read, and none may render a price, volume, holder count or market
// cap it did not get from chain. `readDeployment` is still the first call any of them
// makes — with the caveat it cannot cover, recorded in `program.ts`: a closed
// program's stub stays executable-flagged, so that read reports `deployed` for a spent
// id and only the ProgramData account can say otherwise.
//
// What the code here is still FOR: it is a correct client for the program's SOURCE —
// quote maths, layouts, instruction format — which a redeploy under fresh keypairs and
// new `declare_id!` values would need intact.
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
