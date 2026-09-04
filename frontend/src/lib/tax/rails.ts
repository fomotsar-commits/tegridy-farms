// Whether /tax should still wear the amber SOON pill — and why the answer is a
// value rather than a probe.
//
// ─── THE QUESTION A PILL ANSWERS ────────────────────────────────────────────
//
// "Can a visitor arriving at this entry do the thing it names?" For /tax that
// is: build a report from history THIS VENUE READS. Until now the answer was no
// for one reason — the only source was the F1 indexer, which is hosted nowhere,
// so the surface could read nobody's history and every export was a header over
// a whole-period gap. The pill was keyed to `isIndexerConfigured()` and it was
// telling the truth.
//
// It is no longer the truth. The ledger is read through /api/etherscan, a
// same-origin serverless function that ships with every deployment and
// allowlists exactly the three account actions this read needs
// (api/etherscan.js: txlist, txlistinternal, tokentx). That is a REPO FACT: it
// is in the artefact, it cannot be absent from a deployment of this repo, and
// prod returned rows through it on 2026-08-06 (the amplifier-fix note in that
// same file records the measurement).
//
// ─── WHY NOT A FUNCTION THAT PROBES ─────────────────────────────────────────
//
// The one input that could make the answer false is the server-side
// ETHERSCAN_API_KEY, and it is not client-readable at nav-render time: nav
// items are a static array built at module scope, and finding out would mean an
// HTTP request per page load. So a `railIsUp()` returning a constant would be a
// hardcoded value wearing a function — worse than the value, because it reads
// like a check.
//
// The honest disclosure lives where the state IS readable: the ledger status
// card on /tax names ETHERSCAN_API_KEY and prints the operator step the moment
// a read comes back keyless, and every export carries the whole period as a
// declared `explorer-unavailable` gap. That is the same treatment this repo
// already gives the identical source on /alerts, where lib/alerts/sources.ts
// marks the explorer `readable: true` on the reasoning that same-origin
// resources ship with every deployment and a failure is an outage reported at
// read time.
//
// rails.test.ts is what stops this becoming a lie by neglect: it parses
// api/etherscan.js for the three actions and the mainnet pin, and it asserts
// the page still carries its disclosure. Delete either and CI reds.

/**
 * The `soon` value the /tax nav entry should carry.
 *
 * A constant, deliberately — see the header. Exported so the reasoning has one
 * home and one guard, rather than living only in a comment next to a literal in
 * a nav table seven other surfaces are also editing.
 */
export const TAX_PILL_SOON = false;
