#!/usr/bin/env node
/**
 * Does every `poolKind: 'ladder'` pool in frontend/src/lib/bungalows.ts run the fixed
 * LighthouseLadder build? Reads code, totalBoosted(), MIN_STAKE()/MIN_BOOST(), the exit
 * (EARLY_EXIT_PENALTY_BPS() on the retired flat builds; MAX_EARLY_EXIT_PENALTY_BPS() and a
 * penaltyFor() quote on the ladder's-law build) and totalSupply/rewardRate/periodFinish;
 * never sends a transaction. Exit 0 = all fixed, 1 = any pre-fix, unaudited or UNREADABLE pool. Flags: --json, --self-test,
 * --rpc-eth URL, --rpc-base URL, --rpc-robinhood URL (or ETH_RPC, BASE_RPC, RH_RPC).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', 'frontend', 'src', 'lib', 'bungalows.ts');

/**
 * Fallback lists, not single URLs. Base endpoints answer a non-browser User-Agent
 * with a 403 that looks exactly like "node down", hence a browser UA and a second
 * endpoint behind the first.
 */
const DEFAULT_RPC = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  base: ['https://mainnet.base.org', 'https://base.drpc.org'],
  // No room ladder lives here yet (2026-10-18); listed so the first one is read, not skipped.
  robinhood: ['https://rpc.mainnet.chain.robinhood.com'],
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
  EARLY_EXIT_PENALTY_BPS: '0x5c82a112', // cast sig "EARLY_EXIT_PENALTY_BPS()" (the retired flat builds)
  MAX_EARLY_EXIT_PENALTY_BPS: '0x5efd5ee9', // cast sig "MAX_EARLY_EXIT_PENALTY_BPS()" (the ladder's law)
};
/** cast sig "penaltyFor(uint256,uint64)"; the two arguments are appended, each 32 bytes. */
const PENALTY_FOR_SEL = '0xf10b1600';
const ONE_TOKEN = 10n ** 18n;
const YEAR_SECS = 365n * 86_400n;
const word = (v) => v.toString(16).padStart(64, '0');
export const penaltyForCalldata = (amount, lockEnd) => PENALTY_FOR_SEL + word(amount) + word(lockEnd);

/** The audited post-fix constants. A ladder that answers anything else is not this build. */
export const AUDITED_MIN_STAKE = 100n * 10n ** 18n;
/** MIN_BOOST = MIN_STAKE * MIN_BOOST_BPS / BPS, with MIN_BOOST_BPS = 4_000, BPS = 10_000. */
export const AUDITED_MIN_BOOST = (AUDITED_MIN_STAKE * 4000n) / 10000n;
/**
 * Owner, 2026-10-18: the room ladders keep the ladder's law, the time left over four
 * years capped at 75%. The build the deploy script ships answers this cap and quotes
 * exactly 25% with one year left (ONE_YEAR_QUOTE, within the drift of a block or two).
 */
export const AUDITED_EXIT_CAP_BPS = 7500n;
export const ONE_YEAR_QUOTE = ONE_TOKEN / 4n;
export const QUOTE_TOLERANCE = 10n ** 14n; // about 3.5 hours of schedule, far from any flat rate
/** The 2026-09-05 six charge this flat rate. Retired 2026-10-18; redeploy pending. */
export const RETIRED_FLAT_EXIT_BPS = 2500n;
/**
 * The exit the SITE says the shipped ladders charge: `LIVE_LADDER_EXIT_SCHEDULE` and
 * `LIVE_LADDER_EXIT_BPS` in frontend/src/lib/lighthouseLadder.ts, read as text like
 * the registry. A shipped pool whose exit differs from that pair fails here, so a
 * repin that forgets the switch, or a switch flipped before the repin, is caught by
 * the daily job.
 */
const LIVE_SWITCH = join(HERE, '..', 'frontend', 'src', 'lib', 'lighthouseLadder.ts');
export function parseLiveExit(src) {
  const sched = /export const LIVE_LADDER_EXIT_SCHEDULE: 'flat' \| 'time-left' = '(flat|time-left)';/.exec(src);
  const bps = /export const LIVE_LADDER_EXIT_BPS = ([\d_]+)n;/.exec(src);
  if (!sched || !bps) throw new Error('LIVE_LADDER_EXIT_SCHEDULE / LIVE_LADDER_EXIT_BPS not found in lighthouseLadder.ts');
  return { schedule: sched[1], bps: BigInt(bps[1].replace(/_/g, '')) };
}

// ── registry parsing (pure, self-tested) ──────────────────────────────────

