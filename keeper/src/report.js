#!/usr/bin/env node
// The week-1 numbers, from the watch log, in plain words: how long it really ran,
// how often it could not read, how often a correction would have paid and roughly
// what it would have made, the biggest gap, and whether a correction fits in one
// transaction. These are what the go/no-go for week 2 is decided on, so nothing in
// here may turn an unread look into "no gap".
//
//   node keeper/src/report.js            every log file
//   node keeper/src/report.js --days 1   the last day's file only

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Two looks further apart than this mean the keeper was not running in between. */
const RUNNING_GAP_MS = 120_000;

/**
 * Per pool. An EPISODE is one stretch in which a pool sat outside the fee band on
 * one side: it opens at the first look where a correction would have paid, and
 * closes only when the gap comes back inside the fees (or flips side). A look that
 * is outside the band but does not pay, or is unread, neither closes it nor adds to
 * it. Each episode counts once, at the best confirmed profit seen in it, because
 * nothing closes the gap while the keeper only watches. If any look in an episode
 * hit the size cap, that episode would have taken several corrections, so its
 * figure is a floor.
 */
export function summarize(rows) {
  const pools = new Map();
  const sorted = rows.filter((r) => r && r.pool && r.t).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  for (const r of sorted) {
    const p = pools.get(r.pool) ?? {
      coin: r.coin ?? '', checks: 0, unread: 0, first: r.t, last: r.t, lastAt: null, runningMs: 0,
      maxGap: null, maxGapAt: null, episodes: 0, made: 0, capped: 0, paused: 0, unsteady: 0,
      episode: null, // { side, best, capped }
      size: { fits: 0, tooBig: 0, tooBigUpper: 0, failed: 0, lastFailure: null, notChecked: 0, maxBytes: 0 },
      jumps: 0, inJump: false, leaks: 0, repointed: 0,
    };
    p.checks++;
    const at = Date.parse(r.t);
    if (p.lastAt !== null) p.runningMs += Math.min(at - p.lastAt, RUNNING_GAP_MS);
    p.lastAt = at;
    p.last = r.t;
    if (r.leak) p.leaks++;
    if (r.repointed) p.repointed++;
    if (r.bigMove && !p.inJump) p.jumps++;
    p.inJump = !!r.bigMove;
    pools.set(r.pool, p);
    if (r.unread) {
      p.unread++;
      continue;
    }
    if (typeof r.gapPct === 'number' && (p.maxGap === null || Math.abs(r.gapPct) > Math.abs(p.maxGap))) {
      p.maxGap = r.gapPct;
      p.maxGapAt = r.t;
    }
    if (r.paused) p.paused++;
    if (r.unsteady) p.unsteady++;
    if (r.size) {
      if (typeof r.size.bytes === 'number') {
        if (r.size.fits && r.size.accountsOk) p.size.fits++;
        else if (r.size.upperBound) p.size.tooBigUpper++;
        else p.size.tooBig++;
        p.size.maxBytes = Math.max(p.size.maxBytes, r.size.bytes);
      } else if (r.size.unread) {
        p.size.failed++;
        p.size.lastFailure = r.size.unread;
      } else {
        p.size.notChecked++;
      }
    }
    const side = r.direction ?? null;
    if (p.episode && (side === null || side !== p.episode.side)) p.episode = null; // back inside the fees, or flipped
    if (r.wouldTrade) {
      if (!p.episode) {
        p.episode = { side, best: 0, capped: false };
        p.episodes++;
      }
      if (r.capped && !p.episode.capped) {
        p.episode.capped = true;
        p.capped++;
      }
      if (r.confirmedProfit > p.episode.best) {
        p.made += r.confirmedProfit - p.episode.best;
        p.episode.best = r.confirmedProfit;
      }
    }
  }
  return pools;
}

const hrs = (ms) => (ms / 3_600_000).toFixed(1);

export function describe(pools) {
  const lines = [];
  for (const [name, p] of pools) {
    const spanMs = Date.parse(p.last) - Date.parse(p.first);
    const read = p.checks - p.unread;
    const unreadPct = p.checks ? (p.unread / p.checks) * 100 : 0;
    const off = spanMs - p.runningMs;
    lines.push(`${name}: ran about ${hrs(p.runningMs)} h${off > RUNNING_GAP_MS ? ` (not running for about ${hrs(off)} h of the ${hrs(spanMs)} h)` : ''}, ${p.checks} looks, ${p.unread} unread (${unreadPct.toFixed(1)}%).`);
    if (read === 0) {
      lines.push('  No look could be read, so nothing is known about its gap.');
    } else {
      const among = p.unread ? ` among the ${read} looks it could read` : '';
      lines.push(`  Biggest gap${among}: ${p.maxGap >= 0 ? '+' : ''}${p.maxGap.toFixed(2)}%${p.maxGapAt ? ` (${p.maxGapAt})` : ''}.`);
      if (p.episodes === 0) lines.push(`  A correction would not have paid in any look it could read${p.unread ? `; ${p.unread} were unread` : ''}.`);
      else lines.push(`  A correction would have paid in ${p.episodes} stretch(es), making about ${p.made.toFixed(6)} ${p.coin} for the treasury${p.capped ? ` (at least: ${p.capped} stretch(es) hit the size cap)` : ''}${p.unread ? `, not counting ${p.unread} unread looks` : ''}.`);
    }
    if (p.paused) lines.push(`  ${p.paused} look(s) were not counted because pump.fun's price had just jumped (the live keeper pauses then).`);
    if (p.unsteady) lines.push(`  ${p.unsteady} look(s) were not counted because the outside price moved while it was read.`);
    const s = p.size;
    if (s.fits + s.tooBig + s.tooBigUpper > 0) {
      lines.push(`  One transaction: fit ${s.fits} time(s), too big ${s.tooBig} time(s)${s.tooBigUpper ? `, maybe too big ${s.tooBigUpper} time(s) (an upper bound)` : ''}; largest ${s.maxBytes} of 1232 bytes.`);
    }
    if (s.failed) lines.push(`  The size check failed ${s.failed} time(s); last: ${s.lastFailure}.`);
    if (s.fits + s.tooBig + s.tooBigUpper + s.failed === 0) {
      lines.push(s.notChecked ? '  One transaction: not checked (needs JUPITER_API_KEY and KEEPER_TAKER).' : '  One transaction: no correction paid, so nothing was measured.');
    }
    if (p.jumps) lines.push(`  pump.fun's price jumped more than 15% within a minute ${p.jumps} time(s).`);
    if (p.leaks) lines.push(`  THE FEE OWNERS WERE NOT THE AGREED SPLIT (venue to our vault, island to its Workshop) in ${p.leaks} look(s).`);
    if (p.repointed) lines.push(`  THE POOL WAS RE-POINTED (another fee tier or vault) in ${p.repointed} look(s).`);
  }
  return lines.join('\n');
}

/** Rows from the log. `day` reads that one UTC day's file; `days` the last N files. */
export function readLogs(dir, { days = null, day = null } = {}) {
  if (!existsSync(dir)) return [];
  let files = readdirSync(dir).filter((f) => /^watch-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  if (day) files = files.filter((f) => f === `watch-${day}.jsonl`);
  else if (days) files = files.slice(-days);
  const rows = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // A half-written last line from a stopped run: skip it.
      }
    }
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--days');
  const days = i > 0 ? Number(process.argv[i + 1]) : null;
  const dir = process.env.KEEPER_LOG_DIR || join(HERE, '..', 'log');
  const rows = readLogs(dir, { days });
  console.log(rows.length ? describe(summarize(rows)) : `No watch log yet in ${dir}.`);
}
