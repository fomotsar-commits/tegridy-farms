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
//   A hand-rolled FRONTEND ABI is the same defect with a worse blast radius:
//   viem/wagmi encode the declared selector without ever consulting the chain,
//   so a stale entry ships to users as a permanently-reverting button or a
//   stat tile stuck at 0. PR #123 removed three that had accumulated —
//   SwapFeeRouter.totalSwaps, TegridyStaking.totalLocked, and
//   LPFarming.notifyRewardAmount(uint256) (the deployed farm takes
//   (uint256,uint256), so the 1-arg Synthetix signature was a different
//   selector entirely). Phase 2 below exists so the next one fails CI instead
//   of shipping.
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
//   Phase 2 applies the same artifact comparison to the hand-rolled ABIs in
//   frontend/src/lib/contracts.ts, canonicalizing each entry's signature here
//   because there is no solc artifact to borrow it from. Target contracts are
//   resolved BY NAME, not by best-match: a frontend ABI names exactly one
//   callee, and best-match would happily "resolve" a drifted ABI against
//   whatever contract still happens to cover the most of it.
//
// Scope limit — SOURCE, not deployed bytecode:
//   Artifacts reflect contracts/src as it stands TODAY, which is a proxy for
//   what is deployed, not proof of it. That proxy is the right one here:
//   source == deployed is verified separately on Etherscan, and reaching for
//   mainnet bytecode would make this gate need an RPC, a key, and a network.
//   The residual is an ABI generated from source NEWER than the deployed
//   contract — invisible here by construction, and it closes on redeploy.
//
// Usage:
//   cd contracts && forge build      # artifacts must exist and be current
//   node scripts/check-interface-selectors.mjs
//   npm run check-selectors          # same, from the repo root
//
// Exits non-zero if any non-allowlisted interface or frontend ABI has an
// unresolved selector, so this is safe to wire into contracts CI as a
// blocking step.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'contracts', 'out');
const FRONTEND_ABI_FILE = join(REPO_ROOT, 'frontend', 'src', 'lib', 'contracts.ts');
const FRONTEND_CONSTANTS_FILE = join(REPO_ROOT, 'frontend', 'src', 'lib', 'constants.ts');

// Interfaces that describe EXTERNAL protocols we call but do not implement.
// These legitimately resolve to nothing in-repo. Keep this list tight — an
// entry here is a permanent blind spot, so only add third-party surfaces.
const EXTERNAL_INTERFACES = new Set([
  'IChainlinkAggregator', // Chainlink sequencer uptime feed
  'IERC2981',             // royalty standard, queried on arbitrary collections
  'IPositionMgr',         // Uniswap V4 PositionManager
  'ISeaport',             // OpenSea Seaport (TegridyNativeBuyRouter; mvp-launch-only)
  'IWETH',                // canonical WETH9
  'IWETHMinimal',         // canonical WETH9 (TegridyCurveLauncher's deposit/transfer slice;
                          // the guard otherwise half-matches it onto NftfiPooledLendingVault
                          // and flags WETH's deposit() as declared-but-absent)
]);

// Frontend ABIs for EXTERNAL or generic surfaces — no in-repo artifact by
// design. Same rule as EXTERNAL_INTERFACES: every entry is a permanent blind
// spot. The cross-check below rejects anything listed here that turns out to
// have an in-repo address constant, so one of ours cannot hide in this list.
const EXTERNAL_FRONTEND_ABIS = new Set([
  'ERC20_ABI',              // any ERC-20 (TOWELI, bribe tokens, quote tokens)
  'ERC721_ABI',             // any ERC-721 (JBAC, Tradermigos, loan collateral)
  'CHAINLINK_FEED_ABI',     // Chainlink ETH/USD aggregator
  'UNISWAP_V2_ROUTER_ABI',  // Uniswap V2 Router02
  'UNISWAP_V2_FACTORY_ABI', // Uniswap V2 Factory
  'UNISWAP_V2_PAIR_ABI',    // Uniswap V2 Pair (TOWELI/WETH)
]);

