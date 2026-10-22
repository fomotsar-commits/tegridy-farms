// What the fill scoreboard says, shared by the hourly job (scripts/fill-scoreboard.mjs) and
// the public read (fillScoreboard.js). No imports: the job runs with no npm install, next to
// the service key. Amounts arrive as decimal strings; a row that does not parse is unscored.

export const WINDOW_DAYS = 30;
/** Hourly runs, and GitHub starts scheduled runs late: three hours without one is behind. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** A fill that used this share of the slippage it allowed or more landed near its floor. */
export const NEAR_FLOOR = { num: 8n, den: 10n };

const int = (v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const m = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return Math.round(m * 100) / 100;
}

/**
 * The window's figures. `unread` until the job has finished a run; `behind` when its last
 * run failed or the newest finished one is older than STALE_AFTER_MS. Bots' swaps count
 * nowhere. `staleAt` lets a cached answer turn itself behind in the browser.
 */
export function summarize(rows, cursorRow, nowMs) {
  const countedTo = Date.parse(cursorRow?.counted_to ?? "");
  const okAt = Date.parse(cursorRow?.last_ok_at ?? "");
  if (!cursorRow || !Number.isFinite(countedTo) || !Number.isFinite(okAt)) return { state: "unread" };
  const errAt = Date.parse(cursorRow.last_error_at ?? "");
  const failing = Number.isFinite(errAt) && errAt > okAt;
  const staleAt = countedTo + STALE_AFTER_MS;
  const since = nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const fills = [];
  let unscored = 0;
  let nearFloor = 0;
  let atOrAbove = 0;
  let depositTrades = 0;
  let depositLamports = 0n;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.bot === true || !(Date.parse(r?.block_time ?? "") >= since)) continue;
    const quoted = int(r.quoted_out);
    const delivered = int(r.delivered_out);
    const slip = r.slippage_bps;
    const deposit = int(r.deposit_lamports ?? "0");
    if (r.unread_reason || quoted === null || quoted === 0n || delivered === null || !Number.isInteger(slip) || deposit === null) {
      unscored++;
      continue;
    }
    const bps = Number(((delivered - quoted) * 1_000_000n) / quoted) / 100;
    fills.push(bps);
    if (delivered >= quoted) atOrAbove++;
    const allowed = (quoted * BigInt(slip)) / 10_000n;
    if (allowed > 0n && (quoted - delivered) * NEAR_FLOOR.den >= allowed * NEAR_FLOOR.num) nearFloor++;
    if (deposit > 0n) {
      depositTrades++;
      depositLamports += deposit;
    }
  }
  fills.sort((a, b) => a - b);
  return {
    state: failing || nowMs > staleAt ? "behind" : "current",
    asOf: new Date(countedTo).toISOString(),
    staleAt: new Date(staleAt).toISOString(),
    windowDays: WINDOW_DAYS,
    trades: fills.length,
    unscored,
    medianFillBps: median(fills),
    worstFillBps: fills.length ? fills[0] : null,
    atOrAboveQuote: atOrAbove,
    nearFloor,
    deposits: { trades: depositTrades, lamports: depositLamports.toString() },
  };
}
