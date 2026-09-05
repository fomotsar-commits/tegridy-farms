#!/usr/bin/env node
/**
 * Does every ladder pool the APP SHIPS run the fixed bytecode?
 *
 * WHY THIS EXISTS
 * ---------------
 * The LighthouseLadder dust-divisor bug (3 wei of principal captures the whole
 * emission stream) was fixed in SOURCE by PR #374. Source edits do not change
 * deployed bytecode, so six live pools still carry the vulnerable build. They are
 * inert only because nobody has funded them.
 *
 * Two guards already exist and both are real:
 *   - DeployLighthouseLadder    L-INV-11/12: a pre-fix BUILD cannot be deployed unnoticed.
 *   - FundLighthouseStaking     PR #393: refuses to fund a pre-fix ladder outright.
 *
 * Neither covers the gap between them. `docs/LIGHTHOUSE_AUDIT_2026_09_01.md:96` (C4)
 * named it: between a redeploy and the MANUAL registry repoint, the only ladder
 * addresses written down anywhere — `frontend/src/lib/bungalows.ts`, `addresses.json`,
 * every one marked live — are still the SIX VULNERABLE ONES. Funding is blocked, so
 * the money is safe; what is not blocked is SHIPPING A UI that points real users at
 * pre-fix pools, and a repoint that is forgotten fails silently in exactly that way.
 *
 * So this reads the registry the app actually ships and asks the chain about every
 * ladder in it. A receipt is not proof of state; the registry is not proof of state.
 *
 * WHAT IT CHECKS, per `poolKind: 'ladder'` entry
 * ----------------------------------------------
 *   eth_getCode        the address is a contract at all
 *   totalBoosted()     it IS a ladder (no plain vendored StakingRewards answers this)
 *   MIN_STAKE()        it is the FIXED ladder, and equals the audited 100e18
 *   MIN_BOOST()        derives from MIN_STAKE, so a half-applied fix is caught
 *   totalSupply() / rewardRate() / periodFinish()
 *                      whether the replace-vs-migrate window is still open
 *
 * THE DISCRIMINATOR IS `totalBoosted()`, NOT `MIN_STAKE()`, and that is not a style
 * choice: a PRE-FIX LADDER and a PLAIN pool BOTH revert `MIN_STAKE()`, so that
 * selector alone cannot separate "vulnerable" from "legitimately has no floor".
 * Every ladder build answers `totalBoosted()`; no plain pool does. Same reasoning as
 * FundLighthouseStaking.s.sol — kept identical on purpose, so the funding gate and
 * the shipping gate can never disagree about what a pre-fix ladder looks like.
 *
 * USAGE
 *   node scripts/verify-ladder-builds.mjs
 *   node scripts/verify-ladder-builds.mjs --json
 *   node scripts/verify-ladder-builds.mjs --self-test
 *   node scripts/verify-ladder-builds.mjs --rpc-eth https://… --rpc-base https://…
 *   ETH_RPC=… BASE_RPC=… node scripts/verify-ladder-builds.mjs
 *
 * Exit 0 = every shipped ladder runs the fixed build. Exit 1 = at least one does not,
 * or could not be read. Read-only: it never sends a transaction.
 *
 * ⚠️ AN UNREADABLE POOL IS A FAILURE, NOT A PASS. An RPC outage must not be able to
 * certify a vulnerable registry — see [[reference_unreadable_must_not_read_as_fine]].
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', 'frontend', 'src', 'lib', 'bungalows.ts');

/**
 * Fallback lists, not single URLs.
 *
 * ⚠️ Base endpoints REJECT a non-browser User-Agent — a bespoke agent string gets a
 * 403 that is indistinguishable from "the node is down". A guard that cannot read
 * Base fails every run, and a guard that always fails is one people stop reading. So:
 * a browser UA, and a second endpoint behind the first.
 */
const DEFAULT_RPC = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  base: ['https://mainnet.base.org', 'https://base.drpc.org'],
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Selectors, derived with `cast sig "<sig>"` rather than memorised.
 * A wrong selector cannot silently produce a wrong answer here: an absent one
 * reverts or returns empty, and that is reported as `absent`, never coerced to a value.
 */
