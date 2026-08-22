#!/usr/bin/env node
// Generate pre-computed rarity ranks for Nakamigos (BATTLE_PLAN Part III).
//
// Fetches per-token metadata JSON for ids 0..SUPPLY-1 from the IPFS gateway
// (`${METADATA_BASE}/<id>` — no extension; verified: /0 and /19999 are 200,
// /20000 is 404), scores each token with standard trait-frequency rarity, and
// writes src/nakamigos/data/rarity.json in EXACTLY the shape the consumer at
// src/nakamigos/api.js (computeRarity / hasPrecomputedRarity) reads:
//
//   { generatedAt: ISO string, totalTokens, traitCount, rarity: { "<id>": { rank, score } } }
//
// The consumer activates automatically once totalTokens > 0 — no api.js change.
//
// Scoring mirrors the runtime fallback in api.js so precomputed and runtime
// ranks agree in method: attributes are filtered the same way normalizeToken
// filters them, trait key is `${trait_type}::${value}`, score = Σ 1/frequency
// (frequency = traitCount/total), and there is NO "trait count" pseudo-trait
// (the runtime fallback has none). Rank = dense rank by score descending.
//
// Resumable: fetched attributes are checkpointed to scripts/.rarity-checkpoint.json
// every SAVE_EVERY tokens (and on SIGINT/failure), so an interrupted run picks
// up where it left off. Delete the checkpoint to force a cold refetch.
//
// Usage:
//   node scripts/compute-rarity.mjs                 # full 20,000-token run
//   node scripts/compute-rarity.mjs --limit 50      # sample run (ids 0..49)
//   node scripts/compute-rarity.mjs --concurrency 8 --out path.json --checkpoint path.json

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors COLLECTIONS.nakamigos in src/nakamigos/constants.js (not imported —
// that module pulls in ../lib/constants.ts, which plain Node can't load).
const METADATA_BASE = 'https://alchemy.mypinata.cloud/ipfs/QmaN1jRPtmzeqhp6s3mR1SRK4q1xWPvFvwqW1jyN6trir9';
const SUPPLY = 20000; // token ids 0..19999

const SAVE_EVERY = 500;       // checkpoint + progress cadence (tokens)
const MAX_ATTEMPTS = 8;       // per-token fetch attempts
const BACKOFF_BASE_MS = 1000; // exponential backoff base
const BACKOFF_CAP_MS = 30000;
const REQUEST_TIMEOUT_MS = 30000;

const { values: args } = parseArgs({
  options: {
    limit:       { type: 'string' },
    out:         { type: 'string' },
    checkpoint:  { type: 'string' },
    concurrency: { type: 'string' },
    help:        { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log('Usage: node scripts/compute-rarity.mjs [--limit N] [--concurrency N] [--out path] [--checkpoint path]');
  process.exit(0);
}

const LIMIT = args.limit ? Math.min(parseInt(args.limit, 10), SUPPLY) : SUPPLY;
const CONCURRENCY = args.concurrency ? parseInt(args.concurrency, 10) : 8;
const OUT_PATH = path.resolve(args.out ?? path.join(__dirname, '../src/nakamigos/data/rarity.json'));
const CHECKPOINT_PATH = path.resolve(args.checkpoint ?? path.join(__dirname, '.rarity-checkpoint.json'));

if (!Number.isInteger(LIMIT) || LIMIT <= 0) { console.error(`Bad --limit: ${args.limit}`); process.exit(1); }
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY <= 0) { console.error(`Bad --concurrency: ${args.concurrency}`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same attribute filter as normalizeToken in api.js, so both scorers see the
// identical trait set. Stored as [key, value] pairs to keep the checkpoint small.
function filterAttributes(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((a) => a && a.trait_type != null && a.trait_type !== '' && a.value != null && a.value !== ''
      && String(a.trait_type) !== 'undefined' && String(a.value) !== 'undefined')
    .map((a) => [String(a.trait_type), String(a.value)]);
}

// ═══ Checkpoint (atomic write; resumes an interrupted run) ═══
function loadCheckpoint() {
  try {
    const data = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    if (data?.version === 1 && data.base === METADATA_BASE && data.tokens && typeof data.tokens === 'object') {
      return data.tokens; // { "<id>": [[traitType, value], ...] }
    }
    console.warn('Checkpoint exists but is for a different metadata base or format — ignoring it.');
  } catch { /* no checkpoint or unreadable — cold start */ }
  return {};
}

function saveCheckpoint(tokens) {
  const tmp = `${CHECKPOINT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, base: METADATA_BASE, tokens }), 'utf8');
  fs.renameSync(tmp, CHECKPOINT_PATH);
}

// ═══ Fetch one token's metadata with polite retry/backoff ═══
async function fetchToken(id) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${METADATA_BASE}/${id}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch (err) { // network error / timeout — retry
      if (attempt === MAX_ATTEMPTS) throw new Error(`token ${id}: ${err.message}`, { cause: err });
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.ok) {
      const meta = await res.json();
      return filterAttributes(meta.attributes);
    }
    if (res.status === 404) throw new Error(`token ${id}: 404 (id out of range?)`);
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`token ${id}: HTTP ${res.status} after ${MAX_ATTEMPTS} attempts`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
      continue;
    }
    throw new Error(`token ${id}: HTTP ${res.status}`);
  }
}

function backoffMs(attempt) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  return base + Math.random() * base * 0.25; // jitter
}

// ═══ Scoring (mirrors the runtime fallback in api.js computeRarity) ═══
function computeScores(tokens) {
  const ids = Object.keys(tokens);
  const total = ids.length;

  const traitCounts = new Map();
  for (const id of ids) {
    for (const [type, value] of tokens[id]) {
      const key = `${type}::${value}`;
      traitCounts.set(key, (traitCounts.get(key) || 0) + 1);
    }
  }

  // score = Σ 1/frequency, frequency = count/total. Rounded to 4 decimals
  // BEFORE ranking so output ties and ranks are self-consistent.
  const scored = ids.map((id) => {
    let score = 0;
    for (const [type, value] of tokens[id]) {
      score += total / traitCounts.get(`${type}::${value}`);
    }
    return { id, score: Math.round(score * 10000) / 10000 };
  });

  // Dense rank by score desc: equal scores share a rank, next distinct score
  // gets rank+1.
  scored.sort((a, b) => b.score - a.score);
  const rarity = {};
  let rank = 0;
  let prevScore = null;
  for (const t of scored) {
    if (t.score !== prevScore) { rank++; prevScore = t.score; }
    rarity[t.id] = { rank, score: t.score };
  }

  return { rarity, traitCount: traitCounts.size, scored };
}

// ═══ Main ═══
async function main() {
  const tokens = loadCheckpoint();
  const pending = [];
  for (let id = 0; id < LIMIT; id++) {
    if (!(String(id) in tokens)) pending.push(id);
  }
  const resumed = LIMIT - pending.length;

  console.log(`compute-rarity: ${LIMIT} tokens (${resumed} from checkpoint, ${pending.length} to fetch), concurrency ${CONCURRENCY}`);
  console.log(`  metadata: ${METADATA_BASE}/<id>`);
  console.log(`  out:      ${OUT_PATH}`);

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    console.log('\nSIGINT — saving checkpoint before exit...');
    saveCheckpoint(tokens);
    process.exit(130);
  });

  const started = Date.now();
  let done = 0;
  let sinceSave = 0;
  const failures = [];

  // Worker pool over the pending-id queue.
  let cursor = 0;
  async function worker() {
    while (!interrupted) {
      const idx = cursor++;
      if (idx >= pending.length) return;
      const id = pending[idx];
      try {
        tokens[String(id)] = await fetchToken(id);
      } catch (err) {
        failures.push(String(err.message || err));
        continue;
      }
      done++;
      sinceSave++;
      if (sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        saveCheckpoint(tokens);
        const elapsed = (Date.now() - started) / 1000;
        const rate = done / elapsed;
        const eta = (pending.length - done) / rate;
        console.log(`  ${resumed + done}/${LIMIT} tokens (${rate.toFixed(1)}/s, ~${Math.round(eta)}s remaining)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length || 1) }, worker));

  saveCheckpoint(tokens);

  if (failures.length > 0) {
    console.error(`\n${failures.length} token(s) failed after retries — output NOT written (checkpoint saved; rerun to resume).`);
    for (const f of failures.slice(0, 10)) console.error(`  ${f}`);
    process.exit(1);
  }

  const fetched = Object.keys(tokens).filter((id) => Number(id) < LIMIT);
  if (fetched.length !== LIMIT) {
    console.error(`\nExpected ${LIMIT} tokens, have ${fetched.length} — output NOT written.`);
    process.exit(1);
  }

  // Score only ids < LIMIT (a full-run checkpoint may hold more than a --limit run needs).
  const subset = {};
  for (const id of fetched) subset[id] = tokens[id];
  const { rarity, traitCount, scored } = computeScores(subset);

  const out = {
    generatedAt: new Date().toISOString(),
    totalTokens: LIMIT,
    traitCount, // distinct trait_type::value pairs seen across the set
    rarity,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
  fs.renameSync(tmp, OUT_PATH);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s: ${LIMIT} tokens, ${traitCount} distinct traits.`);
  console.log(`Rarest 5: ${scored.slice(0, 5).map((t) => `#${t.id} (rank ${rarity[t.id].rank}, score ${t.score})`).join(', ')}`);
  console.log(`Wrote ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(0)} KB)`);
  if (LIMIT < SUPPLY) {
    console.log(`NOTE: sample run (--limit ${LIMIT}) — do not ship this file; rerun without --limit for the real ${SUPPLY}-token output.`);
  }
}

main().catch((err) => {
  console.error(`compute-rarity failed: ${err.message || err}`);
  process.exit(1);
});
