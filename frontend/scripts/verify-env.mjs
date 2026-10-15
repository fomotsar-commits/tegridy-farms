#!/usr/bin/env node
// Feature-gating environment check. Every var below FAILS QUIET-CLOSED when unset: the
// feature is simply off, nothing logged, so this reports which are dark and what each costs.
// Run it against the DEPLOY env (a laptop reports everything dark). If a row disagrees with
// the code, the code wins and the row is the bug.
//   node scripts/verify-env.mjs [--strict | --strict-all] [--env-file .env]
//   --strict exits 1 on a dark REVENUE gate or a refused value; --strict-all on any dark gate.

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
    // Unset hides no nav entry (PR #360 moved those to capability checks). It costs DATA:
    // the useIndexed* hooks self-gate to an explicit "indexer unavailable" state.
    severity: 'features',
    darkens: 'indexed history on /terminal, /chart, /copy-trading, /competitions, /tax',
    effect: 'those surfaces render, and say plainly that the indexer is unavailable, rather than showing an empty result set that reads as "there is no data". The indexer is built (indexer/, indexer-solana/) and deployed on Railway behind an nginx proxy; this var is only the URL the frontend asks. Do NOT set it until /ready returns 200 — pointing at a mid-sync indexer is the exact empty-looks-like-zero failure the readiness gate exists to prevent.',
  },
  {
    vars: ['VITE_SWAP_FEE_BPS', 'VITE_SWAP_FEE_RECIPIENT'],
    severity: 'revenue',
    darkens: 'the EVM swap surface',
    effect: 'fee collection is OFF and the swap earns NOTHING, silently (lib/fees/swapFee.ts fails closed: unset => bps 0, recipient null). Both vars are required. The recipient must be the treasury Safe of the chain the fee is collected on, which for every fee today is Ethereum: 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d. Any other address, including the Base treasury Safe 0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0, also leaves the fee OFF.',
  },
  {
    vars: ['VITE_ONRAMP_PARTNER_FEE_BPS'],
    // NOT a revenue switch: it COLLECTS NOTHING. It mirrors, for DISCLOSURE, a partner fee set
    // in the provider's own dashboard (lib/onramp/partnerFee.ts). Unset means a fee may be
    // charged and go unsaid; a value that does not match the provider is worse than unset.
    // `0` is a valid declaration of no partner fee, distinct from unset.
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
    // Not a pill gate: hasRoutableYieldVenue() keys the nav entry to deposit routing through
    // real mainnet addresses, so /yield stays live without this var; only the rates hide.
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

/**
 * UNREADABLE IS NOT UNSET. A Vercel "Secret" var pulls back as `KEY=""` (set but sealed),
 * while an unset one has no line at all. Only a pulled --env-file shows the difference;
 * process.env has no sealed state. A sealed gate is never reported dark or fails --strict.
 */
const isSealed = (k) =>
  fromFile !== null
  && Object.prototype.hasOwnProperty.call(fromFile, k)
  && String(fromFile[k]).trim() === ''
  && !(typeof process.env[k] === 'string' && process.env[k].trim() !== '');

console.log('\nFeature-gating environment check');
console.log(envFile ? `  source: process.env + ${envFile}` : '  source: process.env');
console.log('  (run this against the DEPLOY environment — a bare laptop reports everything dark)\n');

const dark = [];
const sealedGates = [];
for (const gate of GATES) {
  const missing = gate.vars.filter((v) => !isSet(v));
  // A gate whose every missing var is merely SEALED is not dark — it is unreadable,
  // and saying "dark" there is a false alarm. Reported separately, never counted as a
  // failure, and never used to fail --strict.
  const sealed = missing.filter(isSealed);
  const trulyMissing = missing.filter((v) => !isSealed(v));
  const allSealed = missing.length > 0 && trulyMissing.length === 0;
  const status = missing.length === 0
    ? 'OK  '
    : allSealed ? 'SEAL'
    : gate.severity === 'revenue' ? 'DARK'
    : gate.severity === 'disclosure' ? 'MUTE'
    : 'soon';
  const mark = missing.length === 0 || allSealed ? '  ' : gate.severity === 'revenue' ? '!!' : ' *';
  console.log(`${mark} [${status}] ${gate.vars.join(' + ')}`);
  if (allSealed) {
    sealedGates.push({ ...gate, sealed });
    console.log(`        sealed (Vercel "Secret"), so this check CANNOT read it: ${sealed.join(', ')}`);
    console.log('        This is NOT a report that it is unset. Confirm in the dashboard, or');
    console.log('        re-add it as "Config" if the value is not actually secret — a VITE_ var');
    console.log('        compiles into the client bundle either way, so sealing one buys nothing');
    console.log('        but costs you the ability to verify it.');
    console.log('');
    continue;
  }
  if (missing.length > 0) {
    dark.push({ ...gate, missing: trulyMissing, sealed });
    console.log(`        unset: ${trulyMissing.join(', ')}`);
    if (sealed.length > 0) {
      console.log(`        sealed, unreadable (not counted as unset): ${sealed.join(', ')}`);
    }
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
  // NEVER echo a raw environment value (CodeQL js/clear-text-logging): this script reads
  // whatever is in `env`, and the next var checked may not be public. The operator can
  // read their own env; the diagnostic survives without the value.
  console.log('!!      SET TO AN UNRECOGNISED POOL (value not printed - see below)');
  console.log(`        It overrides the canonical ${BAYLA_POOL_CANONICAL}. Compare your`);
  console.log('        VITE_BAYLA_STAKE_POOL against that address, and unset it unless the');
  console.log('        override is deliberate.');
}
console.log('');

// The swap fee's recipient is refused unless it is the treasury Safe of the chain the fee
// is collected on (lib/fees/swapFee.ts), so a SET value can still leave the fee OFF. Every
// fee today is collected on Ethereum. Never echo the raw value.
const ETHEREUM_TREASURY_SAFE = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
const BASE_TREASURY_SAFE = '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0';
let swapFeeRecipientBad = false;
if (isSet('VITE_SWAP_FEE_RECIPIENT')) {
  const recipient = env.VITE_SWAP_FEE_RECIPIENT.trim().toLowerCase();
  console.log('   VITE_SWAP_FEE_RECIPIENT (must be the Ethereum treasury Safe)');
  if (recipient === ETHEREUM_TREASURY_SAFE.toLowerCase()) {
    console.log('        set, and matches the Ethereum treasury Safe.');
  } else {
    swapFeeRecipientBad = true;
    console.log(recipient === BASE_TREASURY_SAFE.toLowerCase()
      ? '!!      SET TO THE BASE TREASURY SAFE, which has no code on Ethereum.'
      : '!!      SET TO AN ADDRESS THE CODE REFUSES ON ETHEREUM (value not printed).');
    console.log(`        The swap fee is OFF until it is ${ETHEREUM_TREASURY_SAFE}.`);
  }
  console.log('');
}

const revenueDark = dark.filter((d) => d.severity === 'revenue');
const featureDark = dark.filter((d) => d.severity === 'features');
const disclosureDark = dark.filter((d) => d.severity === 'disclosure');

console.log('─'.repeat(72));
if (sealedGates.length > 0) {
  console.log(`   ${sealedGates.length} gate(s) SEALED — set, but this check cannot read them, so it is`);
  console.log('   reporting nothing about them either way. Not a finding. Not an all-clear.');
}
if (dark.length === 0 && !baylaBad && !swapFeeRecipientBad) {
  console.log(
    sealedGates.length > 0
      ? 'Nothing readable is dark. The sealed gates above are the only unknowns.'
      : 'All feature-gating vars are set. Nothing is silently dark.',
  );
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
  if (swapFeeRecipientBad) {
    console.log('!! VITE_SWAP_FEE_RECIPIENT is set to an address the code refuses, so the swap fee is OFF.');
  }
  console.log('\nNone of these are code bugs. Each is one value on the deploy environment.');
}
console.log('─'.repeat(72) + '\n');

if (strictAll && (dark.length > 0 || baylaBad || swapFeeRecipientBad)) process.exit(1);
if (strict && (revenueDark.length > 0 || baylaBad || swapFeeRecipientBad)) process.exit(1);
process.exit(0);