/**
 * Every ladder pool in the real bungalows.ts, never a hand-kept copy: a guard that
 * reads its own list proves nothing about what the app serves. One entry per line
 * there, so a per-line scan is exact.
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
 * What a pool IS, from its reads; `null` means reverted or empty, never 0. The
 * discriminator is totalBoosted(): every ladder build answers it and no plain pool
 * does, while a pre-fix ladder and a plain pool both revert MIN_STAKE().
 * FundLighthouseStaking.s.sol tests the same way, so funding and shipping agree.
 */
export function classify(
  { codeBytes, totalBoosted, minStake, minBoost, flatExit, exitCap, yearQuote },
  { live = { schedule: 'time-left', bps: AUDITED_EXIT_CAP_BPS } } = {},
) {
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
  // The exit, in one of the two shapes that ever shipped. A flat rate answers
  // EARLY_EXIT_PENALTY_BPS; the ladder's law answers the cap and quotes one year
  // left at 25% (a flat 75% answers the cap too, and fails the quote).
  let shape;
  let build;
  if (flatExit !== null && flatExit !== undefined) {
    if (flatExit !== RETIRED_FLAT_EXIT_BPS) {
      return { build: 'unaudited', ok: false, note: `a flat EARLY_EXIT_PENALTY_BPS of ${flatExit}: no build ever shipped that` };
    }
    shape = { schedule: 'flat', bps: flatExit };
    build = 'exit25';
  } else if (exitCap !== null && exitCap !== undefined) {
    const quoteOk = typeof yearQuote === 'bigint' && (yearQuote > ONE_YEAR_QUOTE ? yearQuote - ONE_YEAR_QUOTE : ONE_YEAR_QUOTE - yearQuote) <= QUOTE_TOLERANCE;
    if (exitCap !== AUDITED_EXIT_CAP_BPS || !quoteOk) {
      return { build: 'unaudited', ok: false, note: `exit cap ${exitCap}, one year left quotes ${yearQuote}: not the ladder's law (cap 7500, 25% with a year left)` };
    }
    shape = { schedule: 'time-left', bps: exitCap };
    build = 'fixed';
  } else {
    return { build: 'unaudited', ok: false, note: 'answers neither a flat exit nor a cap' };
  }
  if (shape.schedule !== live.schedule || shape.bps !== live.bps) {
    // The site says one exit and this pool charges another: whichever side is
    // stale, it must not ship.
    return { build, ok: false, note: `the site says ${live.schedule} ${Number(live.bps) / 100}% (LIVE_LADDER_EXIT_*), this pool charges ${shape.schedule} ${Number(shape.bps) / 100}%` };
  }
  return build === 'fixed'
    ? { build, ok: true, note: "the ladder's law: time left over four years, capped at 75%" }
    : { build, ok: true, note: 'WARN: the flat 25% build, retired 2026-10-18; redeploy pending (docs/LADDER_EXIT_75_REDEPLOY.md)' };
}

/** Is the replace-vs-migrate window still open for this pool? */
export function isReplaceable({ totalSupply, rewardRate, periodFinish }) {
  return totalSupply === 0n && rewardRate === 0n && periodFinish === 0n;
}

// ── chain I/O ─────────────────────────────────────────────────────────────

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimum gap between outbound calls, not only between retries: a public node
// serves about five rapid calls then 429s, and each pool takes seven. Measured on
// the six shipped ladders: unpaced 5 of 6 unreadable, paced and 429-aware 0 of 6.
const MIN_CALL_GAP_MS = 450;
let lastCallAt = 0;
async function pace() {
  const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
  if (wait > 0) await nap(wait);
  lastCallAt = Date.now();
}

/**
 * Only an execution revert is the contract answering; a rate limit, auth error or
 * missing method is the endpoint refusing, even under HTTP 200. classify() reads a
 * null totalBoosted as a fine plain pool, so a throttle misread as a revert would
 * certify a pre-fix ladder. Allowlist reverts; refuse the rest.
 */
function isExecutionRevert(err) {
  if (!err || typeof err !== 'object') return false;
  // eth_call revert: geth/reth use code 3; some nodes use -32000 with the text.
  if (err.code === 3) return true;
  return err.code === -32000 && /execution reverted|revert/i.test(String(err.message ?? ''));
}

/**
 * One JSON-RPC call across every endpoint for the chain. `transport: false` means
 * no answer, and the caller must not classify; `transport: true, value: null`
 * means the call REVERTED, which is an answer.
 */