const SEL = {
  totalSupply: '0x18160ddd', // cast sig "totalSupply()"
  rewardRate: '0x7b0a47ee', // cast sig "rewardRate()"
  periodFinish: '0xebe2b12b', // cast sig "periodFinish()"
  MIN_STAKE: '0xcb1c2b5c', // cast sig "MIN_STAKE()"
  MIN_BOOST: '0x0a7486c7', // cast sig "MIN_BOOST()"
  totalBoosted: '0x631516c2', // cast sig "totalBoosted()"
};

/** The audited post-fix constants. A ladder that answers anything else is not this build. */
export const AUDITED_MIN_STAKE = 100n * 10n ** 18n;
/** MIN_BOOST = MIN_STAKE * MIN_BOOST_BPS / BPS, with MIN_BOOST_BPS = 4_000, BPS = 10_000. */
export const AUDITED_MIN_BOOST = (AUDITED_MIN_STAKE * 4000n) / 10000n;

// ── registry parsing (pure, self-tested) ──────────────────────────────────

/**
 * Pull every ladder pool out of the shipped registry.
 *
 * Deliberately parses the REAL `bungalows.ts` rather than a hand-kept address list:
 * a guard that reads its own copy of the addresses proves nothing about what the app
 * serves, which is the entire failure this file exists to catch.
 *
 * One entry per line in that file, so a per-line scan is exact and needs no TS parser.
 */
export function parseLadders(src) {
  const out = [];
  for (const line of src.split('\n')) {
    if (!line.includes("poolKind: 'ladder'")) continue;
    const id = /\bid:\s*'([^']+)'/.exec(line)?.[1];
    const chain = /\bchain:\s*'([^']+)'/.exec(line)?.[1];
    const stakePool = /\bstakePool:\s*'(0x[0-9a-fA-F]{40})'/.exec(line)?.[1];
    const live = /\blive:\s*true\b/.test(line);
    if (id && chain && stakePool) out.push({ id, chain, stakePool, live });
  }
  return out;
}

// ── classification (pure, self-tested) ────────────────────────────────────

/**
 * Decide what a pool IS from the four reads.
 *
 * `null` means the call reverted or returned nothing — the caller must pass null,
 * never 0, for an absent selector. Collapsing "reverted" into "returned zero" is how
 * a vulnerable pool would classify as a fixed one with a zero floor.
 */
export function classify({ codeBytes, totalBoosted, minStake, minBoost }) {
  if (!codeBytes) return { build: 'absent', ok: false, note: 'no contract at this address' };
  if (totalBoosted === null) {
    return { build: 'plain', ok: true, note: 'vendored StakingRewards — no ladder, no floor by design' };
  }
  if (minStake === null) {
    return { build: 'prefix', ok: false, note: 'PRE-FIX LADDER — carries the dust-divisor bug' };
  }
  if (minStake !== AUDITED_MIN_STAKE) {
    return { build: 'unaudited', ok: false, note: `MIN_STAKE is ${minStake}, not the audited ${AUDITED_MIN_STAKE}` };
  }
  if (minBoost !== null && minBoost !== AUDITED_MIN_BOOST) {
    // A floor that does not match its own boost derivation is a half-applied fix.
    return { build: 'unaudited', ok: false, note: `MIN_BOOST ${minBoost} does not derive from MIN_STAKE` };
  }
  return { build: 'fixed', ok: true, note: 'post-fix ladder, audited constants' };
}

/** Is the replace-vs-migrate window still open for this pool? */
export function isReplaceable({ totalSupply, rewardRate, periodFinish }) {
  return totalSupply === 0n && rewardRate === 0n && periodFinish === 0n;
}

// ── chain I/O ─────────────────────────────────────────────────────────────

/**
 * One JSON-RPC call, tried across every endpoint for the chain.
 *
 * Returns `{ transport, value }`. The distinction is load-bearing:
 *   transport:false  we never got an answer      -> the caller must NOT classify
 *   transport:true, value:null   the call REVERTED (selector absent) -> a real answer
 * Collapsing those two is how an outage would certify a vulnerable pool as fine.
 */
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimum gap between OUTBOUND calls, not just between retries.
 *
 * Backoff alone was not enough: a public node serves roughly five rapid calls
 * then 429s for a while, and this script makes seven per pool (eth_getCode plus
 * six selectors). Retrying a request that was rejected for arriving too fast,
 * without slowing the ones that follow, just walks the whole run into the limiter.
 * Pacing the stream is what fixes it. MEASURED on the six shipped ladders:
 * unpaced 5 of 6 UNREADABLE, backoff-only 3 of 6, paced + 429-aware 0 of 6.
 *
 * A guard that reads the chain is allowed to be slow. It is not allowed to be wrong.
 */
