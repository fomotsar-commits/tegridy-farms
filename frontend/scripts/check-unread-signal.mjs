#!/usr/bin/env node
// OUTAGE-AS-ZERO RATCHET.
//
// Two audit rounds (PRs #386, #406, #420) found NINETEEN places where a failed
// contract read was handed to a caller, a guard, or a user as a definite value
// -- 0, 0n, [], false -- so an outage was indistinguishable from a real zero.
// The damage was never the wrong number. It was that controls ARMED and guards
// DISARMED on data nobody had read: a mint button on a price that was never
// fetched, a withdraw that forfeited unclaimed ETH, a stake cap that silently
// stopped capping, a 40% price impact that signed clean.
//
// This guard does NOT ban the collapse. Collapsing to 0n for display is the
// house pattern and every fix kept it. What the fixes ADDED was a second,
// separately-named value saying the collapse happened -- `<subject>Unread`,
// `<subject>ReadOk`, `<subject>ReadFailed`/`Observed`, `<thing>Available` --
// so that claims and controls can gate on that instead of on the zero.
//
// So the rule is: A FILE THAT COLLAPSES A CONTRACT READ TO A ZERO MUST ALSO
// DECLARE AN UNREAD SIGNAL. Nothing about which zero, or where it is spent --
// just that the file has some way to say "this one did not land".
//
// It is a RATCHET, not a wall. The 16 files already in this shape when the
// guard landed are listed in unread-signal-baseline.json and do not fail the
// build. A file NOT in that list that starts collapsing without a signal fails.
// A file IN the list that gets fixed must be REMOVED from it, or that fails too
// -- otherwise the baseline quietly becomes permission.
//
// Validated against the pre-fix tree at 9c0b75fa: catches 7 of the 9 known
// instances, and flags none of the files that were fixed. The two it misses are
// different shapes and are documented in KNOWN_BLIND_SPOTS below -- this catches
// the dominant shape, not every possible one, and is not a substitute for review.
//
// Usage:
//   node scripts/check-unread-signal.mjs              # check (CI)
//   node scripts/check-unread-signal.mjs --update     # rewrite the baseline
//   node scripts/check-unread-signal.mjs --self-test  # prove the matcher works

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', 'src');
const BASELINE_PATH = join(HERE, 'unread-signal-baseline.json');

// Shapes this guard does NOT see. Recorded so nobody reads a green run as
// "no outage-as-zero bugs" -- it means "none of the dominant shape, outside
// the baseline".
const KNOWN_BLIND_SPOTS = [
  'a bare `return 0` inside a useMemo (useSwapQuote priceImpact, PR #420) -- too common a literal to match without drowning in false positives',
  'aggregate flags computed with .every() so they only fire when EVERY read failed (useMyLoans, PR #406) -- a partial failure stays silent',
  'server-side JSON wires (api/**), which use the Observed/ReadFailed pair instead; this guard only walks src/',
];

const ZEROISH = String.raw`(?:0n|0|\[\]|false|''|"")`;

const COLLAPSE_PATTERNS = [
  // The useReadContracts entry collapse:
  //   data?.[3]?.status === 'success' ? data[3].result as bigint : 0n
  {
    id: 'multicall-entry',
    re: new RegExp(String.raw`\?\.status\s*===\s*['"]success['"]\s*\?[\s\S]{0,160}?:\s*` + ZEROISH + String.raw`\s*[;,)]`, 'g'),
  },
  // A useReadContract alias defaulted with ?? / || :
  //   const maxStakeWei = (maxStakeRaw as bigint | undefined) ?? 0n
  {
    id: 'read-alias-default',
    re: new RegExp(String.raw`\b\w*(?:Raw|Data)\b[\s\S]{0,40}?(?:\?\?|\|\|)\s*` + ZEROISH + String.raw`\b`, 'g'),
  },
  // Truthiness ternary on a read alias:
  //   protocolFeeBpsData ? Number(protocolFeeBpsData) : 0
  {
    id: 'read-alias-ternary',
    re: new RegExp(String.raw`\b\w*(?:Raw|Data)\b\s*\?\s*[^:;]{1,80}:\s*` + ZEROISH + String.raw`\s*[;,)]`, 'g'),
  },
];

// The house vocabulary for "this read did not land". Any of these in the file
// is enough -- this guard checks that the concept exists, not that it is wired
// correctly. Wiring it correctly is what review is for.
const SIGNAL_RE = /\b\w*(?:Unread|ReadOk|ReadFailed|Observed|Available|Unavailable)\b/;
const USES_READ_RE = /\buseReadContracts?\b/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'build', 'coverage', '__snapshots__'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec|d)\./.test(entry)) out.push(full);
  }
  return out;
}

