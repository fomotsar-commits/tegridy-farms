#!/usr/bin/env node
/**
 * Feature-gating environment verifier.
 *
 * WHY THIS EXISTS — the operator report, 2026-09-03.
 * The operator said the site "says coming soon for things that are live". An audit of
 * every "coming soon" surface in the frontend found that almost all of them are
 * UNREACHABLE dead branches — the gate constants are filled in and the placeholder can
 * never render. The ones a user actually sees are not driven by code at all. They are
 * driven by environment variables that were never set on the deploy.
 *
 * .env.example already says this, in its own words:
 *
 *   "Every one FAILS QUIET-CLOSED when unset: the feature is simply off, nothing
 *    logged — which is exactly why they must be documented, or a deploy silently
 *    ships with revenue/features dark."
 *
 * Documenting it was not enough, because nothing CHECKS it. A missing var produces no
 * error, no warning, and no log line — just a "Soon" pill on a finished feature, or a
 * swap surface that collects no fee. The failure is indistinguishable from the feature
 * genuinely not being built, which is precisely why it survived to a user report.
 *
 * So this is a CHECK, not a document. It enumerates the vars that turn shipped things
 * off, says what each one darkens, and reports which are currently unset. The
 * enumeration IS the documentation — the same shape as verify-addresses.mjs, and as the
 * source-level tripwire tests elsewhere in this repo: a named list cannot over-fire, and
 * reading the list tells you what is at stake.
 *
 * USAGE
 *   node scripts/verify-env.mjs                 # report; exit 0 always
 *   node scripts/verify-env.mjs --strict        # exit 1 if any REVENUE gate is dark
 *   node scripts/verify-env.mjs --strict-all    # exit 1 if any gate at all is dark
 *   node scripts/verify-env.mjs --env-file .env # also read vars from a file
 *
 * Run it against the DEPLOY environment, not a laptop. A local .env that is missing
 * everything is expected and means nothing about production.
 *
 * AMENDED 2026-09-04, and the amendment is the point. Two entries below overstated
 * their reach and have been corrected in place rather than quietly edited: the indexer
 * URL no longer pills any nav entry (PR #360 moved those to capability checks), and the
 * yield feed never did. A checker that overstates is the same failure as the deploy it
 * is meant to catch — it just fails in the other direction, and an operator who acts on
 * a false alarm here has been misled as surely as one who ships a dark feature. If a row
 * in this file ever disagrees with the code, the code wins and the row is the bug.
 */

import { readFileSync } from 'node:fs';

// ── The canonical BAYLA lighthouse pool ────────────────────────────────────
// Replaced on mainnet 2026-08-30. The first pool was created with maxWeight == 1.00x,
// so its 1-365 day lock picker bought nothing — every duration earned the same rate.
// maxWeight has no update instruction, so the fix was a new pool at a fresh nonce.
const BAYLA_POOL_CANONICAL = 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';
const BAYLA_POOL_RETIRED = '4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp';

/**
 * Every env var whose absence turns off something that is already built and shipped.
 * `severity`: 'revenue' = money is not being collected; 'features' = finished surfaces
 * present themselves to users as unfinished; 'disclosure' = something true is not being
 * SAID to users, and the value cannot be guessed here because it must match a setting
 * held outside this repo.
 */