const MIN_CALL_GAP_MS = 450;
let lastCallAt = 0;
async function pace() {
  const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
  if (wait > 0) await nap(wait);
  lastCallAt = Date.now();
}

/**
 * Is this JSON-RPC error the CONTRACT answering, or the INFRASTRUCTURE refusing?
 *
 * Only an execution revert is an answer about the contract. Everything else --
 * rate limits, auth, method-not-found, an overloaded node -- is an endpoint
 * problem wearing an error's clothes.
 *
 * MEASURED 2026-09-05: mainnet.base.org returns `-32016 over rate limit` with
 * HTTP **429**, so `!res.ok` already caught it and this path was never the live
 * bug. But `if (j.error)` accepted ANY error as a revert, and an endpoint that
 * returns a rate limit with HTTP 200 is entirely ordinary. That path is the
 * dangerous direction and it is one line to close: `classify()` reads a null
 * `totalBoosted` as `build: 'plain', ok: TRUE`, so a throttled read there would
 * certify a vulnerable ladder as a fine plain pool -- the exact collapse the
 * header of this file says must never happen. Allowlist reverts; refuse the rest.
 */
function isExecutionRevert(err) {
  if (!err || typeof err !== 'object') return false;
  // eth_call revert: geth/reth use code 3; some nodes use -32000 with the text.
  if (err.code === 3) return true;
  return err.code === -32000 && /execution reverted|revert/i.test(String(err.message ?? ''));
}

async function rpcCall(urls, method, params) {
  for (const url of urls) {
    // Backoff, not just repetition. Two back-to-back attempts against a throttled
    // endpoint both fail for the same reason, exhaust every URL, and report
    // `transport:false`. That is why 5 of 6 Base ladders read UNREADABLE on the
    // 2026-09-05 trunk run while answering a paced client perfectly: a public node
    // serves ~5 rapid calls then 429s, and this script makes 6 per pool.
    for (let attempt = 0; attempt < 5; attempt++) {
      await pace();
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
      } catch {
        await nap(600 * 2 ** attempt);
        continue; // network-level: try the next attempt / endpoint
      }
      // 429 is not a generic failure -- it is the node saying the window is full,
      // and it clears on its own. Treating it like a 5xx (retry at once, then move
      // to the next endpoint) walks straight into the next limiter. Wait it out.
      if (res.status === 429) {
        await nap(1500 * (attempt + 1)); // 1.5s / 3s / 4.5s / 6s
        continue;
      }
      if (!res.ok) {
        await nap(600 * 2 ** attempt);
        continue; // 403/5xx: an endpoint problem, not an answer
      }
      const j = await res.json().catch(() => null);
      if (!j) continue;
      if (j.error) {
        if (isExecutionRevert(j.error)) return { transport: true, value: null }; // a revert IS an answer
        continue; // infrastructure error: NOT an answer about the contract
      }
      return { transport: true, raw: j.result, value: null };
    }
  }
  return { transport: false, value: null };
}

async function ethCall(urls, to, data) {
  const r = await rpcCall(urls, 'eth_call', [{ to, data }, 'latest']);
  if (!r.transport) return { transport: false, value: null };
  if (r.raw === undefined) return { transport: true, value: null }; // reverted
  if (!r.raw || r.raw === '0x') return { transport: true, value: null };
  return { transport: true, value: BigInt(r.raw) };
}

async function getCodeBytes(urls, addr) {
  const r = await rpcCall(urls, 'eth_getCode', [addr, 'latest']);
  if (!r.transport || typeof r.raw !== 'string') return null;
  return (r.raw.length - 2) / 2;
}