// Frontend ABI export -> artifact contract name, ONLY where the normalized
// export name does not match the contract on its own. Everything else
// auto-resolves, so this stays short — and an export that resolves to nothing
// is a hard failure rather than a silent skip.
const FRONTEND_ABI_TARGET_OVERRIDES = {
  LP_FARMING_ABI: 'TegridyLPFarming', // export drops the `Tegridy` prefix
  // The island's EVM lighthouse — the VENDORED canonical Synthetix staker
  // (contracts/src/vendor/synthetix-staking-rewards/). In-repo artifact, so it
  // belongs here; the export name carries the island vocabulary, not the
  // contract's.
  LIGHTHOUSE_STAKING_ABI: 'StakingRewards',
  // Same shape — the airdrop/vesting surface landed with the prefix dropped, so
  // `normalize(stem)` finds no candidate and the guard fails the whole job. These
  // ARE in-repo contracts (contracts/src/TegridyAirdropDistributor.sol,
  // contracts/src/TegridyVestingWallet.sol), so they belong here and NOT in
  // EXTERNAL_FRONTEND_ABIS — that list is for ABIs we do not build, and the guard
  // rejects an entry there that has an in-repo `*_ADDRESS`.
  AIRDROP_DISTRIBUTOR_ABI: 'TegridyAirdropDistributor',
  VESTING_WALLET_ABI: 'TegridyVestingWallet',
};

// Selectors a frontend ABI declares that are deliberately served by a DIFFERENT
// contract than the ABI's own target, AND that the frontend already calls at
// that contract's address. Each entry still has to resolve against the named
// host — this redirects the check, it does not suppress it.
const FRONTEND_SELECTOR_HOSTS = {
  TEGRIDY_STAKING_ABI: {
    // Both were golfed off TegridyStaking for EIP-170 headroom and are served
    // by the StakingMonitorView companion (and by the legacy exit contracts).
    // Verified call sites: usePoints.ts, useUserPosition.ts (both at
    // STAKING_MONITOR_VIEW_ADDRESS) and LegacyStakingExit.tsx (exit contracts).
    'earned(uint256)': 'StakingMonitorView',
    'getPosition(uint256)': 'StakingMonitorView',
  },
};

// Selectors that are absent from their target AND still called at that target's
// address — but where the call is DORMANT because the contract is not deployed
// (address 0x0, hooks gated behind `isDeployed`). These are real bugs held
// harmless by the feature being off, so they are reported every run instead of
// failing the build. `host` is where the function actually lives and is
// verified like any other, so an entry cannot quietly become fiction.
//
// Remove an entry by re-pointing its call site at the host's address. Any entry
// still here when its feature is deployed becomes a live empty-returndata
// revert — check this list before flipping either contract on.
const KNOWN_LATENT_FRONTEND_SELECTORS = {
  TEGRIDY_RESTAKING_ABI: {
    // useRestaking.ts reads it at TEGRIDY_RESTAKING_ADDRESS (0x0).
    'pendingTotal(address)': { host: 'RestakingMonitorView', reason: 'restaking not deployed' },
  },
  VOTE_INCENTIVES_ABI: {
    // useBribes.ts reads both at VOTE_INCENTIVES_ADDRESS (0x0). Moved out by
    // the pass-8 EIP170-03 split, alongside the propose/execute/cancel calls
    // whose readiness they exposed.
    'pendingFeeBps()': { host: 'VoteIncentivesAdmin', reason: 'vote incentives not deployed' },
    'feeChangeTime()': { host: 'VoteIncentivesAdmin', reason: 'vote incentives not deployed' },
  },
};

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

// ---------------------------------------------------------------------------
// PHASE 1 — Solidity interfaces vs their presumed in-repo callee.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PHASE 2 — hand-rolled frontend ABIs vs the contract each one targets.
//
// Only the literal `export const X_ABI = [...] as const;` blocks of
// contracts.ts are parsed. contracts.ts also does `export * from
// './abi-supplement'`, but those ABIs are GENERATED from the very artifacts
// this script reads (frontend/scripts/extract-missing-abis.mjs, itself guarded
// by the ABI-drift gate in the same CI job), so checking them against the
// artifacts they were cut from could only ever pass. Their real exposure is
// the source-newer-than-deployed gap named in the scope limit above — e.g.
// TEGRIDY_TWAP_ABI carries `MAX_PENDING_PAIR_RESETS`, which exists in
// TegridyTWAP.sol but not in the deployed TWAP, and closes on redeploy.
// ---------------------------------------------------------------------------