/** @returns {{file: string, shapes: string[]}[]} files that collapse a read with no unread signal */
export function scan(root = SRC_ROOT) {
  const offenders = [];
  for (const full of walk(root)) {
    const src = readFileSync(full, 'utf8');
    if (!USES_READ_RE.test(src)) continue;

    const shapes = [];
    for (const { id, re } of COLLAPSE_PATTERNS) {
      re.lastIndex = 0;
      const n = (src.match(re) || []).length;
      if (n) shapes.push(`${id}x${n}`);
    }
    if (!shapes.length) continue;
    if (SIGNAL_RE.test(src)) continue; // collapses, but says so somewhere -> fine

    offenders.push({
      file: relative(join(HERE, '..'), full).replace(/\\/g, '/'),
      shapes,
    });
  }
  return offenders.sort((a, b) => a.file.localeCompare(b.file));
}

// ── self-test ──────────────────────────────────────────────────────────────
function selfTest() {
  const cases = [
    { name: 'multicall collapse with no signal', flagged: true,
      src: `const { data } = useReadContracts({});\nconst staked = data?.[5]?.status === 'success' ? data[5].result as bigint : 0n;` },
    { name: 'same collapse WITH an unread flag', flagged: false,
      src: `const { data } = useReadContracts({});\nconst staked = data?.[5]?.status === 'success' ? data[5].result as bigint : 0n;\nconst positionUnread = data?.[5]?.status !== 'success';` },
    { name: 'read alias defaulted with ??', flagged: true,
      src: `const { data: maxStakeRaw } = useReadContract({});\nconst maxStakeWei = (maxStakeRaw as bigint | undefined) ?? 0n;` },
    { name: 'read alias truthiness ternary', flagged: true,
      src: `const { data: feeBpsData } = useReadContract({});\nconst feeBps = feeBpsData ? Number(feeBpsData) : 0;` },
    { name: 'ReadOk spelling also counts as a signal', flagged: false,
      src: `const { data: feeBpsData } = useReadContract({});\nconst feeReadOk = feeBpsData !== undefined;\nconst feeBps = feeBpsData ? Number(feeBpsData) : 0;` },
    { name: 'no contract read at all -> not our business', flagged: false,
      src: `const count = someArray.length ?? 0;` },
    { name: 'a genuine zero from a successful read is untouched', flagged: false,
      src: `const { data } = useReadContracts({});\nconst n = data?.[0]?.status === 'success' ? Number(data[0].result) : null;` },
  ];

  let failed = 0;
  for (const c of cases) {
    const usesRead = USES_READ_RE.test(c.src);
    const collapses = COLLAPSE_PATTERNS.some(({ re }) => { re.lastIndex = 0; return re.test(c.src); });
    const hasSignal = SIGNAL_RE.test(c.src);
    const flagged = usesRead && collapses && !hasSignal;
    const ok = flagged === c.flagged;
    if (!ok) failed++;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${c.name}${ok ? '' : ` (expected flagged=${c.flagged}, got ${flagged})`}`);
  }
  if (failed) {
    console.error(`\ncheck-unread-signal self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(`\ncheck-unread-signal self-test: ${cases.length} cases pass`);
}

// ── main ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

if (argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const offenders = scan();
const current = new Set(offenders.map((o) => o.file));

if (argv.includes('--update')) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({
      note: 'Files that collapse a contract read with no unread signal, as of the guard landing. This list may SHRINK, never grow. See check-unread-signal.mjs.',
      files: offenders.map((o) => o.file),
    }, null, 2) + '\n',
  );
  console.log(`baseline updated: ${offenders.length} file(s)`);
  process.exit(0);
}

let baseline;
try {
  baseline = new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files);
} catch {
  console.error(`Cannot read ${BASELINE_PATH}. Run with --update to create it.`);
  process.exit(1);
}

const added = offenders.filter((o) => !baseline.has(o.file));
const fixed = [...baseline].filter((f) => !current.has(f)).sort();

let bad = false;

if (added.length) {
  bad = true;
  console.error('\nOUTAGE-AS-ZERO: new file(s) collapse a contract read with no unread signal.\n');
  for (const o of added) console.error(`  ${o.file}  [${o.shapes.join(', ')}]`);
  console.error(`
A failed read must not reach a caller, a guard, or a user as a definite value.
Keep the collapse if you want the display default -- but derive a second,
separately-named value beside it saying the read did not land, and gate every
claim and every control on THAT:

  const positionUnread = isConnected && !isLoading
    && data?.[5]?.status !== 'success';

Naming: <subject>Unread or <subject>ReadOk at a wagmi boundary; T | null for a
scalar that arms a control or prices a cost; <subject>Observed/<subject>ReadFailed
across a JSON wire. Exemplars: useLPFarming.ts, useFarmActions.ts, useNFTDropV2.ts.
`);
}

if (fixed.length) {
  bad = true;
  console.error('\nOUTAGE-AS-ZERO: baselined file(s) no longer offend -- remove them from the baseline.\n');
  for (const f of fixed) console.error(`  ${f}`);
  console.error('\n  node scripts/check-unread-signal.mjs --update\n');
  console.error('The baseline exists to shrink. Left stale, it becomes permission.\n');
}

if (bad) process.exit(1);

console.log(`check-unread-signal: ok (${offenders.length} baselined file(s) still to burn down)`);
console.log('Blind spots this guard does NOT cover:');
for (const s of KNOWN_BLIND_SPOTS) console.log(`  - ${s}`);