async function inspect(pool, rpc) {
  const url = rpc[pool.chain];
  if (!url) return { ...pool, unreadable: true, note: `no RPC configured for chain "${pool.chain}"` };

  const codeBytes = await getCodeBytes(url, pool.stakePool);
  if (codeBytes === null) return { ...pool, unreadable: true, note: 'eth_getCode failed (transport)' };

  const reads = {};
  for (const [k, sel] of Object.entries(SEL)) {
    const { transport, value } = await ethCall(url, pool.stakePool, sel);
    // Transport failure is NOT "the selector is absent". Refuse to classify on it.
    if (!transport) return { ...pool, unreadable: true, note: `eth_call ${k} failed (transport)` };
    reads[k] = value;
  }

  const verdict = classify({
    codeBytes,
    totalBoosted: reads.totalBoosted,
    minStake: reads.MIN_STAKE,
    minBoost: reads.MIN_BOOST,
  });
  return {
    ...pool,
    codeBytes,
    ...verdict,
    replaceable: isReplaceable({
      totalSupply: reads.totalSupply ?? 0n,
      rewardRate: reads.rewardRate ?? 0n,
      periodFinish: reads.periodFinish ?? 0n,
    }),
    reads,
  };
}

// ── self-test ─────────────────────────────────────────────────────────────

function selfTest() {
  const fails = [];
  const eq = (label, got, want) => {
    if (got !== want) fails.push(`${label}: got ${got}, want ${want}`);
  };

  const SRC = [
    `  { id: 'pepe', chain: 'ethereum', stakePool: '0xdC0B34cE782029f30382F42097f6b33F0544329c', poolKind: 'ladder', live: true },`,
    `  { id: 'bobo', chain: 'solana', stakePool: 'PkwDYVNx', live: true },`,
    `  { id: 'qr', chain: 'base', stakePool: '0xdcc3a95A0921b83326157132B17770f02094c8E3', poolKind: 'ladder', live: true },`,
  ].join('\n');
  const parsed = parseLadders(SRC);
  eq('parse: ladder count', parsed.length, 2);
  eq('parse: skips non-ladder', parsed.some((p) => p.id === 'bobo'), false);
  eq('parse: chain', parsed[0].chain, 'ethereum');

  // An infrastructure error is NOT the contract answering. This is the guard on the
  // one path where a wrong call is SILENT: classify() reads a null totalBoosted as
  // `plain, ok: true`, so a throttled read misfiled as a revert certifies a
  // vulnerable ladder as fine. Reverts in, everything else out.
  eq('revert: geth code 3', isExecutionRevert({ code: 3, message: 'execution reverted' }), true);
  eq('revert: -32000 text', isExecutionRevert({ code: -32000, message: 'execution reverted' }), true);
  eq('revert: rate limit is NOT', isExecutionRevert({ code: -32016, message: 'over rate limit' }), false);
  eq('revert: -32005 limit is NOT', isExecutionRevert({ code: -32005, message: 'limit exceeded' }), false);
  eq('revert: method missing is NOT', isExecutionRevert({ code: -32601, message: 'method not found' }), false);
  eq('revert: null is NOT', isExecutionRevert(null), false);

  // The classification that matters most: pre-fix must NEVER read as ok.
  eq('classify prefix', classify({ codeBytes: 6098, totalBoosted: 0n, minStake: null, minBoost: null }).build, 'prefix');
  eq('classify prefix not ok', classify({ codeBytes: 6098, totalBoosted: 0n, minStake: null, minBoost: null }).ok, false);
  // A plain pool also reverts MIN_STAKE — it must NOT be called vulnerable.
  eq('classify plain', classify({ codeBytes: 4000, totalBoosted: null, minStake: null, minBoost: null }).build, 'plain');
  eq('classify plain ok', classify({ codeBytes: 4000, totalBoosted: null, minStake: null, minBoost: null }).ok, true);
  eq('classify fixed', classify({ codeBytes: 6500, totalBoosted: 0n, minStake: AUDITED_MIN_STAKE, minBoost: AUDITED_MIN_BOOST }).build, 'fixed');
  // A floor that is present but wrong is not the audited build.
  eq('classify moved floor', classify({ codeBytes: 6500, totalBoosted: 0n, minStake: 1n, minBoost: null }).build, 'unaudited');
  eq('classify drifted boost', classify({ codeBytes: 6500, totalBoosted: 0n, minStake: AUDITED_MIN_STAKE, minBoost: 1n }).build, 'unaudited');
  eq('classify absent', classify({ codeBytes: 0, totalBoosted: null, minStake: null, minBoost: null }).build, 'absent');

  eq('replaceable when inert', isReplaceable({ totalSupply: 0n, rewardRate: 0n, periodFinish: 0n }), true);
  eq('not replaceable once staked', isReplaceable({ totalSupply: 1n, rewardRate: 0n, periodFinish: 0n }), false);
  eq('not replaceable once funded', isReplaceable({ totalSupply: 0n, rewardRate: 5n, periodFinish: 0n }), false);

  eq('MIN_BOOST derives', AUDITED_MIN_BOOST, 40n * 10n ** 18n);

  if (fails.length) {
    console.error('SELF-TEST FAILED:');
    for (const f of fails) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`self-test: ${13} assertions passed`);
  process.exit(0);
}