async function rpcCall(urls, method, params) {
  for (const url of urls) {
    // Back off between attempts: two back-to-back tries at a throttled endpoint
    // fail for the same reason.
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
      // A 429 means the window is full and clears on its own: wait it out rather
      // than retry at once or move to the next endpoint's limiter.
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

async function latestTimestamp(urls) {
  const r = await rpcCall(urls, 'eth_getBlockByNumber', ['latest', false]);
  if (!r.transport || !r.raw || typeof r.raw.timestamp !== 'string') return null;
  return BigInt(r.raw.timestamp);
}

async function inspect(pool, rpc, live) {
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

  // The schedule's one-year point, quoted at the chain's own clock (not this
  // machine's): a block or two of drift is inside QUOTE_TOLERANCE.
  let yearQuote = null;
  if (reads.MAX_EARLY_EXIT_PENALTY_BPS !== null) {
    const now = await latestTimestamp(url);
    if (now === null) return { ...pool, unreadable: true, note: 'eth_getBlockByNumber failed (transport)' };
    const q = await ethCall(url, pool.stakePool, penaltyForCalldata(ONE_TOKEN, now + YEAR_SECS));
    if (!q.transport) return { ...pool, unreadable: true, note: 'eth_call penaltyFor failed (transport)' };
    yearQuote = q.value;
  }

  const verdict = classify({
    codeBytes,
    totalBoosted: reads.totalBoosted,
    minStake: reads.MIN_STAKE,
    minBoost: reads.MIN_BOOST,
    flatExit: reads.EARLY_EXIT_PENALTY_BPS,
    exitCap: reads.MAX_EARLY_EXIT_PENALTY_BPS,
    yearQuote,
  }, { live });
  return {
    ...pool,
    codeBytes,
    ...verdict,
    replaceable: isReplaceable({
      totalSupply: reads.totalSupply ?? 0n,
      rewardRate: reads.rewardRate ?? 0n,
      periodFinish: reads.periodFinish ?? 0n,
    }),
    reads: { ...reads, yearQuote },
  };
}

// ── self-test ─────────────────────────────────────────────────────────────

function selfTest() {
  const fails = [];
  let checked = 0;
  const eq = (label, got, want) => {
    checked++;
    if (got !== want) fails.push(`${label}: got ${got}, want ${want}`);
  };

  const SRC = [
    `  { id: 'pepe', chain: 'ethereum', stakePool: '0xBE1905de5FCDe60E13a9F1AfA44BEfdE1C5aaA1D', poolKind: 'ladder', live: true },`,
    `  { id: 'bobo', chain: 'solana', stakePool: 'PkwDYVNxyesAukE9STqRQL9H1pBpXbt1tVbiYVMX96w', live: true },`,
    `  { id: 'qr', chain: 'base', stakePool: '0x55B72f09d31f43834bf7Eba42f53a419a716F554', poolKind: 'ladder', live: true },`,
  ].join('\n');
  const parsed = parseLadders(SRC);
  eq('parse: ladder count', parsed.length, 2);
  eq('parse: skips non-ladder', parsed.some((p) => p.id === 'bobo'), false);
  eq('parse: chain', parsed[0].chain, 'ethereum');

  // An infrastructure error is NOT the contract answering: misfiled as a revert,
  // it would certify a pre-fix ladder as a fine plain pool. Reverts in, rest out.
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
  const LAW = { schedule: 'time-left', bps: 7500n };
  const FLAT25 = { schedule: 'flat', bps: 2500n };
  const fixed = { codeBytes: 6500, totalBoosted: 0n, minStake: AUDITED_MIN_STAKE, minBoost: AUDITED_MIN_BOOST, flatExit: null, exitCap: AUDITED_EXIT_CAP_BPS, yearQuote: ONE_YEAR_QUOTE };
  eq('classify fixed', classify(fixed, { live: LAW }).build, 'fixed');
  eq('classify fixed ok', classify(fixed, { live: LAW }).ok, true);
  // A block of drift on the one-year quote is still the law; a flat 75% is not.
  eq('classify fixed, quote a few seconds off', classify({ ...fixed, yearQuote: ONE_YEAR_QUOTE - 10n ** 11n }, { live: LAW }).ok, true);
  eq('classify flat 75 behind a cap is unaudited', classify({ ...fixed, yearQuote: (ONE_TOKEN * 3n) / 4n }, { live: LAW }).build, 'unaudited');
  eq('classify cap 25 is unaudited', classify({ ...fixed, exitCap: 2500n }, { live: LAW }).build, 'unaudited');
  eq('classify unread quote is not ok', classify({ ...fixed, yearQuote: null }, { live: LAW }).ok, false);
  // The flat 25% six: a WARN while the site says flat 25%, a FAIL once the site says the
  // law; and a law pool fails while the site still says flat 25%. Both sides are held.
  const exit25 = { ...fixed, flatExit: RETIRED_FLAT_EXIT_BPS, exitCap: null, yearQuote: null };
  eq('classify exit25 build', classify(exit25, { live: FLAT25 }).build, 'exit25');
  eq('classify exit25 ok while the site says flat 25%', classify(exit25, { live: FLAT25 }).ok, true);
  eq('classify exit25 warns', /WARN/.test(classify(exit25, { live: FLAT25 }).note), true);
  eq('classify exit25 fails once the site says the law', classify(exit25, { live: LAW }).ok, false);
  eq('classify fixed fails while the site says flat 25%', classify(fixed, { live: FLAT25 }).ok, false);
  eq('classify odd flat exit', classify({ ...exit25, flatExit: 5000n }, { live: FLAT25 }).build, 'unaudited');
  eq('classify no exit getter at all', classify({ ...fixed, exitCap: null, yearQuote: null }, { live: LAW }).ok, false);
  const sw = parseLiveExit("export const LIVE_LADDER_EXIT_SCHEDULE: 'flat' | 'time-left' = 'flat';\nexport const LIVE_LADDER_EXIT_BPS = 2_500n;\n");
  eq('parse live switch schedule', sw.schedule, 'flat');
  eq('parse live switch bps', sw.bps, 2500n);
  eq('parse live switch law', parseLiveExit("export const LIVE_LADDER_EXIT_SCHEDULE: 'flat' | 'time-left' = 'time-left';\nexport const LIVE_LADDER_EXIT_BPS = 7_500n;").schedule, 'time-left');
  let threw = false;
  try { parseLiveExit('nothing here'); } catch { threw = true; }
  eq('parse live switch missing throws', threw, true);
  eq('penaltyFor calldata', penaltyForCalldata(ONE_TOKEN, 1800000000n), '0xf10b16000000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000006b49d200');
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
  console.log(`self-test: ${checked} assertions passed`);
  process.exit(0);
}

// ── main ──────────────────────────────────────────────────────────────────
//
// Guarded so importing this module (its pure functions are exported for tests)
// does not fire network calls and then `process.exit` out of the test runner.
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
 * A preferred endpoint goes to the FRONT of the list and never replaces it: one
 * throttled host would turn a correct registry red. ETH_RPC, BASE_RPC and RH_RPC are
 * the names registry-onchain.yml binds. The fallbacks see only read-only public calls.
 */
const prefer = (chosen, defaults) =>
  chosen ? [chosen, ...defaults.filter((u) => u !== chosen)] : defaults;

const rpc = {
  ethereum: prefer(arg('--rpc-eth') ?? process.env.ETH_RPC, DEFAULT_RPC.ethereum),
  base: prefer(arg('--rpc-base') ?? process.env.BASE_RPC, DEFAULT_RPC.base),
  robinhood: prefer(arg('--rpc-robinhood') ?? process.env.RH_RPC, DEFAULT_RPC.robinhood),
};

const ladders = parseLadders(readFileSync(REGISTRY, 'utf8'));
if (ladders.length === 0) {
  console.error('No ladder pools found in the registry — refusing to report a vacuous pass.');
  process.exit(1);
}

const live = parseLiveExit(readFileSync(LIVE_SWITCH, 'utf8'));
const rows = [];
for (const pool of ladders) rows.push(await inspect(pool, rpc, live));

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
  console.log(`${pad('pool', 8)}${pad('chain', 10)}${pad('bytes', 7)}${pad('build', 11)}${pad('exit', 10)}${pad('window', 13)}note`);
  for (const r of rows) {
    const build = r.unreadable ? 'UNREADABLE' : r.build;
    const win = r.unreadable ? '-' : r.replaceable ? 'replaceable' : 'CLOSED';
    const flat = r.reads?.EARLY_EXIT_PENALTY_BPS;
    const cap = r.reads?.MAX_EARLY_EXIT_PENALTY_BPS;
    const exit = typeof flat === 'bigint' ? `${Number(flat) / 100}% flat` : typeof cap === 'bigint' ? `law<=${Number(cap) / 100}%` : '-';
    console.log(`${pad(r.id, 8)}${pad(r.chain, 10)}${pad(r.codeBytes ?? '-', 7)}${pad(build, 11)}${pad(exit, 10)}${pad(win, 13)}${r.note}`);
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
if (!asJson) {
  const warned = rows.filter((r) => r.build === 'exit25').length;
  console.log(
    warned
      ? `\nOK with ${warned} WARN: ${rows.length - warned} of ${rows.length} shipped ladders run the ladder's law; ${warned} still charge the retired flat 25% (redeploy pending).`
      : `\nOK: all ${rows.length} shipped ladders run the audited fixed build.`,
  );
}
process.exit(0);
}
