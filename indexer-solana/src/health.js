// Liveness, readiness, and the thing neither of them means.
//
// The endpoint semantics are deliberately the SAME three the Ponder app
// exposes, because an operator should not have to learn two vocabularies for
// one data spine (indexer/DEPLOY.md §3 documents the EVM half):
//
//   /health  the process is up. Says nothing about the database, the cluster,
//            or the data. Always 200.
//   /ready   the service is configured and has completed a tick recently.
//            503 otherwise. This is the one a platform health check points at.
//   /status  JSON, internal only.
//
// AND THE PART THAT IS NOT IN EITHER: readiness is not completeness. A service
// can be perfectly live, perfectly fresh, and still be missing a week of
// history it could not read. So `complete` and `openGaps` are computed and
// reported separately, never folded into `ready` — a boolean that means both
// "answering" and "has everything" is a boolean that will be set true for the
// first reason and believed for the second.
//
// The reverse mistake is worth naming too: standing limitations (unrealized
// fee accrual is not indexed; a pool with no configured fee receiver) are
// permanent by design. Counting them as open gaps would leave `complete` false
// on a perfectly healthy day, and a signal that is always red is a signal
// nobody reads.

import { createServer } from "node:http";

/**
 * @param {object} args
 * @param {number} args.now epoch ms
 * @param {{problems:string[]}} args.config
 * @param {null|{last_tick_at?:any, last_ok_at?:any, head_slot?:any, last_error?:any}} args.tick
 * @param {Array<{pool:string, open_gaps:any, standing_limitations:any, cursor_updated_at?:any}>} args.pools
 * @param {number} args.staleAfterMs
 */
export function computeReadiness({ now, config, tick, pools, staleAfterMs }) {
  const configured = config.problems.length === 0;

  const lastOk = tick?.last_ok_at ? new Date(tick.last_ok_at).getTime() : null;
  const fresh = lastOk !== null && Number.isFinite(lastOk) && now - lastOk <= staleAfterMs;

  const openGaps = pools.reduce((acc, p) => acc + Number(p.open_gaps ?? 0), 0);
  const standing = pools.reduce((acc, p) => acc + Number(p.standing_limitations ?? 0), 0);

  let reason;
  if (!configured) {
    reason = `not configured: ${config.problems.join("; ")}`;
  } else if (lastOk === null) {
    reason = "no tick has completed since this process started";
  } else if (!fresh) {
    reason = `last successful tick was ${Math.round((now - lastOk) / 1000)}s ago, over the ${Math.round(
      staleAfterMs / 1000,
    )}s threshold`;
  } else {
    reason = "configured and ticking";
  }

  return {
    ready: configured && fresh,
    reason,
    configured,
    live: fresh,
    // Completeness of what has been indexed, which is a different question from
    // whether the service is up, and must be answered separately.
    complete: openGaps === 0,
    openGaps,
    standingLimitations: standing,
    lastError: tick?.last_error ?? null,
    headSlot: tick?.head_slot === null || tick?.head_slot === undefined ? null : Number(tick.head_slot),
  };
}

/**
 * Read-only status listener. Started only when SOLANA_STATUS_PORT is set — an
 * operator who did not ask for a port does not get an open socket.
 *
 * Serves no indexed data on purpose. The rows are read from Postgres by
 * whatever fronts them (F5's api host); putting a data endpoint here would be
 * a second, unauthenticated copy of that surface with none of its controls,
 * and Ponder's own runbook already says what happens to an indexer port that
 * faces the internet.
 */
export function createStatusServer({ readStatus, config, staleAfterMs, now = () => Date.now() }) {
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (path !== "/ready" && path !== "/status") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    let status;
    try {
      status = await readStatus();
    } catch (e) {
      // The database is the only place readiness can be read from. Unable to
      // ask is NOT ready, and it is not "no gaps" either.
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ready: false,
          reason: `could not read indexer state from Postgres: ${e.message}`,
        }),
      );
      return;
    }

    const readiness = computeReadiness({
      now: now(),
      config,
      tick: status.tick,
      pools: status.pools,
      staleAfterMs,
    });

    if (path === "/ready") {
      res.writeHead(readiness.ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: readiness.ready, reason: readiness.reason }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...readiness, pools: status.pools }, null, 2));
  });
}