for (const f of [FRONTEND_ABI_FILE, FRONTEND_CONSTANTS_FILE]) {
  if (!existsSync(f)) {
    console.error(`ERROR: ${f} not found — the frontend ABI guard cannot run.`);
    console.error('If the frontend moved, update the paths in this script rather than');
    console.error('letting the check silently cover nothing.');
    process.exit(2);
  }
}

const abiSource = readFileSync(FRONTEND_ABI_FILE, 'utf8');
const constantsSource = readFileSync(FRONTEND_CONSTANTS_FILE, 'utf8');

const addressConstants = new Set(
  [...constantsSource.matchAll(/^export const ([A-Z0-9_]+_ADDRESS(?:ES)?)\b/gm)].map((m) => m[1]),
);

/**
 * Return the source text of the array literal starting at `open` (the index of
 * its `[`). Depth-counts brackets and braces while skipping string literals and
 * comments — ABI entries are full of `'address[]'` and `'uint256[2]'`, so a
 * naive bracket count walks straight past the end of the block.
 */
function sliceArrayLiteral(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i); if (i < 0) break; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/** Canonical solc type for one ABI input, expanding tuples recursively. */
function canonicalType(input) {
  const t = input?.type ?? '';
  if (!t.startsWith('tuple')) return t;
  const inner = (input.components ?? []).map(canonicalType).join(',');
  return `(${inner})${t.slice('tuple'.length)}`; // keeps any [] / [2] suffix
}

/** Canonical signature — exactly the key format of solc's methodIdentifiers. */
function canonicalSignature(entry) {
  return `${entry.name}(${(entry.inputs ?? []).map(canonicalType).join(',')})`;
}

/** Strip underscores + case so SWAP_FEE_ROUTER matches SwapFeeRouter. */
const normalize = (s) => s.replace(/_/g, '').toLowerCase();

const contractsByNormalizedName = new Map();
for (const cname of contracts.keys()) {
  const key = normalize(cname);
  if (!contractsByNormalizedName.has(key)) contractsByNormalizedName.set(key, []);
  contractsByNormalizedName.get(key).push(cname);
}

const frontendFindings = [];
const latentReports = [];
const unresolved = [];

// Every `*_ABI` export has to be accounted for. The scanner below only matches
// `= [`, so a type annotation or a computed value would slip past it silently —
// and a guard that quietly covers nothing is worse than no guard. Diff the two
// and complain about the gap.
const declaredAbiExports = new Set(
  [...abiSource.matchAll(/^export const ([A-Z0-9_]+_ABI)\b/gm)].map((m) => m[1]),
);
const scannedAbiExports = new Set();

