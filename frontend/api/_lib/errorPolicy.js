// ============================================================
// api/_lib/errorPolicy.js: the two owner decisions about error reports, written once.
//
// 2026-10-02, the owner:
//   * Keep crash reports 30 DAYS, then delete them automatically.
//   * Honour the Privacy page's own section 9: a change that broadens what we collect is
//     called out at the top of that page for at least 14 days first. The notice went up on
//     2026-10-02, so nothing is sent or stored before 2026-10-16T00:00:00Z.
//
// WHO READS THIS FILE
//   src/lib/errorReporting.ts           the browser: sends nothing before the start, and
//                                       never an entry that happened before it
//   api/errors.js                       the server: stores nothing before the start, and
//                                       purges after a stored batch (the backstop)
//   api/_lib/errorPurge.js              the delete itself, measured from the cutoff below
//   scripts/purge-error-events.mjs      run hourly by .github/workflows/error-retention.yml
//   src/pages/PrivacyPage.test.tsx      holds the page's words to these values
//
// ONE COPY. The date is a literal here and nowhere else (errorRetention.test.js fails if
// either side spells it). Plain .js with a .d.ts beside it, like apiTiers.js, because a
// Vercel function cannot import a .ts module. It imports nothing, so the workflow can run
// the purge with no npm install.
// ============================================================

/** The first instant a report may be sent or stored. UTC. */
export const ERROR_REPORTING_STARTS_AT = "2026-10-16T00:00:00Z";
export const ERROR_REPORTING_STARTS_AT_MS = Date.parse(ERROR_REPORTING_STARTS_AT);

/** How long a stored report is kept before it is deleted. */
export const ERROR_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True from the start instant on. Anything that is not a finite number of milliseconds
 * is a clock this code cannot read, and reads as closed.
 */
export function errorReportingOpen(nowMs) {
  return typeof nowMs === "number" && Number.isFinite(nowMs) && nowMs >= ERROR_REPORTING_STARTS_AT_MS;
}

/** Reports received before this instant (ISO string) are past their 30 days. */
export function errorRetentionCutoff(nowMs) {
  return new Date(nowMs - ERROR_RETENTION_DAYS * DAY_MS).toISOString();
}
