// Types for errorPolicy.js. The runtime lives in the sibling .js because a Vercel function
// cannot import a .ts module; this file lets the browser side import it with full typing.
// Same arrangement as apiTiers.

/** The first instant a report may be sent or stored, as an ISO string (UTC). */
export declare const ERROR_REPORTING_STARTS_AT: string;
/** ERROR_REPORTING_STARTS_AT in epoch milliseconds. */
export declare const ERROR_REPORTING_STARTS_AT_MS: number;
/** How long a stored report is kept before it is deleted. */
export declare const ERROR_RETENTION_DAYS: number;
/** True from the start instant on; false for any clock value that is not a finite number. */
export declare function errorReportingOpen(nowMs: unknown): boolean;
/** Reports received before this instant (ISO string) are past their retention. */
export declare function errorRetentionCutoff(nowMs: number): string;