for (const match of abiSource.matchAll(/^export const ([A-Z0-9_]+_ABI)\s*=\s*(?=\[)/gm)) {
  scannedAbiExports.add(match[1]);
  const exportName = match[1];
  const stem = exportName.slice(0, -'_ABI'.length);

  if (EXTERNAL_FRONTEND_ABIS.has(exportName)) {
    // Keep the allowlist honest: an ABI with an in-repo address constant is
    // one of ours, and listing it here would be a self-inflicted blind spot.
    if (addressConstants.has(`${stem}_ADDRESS`)) {
      unresolved.push(`${exportName} is in EXTERNAL_FRONTEND_ABIS but ${stem}_ADDRESS exists in ` +
                      'constants.ts — it targets an in-repo contract. Remove it from the list.');
    }
    continue;
  }

  const literal = sliceArrayLiteral(abiSource, match.index + match[0].length);
  if (literal === null) {
    unresolved.push(`${exportName}: could not find the end of its array literal.`);
    continue;
  }

  let abi;
  try {
    abi = new Function(`return (${literal});`)();
  } catch (err) {
    unresolved.push(`${exportName}: not a self-contained literal (${err.message}). ABI blocks ` +
                    'must stay plain object literals so this guard can read them.');
    continue;
  }

  // Resolve the target contract: explicit override first, else exact name match.
  let target = FRONTEND_ABI_TARGET_OVERRIDES[exportName];
  if (!target) {
    const candidates = contractsByNormalizedName.get(normalize(stem)) ?? [];
    if (candidates.length === 1) [target] = candidates;
    else if (candidates.length > 1) {
      unresolved.push(`${exportName}: ambiguous target — ${candidates.join(', ')}. ` +
                      'Pin it in FRONTEND_ABI_TARGET_OVERRIDES.');
      continue;
    }
  }
  if (!target || !contracts.has(target)) {
    unresolved.push(`${exportName}: no in-repo contract artifact${target ? ` named ${target}` : ''}. ` +
                    'Map it in FRONTEND_ABI_TARGET_OVERRIDES, or add it to ' +
                    'EXTERNAL_FRONTEND_ABIS if it is a third-party surface.');
    continue;
  }

  const hosts = FRONTEND_SELECTOR_HOSTS[exportName] ?? {};
  const latent = KNOWN_LATENT_FRONTEND_SELECTORS[exportName] ?? {};
  const gap = [];
  for (const entry of abi) {
    if (entry?.type !== 'function') continue; // events/errors carry no call selector
    const sig = canonicalSignature(entry);
    const hostName = latent[sig]?.host ?? hosts[sig] ?? target;
    const host = contracts.get(hostName);
    if (!host) {
      unresolved.push(`${exportName}: ${sig} is routed to ${hostName}, which has no artifact.`);
      continue;
    }
    // A latent entry must be BOTH absent from its target (or it is stale and
    // should be deleted) and present on its host (or the record is wrong).
    if (latent[sig]) {
      if (!host.sigs.has(sig)) {
        unresolved.push(`${exportName}: ${sig} is recorded as latent-on-${hostName}, but ` +
                        `${hostName} does not export it either. The record is wrong.`);
      } else if (contracts.get(target).sigs.has(sig)) {
        unresolved.push(`${exportName}: ${sig} is recorded as latent but ${target} exports it. ` +
                        'Drop it from KNOWN_LATENT_FRONTEND_SELECTORS.');
      } else {
        latentReports.push({ exportName, sig, ...latent[sig] });
      }
      continue;
    }
    if (!host.sigs.has(sig)) gap.push({ sig, hostName, redirected: hostName !== target });
  }

  if (gap.length > 0) {
    frontendFindings.push({ exportName, target, src: contracts.get(target).src, gap });
  }
}

for (const name of declaredAbiExports) {
  if (scannedAbiExports.has(name)) continue;
  unresolved.push(`${name}: declared in contracts.ts but not in the \`= [ ... ]\` form this ` +
                  'guard can read, so none of its selectors were checked.');
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

// Always print the latent ledger — its whole job is to stay visible until the
// call sites are re-pointed, so it prints on green runs too.
if (latentReports.length > 0) {
  console.warn('\nLATENT (not failing — the call site is dormant while the contract is at 0x0):');
  for (const l of latentReports) {
    console.warn(`  ${l.exportName}  ${l.sig}  -> lives on ${l.host}  [${l.reason}]`);
  }
  console.warn('Re-point these at the host contract before deploying the feature.\n');
}

if (findings.length === 0 && frontendFindings.length === 0 && unresolved.length === 0) {
  console.log(`OK — every in-src interface resolves against its callee ` +
              `(${interfaces.size} interfaces vs ${contracts.size} contracts), and every ` +
              `hand-rolled frontend ABI resolves against its target contract` +
              `${latentReports.length > 0 ? ` (${latentReports.length} latent, listed above)` : ''}.`);
  process.exit(0);
}

if (findings.length > 0) {
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
}

if (frontendFindings.length > 0) {
  console.error('\nFRONTEND ABI DRIFT (frontend/src/lib/contracts.ts) — viem encodes these');
  console.error('selectors without ever consulting the chain, so each one ships to users as a');
  console.error('call that reverts with empty returndata:\n');
  for (const f of frontendFindings) {
    console.error(`  ${f.exportName}  ->  ${f.target}  (${f.src})`);
    for (const { sig, hostName, redirected } of f.gap) {
      console.error(`    MISSING  ${sig}${redirected ? `   [routed to ${hostName}]` : ''}`);
    }
    console.error('');
  }
  console.error('Fix by deleting the entry from the ABI and the call sites that use it. If the');
  console.error('function moved to a companion contract, route it in FRONTEND_SELECTOR_HOSTS');
  console.error("and call it at that contract's address.\n");
}

if (unresolved.length > 0) {
  console.error('\nUNMAPPED FRONTEND ABIs — the guard cannot tell what these target, so it');
  console.error('cannot vouch for them:\n');
  for (const u of unresolved) console.error(`  ${u}`);
  console.error('');
}

process.exit(1);