// ── main ──────────────────────────────────────────────────────────────────
//
// Guarded so IMPORTING this module does not run the CLI. `parseLadders`,
// `classify` and `isReplaceable` are exported for unit tests, and without this an
// `import` would fire the whole thing — network calls, then `process.exit` out of
// the test runner. A module that hijacks its own importer cannot be tested.
const IS_ENTRYPOINT =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_ENTRYPOINT) await main();

async function main() {
const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

if (argv.includes('--self-test')) selfTest();

/**
 * A preferred endpoint goes to the FRONT of the list; it does not replace it.
 *
 * `ETH_RPC`/`BASE_RPC` mirror the names registry-onchain.yml already binds, so
 * pointing that workflow at a paid endpoint moves this check with it. But
 * REPLACING the list would strand the guard on one host: this check's failure mode
 * is "could not read, therefore FAIL", so a single throttled endpoint turns a
 * correct registry red — and a guard that cries wolf is one people stop reading.
 * Falling back to a public node leaks nothing: these are read-only eth_calls on
 * public addresses.
 */
const prefer = (chosen, defaults) =>
  chosen ? [chosen, ...defaults.filter((u) => u !== chosen)] : defaults;

const rpc = {
  ethereum: prefer(arg('--rpc-eth') ?? process.env.ETH_RPC, DEFAULT_RPC.ethereum),
  base: prefer(arg('--rpc-base') ?? process.env.BASE_RPC, DEFAULT_RPC.base),
};

const ladders = parseLadders(readFileSync(REGISTRY, 'utf8'));
if (ladders.length === 0) {
  console.error('No ladder pools found in the registry — refusing to report a vacuous pass.');
  process.exit(1);
}

const rows = [];
for (const pool of ladders) rows.push(await inspect(pool, rpc));

const asJson = argv.includes('--json');
if (asJson) {
  console.log(
    JSON.stringify(
      rows.map(({ reads, ...r }) => ({
        ...r,
        reads: reads ? Object.fromEntries(Object.entries(reads).map(([k, v]) => [k, v === null ? null : String(v)])) : undefined,
      })),
      null,
      2,
    ),
  );
} else {
  console.log('LADDER BUILDS SHIPPED BY THE REGISTRY (frontend/src/lib/bungalows.ts)\n');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('pool', 8)}${pad('chain', 10)}${pad('bytes', 7)}${pad('build', 11)}${pad('window', 13)}note`);
  for (const r of rows) {
    const build = r.unreadable ? 'UNREADABLE' : r.build;
    const win = r.unreadable ? '-' : r.replaceable ? 'replaceable' : 'CLOSED';
    console.log(`${pad(r.id, 8)}${pad(r.chain, 10)}${pad(r.codeBytes ?? '-', 7)}${pad(build, 11)}${pad(win, 13)}${r.note}`);
  }
}

const bad = rows.filter((r) => r.unreadable || !r.ok);
if (bad.length) {
  if (!asJson) {
    console.error(`\nFAIL: ${bad.length} of ${rows.length} shipped ladder(s) are not the audited fixed build.`);
    console.error('The registry points real users at these. Redeploy from the fixed source, then');
    console.error('repoint bungalows.ts + addresses.json BEFORE shipping a frontend or funding anything.');
    const stillOpen = rows.filter((r) => r.replaceable).length;
    console.error(`\n${stillOpen} of ${rows.length} are still inert, so a redeploy is a REPLACEMENT, not a migration.`);
    console.error('That window closes the moment anyone stakes.');
  }
  process.exit(1);
}
if (!asJson) console.log(`\nOK: all ${rows.length} shipped ladders run the audited fixed build.`);
process.exit(0);
}