const GATES = [
  {
    vars: ['VITE_INDEXER_URL'],
    // CORRECTED 2026-09-04. This entry used to say the five nav entries pill "Soon"
    // on this one var. That WAS true when this file was written and is not any more:
    // PR #360 re-pointed those surfaces at capability checks that do not need Ponder
    // (hasCopyTapeSource, hasScoreableBoard, hasChartableMarket, and /tax is now an
    // unconditional soon:false). Unset no longer hides a single nav entry.
    //
    // What it still costs is DATA, not visibility: the useIndexed* hooks self-gate to
    // an explicit "indexer unavailable" state, so the surfaces render and say they are
    // reading nothing rather than pretending to be empty.
    severity: 'features',
    darkens: 'indexed history on /terminal, /chart, /copy-trading, /competitions, /tax',
    effect: 'those surfaces render, and say plainly that the indexer is unavailable, rather than showing an empty result set that reads as "there is no data". The indexer is built (indexer/, indexer-solana/) and deployed on Railway behind an nginx proxy; this var is only the URL the frontend asks. Do NOT set it until /ready returns 200 — pointing at a mid-sync indexer is the exact empty-looks-like-zero failure the readiness gate exists to prevent.',
  },
  {
    vars: ['VITE_SWAP_FEE_BPS', 'VITE_SWAP_FEE_RECIPIENT'],
    severity: 'revenue',
    darkens: 'the EVM swap surface',
    effect: 'fee collection is OFF and the swap earns NOTHING, silently (lib/fees/swapFee.ts fails closed: unset => bps 0, recipient null). Both vars are required; a zero-address recipient is rejected because providers read it as "no partner" and keep the fee themselves.',
  },
  {
    vars: ['VITE_ONRAMP_PARTNER_FEE_BPS'],
    // NOT a revenue switch, and calling it one was wrong. This var COLLECTS NOTHING —
    // it is a DISCLOSURE mirror of a partner fee configured in the provider's own
    // dashboard (lib/onramp/partnerFee.ts). Unset means the fee is not DISCLOSED to the
    // user, not that it is not charged, so the honest reading of an unset value is the
    // opposite of the one this file first gave: money may be moving and going unsaid.
    // Setting it to a figure that does not match the provider is worse than leaving it
    // unset — that module's own docstring calls a mismatched rate "a false statement
    // about somebody's money". Note `0` is a valid DECLARATION of no partner fee and is
    // deliberately distinct from unset.
    severity: 'disclosure',
    darkens: 'the fiat on-ramp fee disclosure',
    effect: 'the partner fee is not disclosed to the user. Only the operator can supply this number, because it must equal what is configured at the provider — do not guess it.',
  },
  {
    vars: ['VITE_SOLANA_FEE_ACCOUNT'],
    severity: 'revenue',
    darkens: 'Solana swaps',
    effect: 'no fee is charged on Solana swaps. NOTE: this does NOT hide the surface — isSolanaSwapLive() returns true unconditionally and deliberately, because a missing fee recipient is a reason to charge nothing, not a reason to send traffic to jup.ag.',
  },
  {
    vars: ['VITE_YIELD_FEED_URL'],
    // CORRECTED 2026-09-04. This claimed the nav entry pills "Soon" without it. It does
    // not, and never did — I conflated the rate feed with the pill. hasRoutableYieldVenue()
    // counts venues with a non-'none' route and a deployed depositTarget, and those are
    // real mainnet addresses (Lido, Rocket Pool, ether.fi, Renzo, Aave v3, Compound,
    // sUSDS), so /yield is live regardless of this var. venues.ts says so outright: the
    // pill "depends on no environment variable, no server, no indexer and no stored
    // state, which is the /solana-launch failure it was written to avoid — a flag that
    // cleared before the action worked."
    severity: 'features',
    darkens: 'the APR figures on /yield',
    effect: 'the rate tiles hide. Routing still works and the nav entry stays live, because the pill is keyed to whether a deposit can actually be routed, not to whether a rate can be quoted.',
  },
  {
    vars: ['VITE_COW_STOP_LOSS_HANDLER'],
    severity: 'features',
    darkens: 'Alerts / TWAP triggers',
    effect: 'the trigger surfaces can never arm an order.',
  },
  {
    vars: ['VITE_TRIGGER_PRICE_FEEDS'],
    severity: 'features',
    darkens: 'trigger creation',
    effect: 'creating a trigger order is disabled.',
  },
];

function parseEnvFile(path) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const strictAll = argv.includes('--strict-all');
const fileIdx = argv.indexOf('--env-file');
const envFile = fileIdx !== -1 ? argv[fileIdx + 1] : null;

const fromFile = envFile ? parseEnvFile(envFile) : null;
if (envFile && fromFile === null) {
  console.error(`verify-env: could not read --env-file ${envFile}`);
  process.exit(2);
}

const env = { ...(fromFile ?? {}), ...process.env };
const isSet = (k) => typeof env[k] === 'string' && env[k].trim() !== '';

console.log('\nFeature-gating environment check');
console.log(envFile ? `  source: process.env + ${envFile}` : '  source: process.env');
console.log('  (run this against the DEPLOY environment — a bare laptop reports everything dark)\n');

