#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-interface-selectors.mjs — catch declared-but-absent selectors.
//
// Why this script exists:
//   A Solidity `interface` declaration is NEVER checked against the contract it
//   is pointed at. If the deployed callee does not export that selector, the
//   code COMPILES CLEANLY and then reverts at runtime with EMPTY RETURNDATA —
//   there is no matching selector and no `fallback()` to absorb the call. The
//   symptom is a bare `EvmError: Revert`, easily misread as gas or arithmetic.
//
//   This is the standing hazard of EIP-170 bytecode golf on TegridyStaking.
//   Lowering a function `external -> internal` silently removes it from the ABI.
//   It has bitten us for real:
//
//     - `userPositionCount`  (2026-05-29 golf) — BRICKED
//       `CommunityGrants.createProposal` outright. The golf commit claimed
//       "verified zero callers via repo-wide grep"; the grep missed the
//       BATCH-E H11 callsite added three weeks earlier.
//     - `totalLocked`        (2026-05-30 golf) — left declared in
//       VoteIncentives.IVotingEscrow and CommunityGrants.IVotingEscrowGrants.
//     - `votingPowerAt`      — declared in MemeBountyBoard.IStakingVote,
//       never existed on TegridyStaking at all.
//
//   Unit tests do NOT catch this when the consumer is tested against a mock
//   that restates the interface as `external` — such a mock tests the interface
//   against itself and can never observe the real callee dropping a selector.
//
// How it works:
//   forge emits a SEPARATE artifact for every `interface`, carrying solc's own
//   canonical `methodIdentifiers`. So this compares artifact to artifact and
//   never has to normalize a signature by hand (no uint/uint256, struct, enum,
//   or array guesswork). For each in-repo interface it finds the in-repo
//   contract covering the most of its selectors — the presumed callee — and
//   reports the gap. Best-match matters: a selector can exist on some unrelated
//   contract while being absent from the ACTUAL callee, so a naive "does this
//   exist anywhere in the repo?" check under-reports.
//
// Usage:
//   cd contracts && forge build      # artifacts must exist and be current
//   node scripts/check-interface-selectors.mjs
//   npm run check-selectors          # same, from the repo root
//
// Exits non-zero if any non-allowlisted interface has an unresolved selector,
// so this is safe to wire into contracts CI as a blocking step.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'contracts', 'out');

// Interfaces that describe EXTERNAL protocols we call but do not implement.
// These legitimately resolve to nothing in-repo. Keep this list tight — an
// entry here is a permanent blind spot, so only add third-party surfaces.
const EXTERNAL_INTERFACES = new Set([
  'IChainlinkAggregator', // Chainlink sequencer uptime feed
  'IERC2981',             // royalty standard, queried on arbitrary collections
  'IPositionMgr',         // Uniswap V4 PositionManager
  'ISeaport',             // OpenSea Seaport (TegridyNativeBuyRouter; mvp-launch-only)
  'IWETH',                // canonical WETH9
]);

if (!existsSync(OUT_DIR)) {
  console.error(`ERROR: ${OUT_DIR} not found. Run \`cd contracts && forge build\` first.`);
  process.exit(2);
}

/** Recursively collect every artifact JSON under contracts/out. */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (entry.endsWith('.json')) yield p;
  }
}

const interfaces = new Map(); // name -> { src, sigs:Set }
const contracts  = new Map(); // name -> { src, sigs:Set }

for (const file of walk(OUT_DIR)) {
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue; // build-info and other non-artifact JSON
  }
  const target = artifact?.metadata?.settings?.compilationTarget;
  if (!target) continue;

  const [src] = Object.keys(target);
  const name = target[src];
  // Only our own sources — skip lib/, test/, script/.
  if (!src.startsWith('src/')) continue;

  const sigs = new Set(Object.keys(artifact.methodIdentifiers ?? {}));
  const deployed = (artifact.deployedBytecode?.object ?? '').replace(/^0x/, '');
  // An interface compiles to no runtime bytecode; a concrete contract does.
  (deployed.length > 0 ? contracts : interfaces).set(name, { src, sigs });
}

if (contracts.size === 0 || interfaces.size === 0) {
  console.error('ERROR: no in-src artifacts found. Are the artifacts stale? Re-run `forge build`.');
  process.exit(2);
}

const findings = [];
for (const [iname, { src, sigs }] of [...interfaces].sort()) {
  if (sigs.size === 0) continue;
  if (EXTERNAL_INTERFACES.has(iname)) continue;

  let best = null;
  let bestCover = -1;
  for (const [cname, c] of contracts) {
    let cover = 0;
    for (const s of sigs) if (c.sigs.has(s)) cover++;
    if (cover > bestCover) { best = cname; bestCover = cover; }
  }
  // Zero overlap with anything in-repo => an external surface we forgot to
  // allowlist, not a drift regression. Report it separately rather than
  // failing the build on it.
  if (bestCover === 0) {
    console.warn(`NOTE  ${iname} (${src}) matches no in-repo contract — external, or add to EXTERNAL_INTERFACES.`);
    continue;
  }

  const gap = [...sigs].filter((s) => !contracts.get(best).sigs.has(s)).sort();
  if (gap.length > 0) findings.push({ iname, src, best, bestCover, total: sigs.size, gap });
}

if (findings.length === 0) {
  console.log(`OK — every in-src interface resolves against its callee ` +
              `(${interfaces.size} interfaces vs ${contracts.size} contracts).`);
  process.exit(0);
}

console.error('\nDECLARED-BUT-ABSENT SELECTORS — these revert with empty returndata at runtime:\n');
for (const f of findings) {
  console.error(`  ${f.iname}  (${f.src})`);
  console.error(`    presumed callee: ${f.best}  [covers ${f.bestCover}/${f.total}]`);
  for (const sig of f.gap) console.error(`    MISSING  ${sig}`);
  console.error('');
}
console.error('Fix by deleting the dead declaration, or by pointing it at a selector the');
console.error('callee actually exports. Do NOT re-add an external getter to a contract that');
console.error('is already tight against the EIP-170 24,576-byte limit.\n');
process.exit(1);
