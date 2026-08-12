// THE BIRTH CERTIFICATE — re-export barrel.
//
// The implementation moved to `frontend/api/_lib/record-core.js` (+ its co-located
// `.d.ts`) so that ONE module serves all four consumers the directive names: the record
// page, the island's enrollment read, the hygiene watch, and the certification render.
// Two of those run in a Vercel lambda, which cannot import a `.ts` module — and the
// repo's existing answer to that (a hand-written JS port with a "keep in sync" comment,
// see `api/_lib/launcher-outcomes.js`) is precisely the fork the directive forbids:
// "NEVER rebuild what the repo already proves. Extend, never fork."
//
// This file stays as the import path every browser-side caller already uses, so nothing
// downstream changed. `birthRecord.test.ts` now exercises the exact bytes the serverless
// route executes, which is the point of moving it rather than copying it.
//
// ⚠️ The core is bundled into the browser as well as the lambda. Keep it pure: no
// `node:` imports, no `process.env`, no `fetch`, no `Buffer`.

export * from '../../../api/_lib/record-core.js';