const dark = [];
for (const gate of GATES) {
  const missing = gate.vars.filter((v) => !isSet(v));
  const status = missing.length === 0
    ? 'OK  '
    : gate.severity === 'revenue' ? 'DARK'
    : gate.severity === 'disclosure' ? 'MUTE'
    : 'soon';
  const mark = missing.length === 0 ? '  ' : gate.severity === 'revenue' ? '!!' : ' *';
  console.log(`${mark} [${status}] ${gate.vars.join(' + ')}`);
  if (missing.length > 0) {
    dark.push({ ...gate, missing });
    console.log(`        unset: ${missing.join(', ')}`);
    console.log(`        darkens: ${gate.darkens}`);
    console.log(`        effect: ${gate.effect}`);
  }
  console.log('');
}

// ── The one var whose HAZARD is being set, not unset ────────────────────────
// The BAYLA stake pool ships hardcoded so no env var is load-bearing; the override
// exists for emergencies. But if Vercel still carries a stale value it WINS over the
// constant, and the page then renders the retired pool — which holds only the
// operator's own locked dust stake and pays nothing. That reads to a user as "the
// staking pool does not show".
const baylaOverride = isSet('VITE_BAYLA_STAKE_POOL') ? env.VITE_BAYLA_STAKE_POOL.trim() : null;
console.log('   VITE_BAYLA_STAKE_POOL (override — unset is CORRECT)');
let baylaBad = false;
if (baylaOverride === null) {
  console.log(`        unset, so the hardcoded canonical pool wins: ${BAYLA_POOL_CANONICAL}`);
} else if (baylaOverride === BAYLA_POOL_CANONICAL) {
  console.log('        set, and matches the canonical pool — harmless but redundant.');
} else if (baylaOverride === BAYLA_POOL_RETIRED) {
  baylaBad = true;
  console.log('!!      SET TO THE RETIRED POOL. This is the 1.00x-maxWeight pool replaced on');
  console.log('        2026-08-30; its lock ladder buys nothing and it pays no rewards. The');
  console.log('        farm page will look broken or empty. UNSET this var in the deploy.');
} else {
  baylaBad = true;
  // NEVER echo a raw environment value, even one that is public by construction.
  // CodeQL flags this as js/clear-text-logging (HIGH) and it is right to: this
  // script reads whatever is in `env`, so the PATTERN leaks whatever the checked
  // set grows to include, not just today's contents. A VITE_ var is compiled into
  // the client bundle and is therefore already public — but the next var added
  // here might not be, and a logging habit does not know the difference.
  //
  // The diagnostic survives without the value: the operator knows which var is
  // wrong, what it overrides, and what to do. They can read their own env.
  console.log('!!      SET TO AN UNRECOGNISED POOL (value not printed - see below)');
  console.log(`        It overrides the canonical ${BAYLA_POOL_CANONICAL}. Compare your`);
  console.log('        VITE_BAYLA_STAKE_POOL against that address, and unset it unless the');
  console.log('        override is deliberate.');
}
console.log('');

const revenueDark = dark.filter((d) => d.severity === 'revenue');
const featureDark = dark.filter((d) => d.severity === 'features');
const disclosureDark = dark.filter((d) => d.severity === 'disclosure');

console.log('─'.repeat(72));
if (dark.length === 0 && !baylaBad) {
  console.log('All feature-gating vars are set. Nothing is silently dark.');
} else {
  if (revenueDark.length > 0) {
    console.log(`!! ${revenueDark.length} REVENUE gate(s) dark — money is not being collected.`);
  }
  if (featureDark.length > 0) {
    console.log(` * ${featureDark.length} FEATURE gate(s) dark — a built surface is degraded or partly hidden. Read each effect: some pill "Soon", some only lose data.`);
  }
  if (disclosureDark.length > 0) {
    console.log(` * ${disclosureDark.length} DISCLOSURE gate(s) unset — a fee may be charged without being shown.`);
    console.log('   That value must MATCH a setting held outside this repo. Ask for it; do not guess it.');
  }
  if (baylaBad) {
    console.log('!! VITE_BAYLA_STAKE_POOL points somewhere it should not.');
  }
  console.log('\nNone of these are code bugs. Each is one value on the deploy environment.');
}
console.log('─'.repeat(72) + '\n');

if (strictAll && (dark.length > 0 || baylaBad)) process.exit(1);
if (strict && (revenueDark.length > 0 || baylaBad)) process.exit(1);
process.exit(0);
