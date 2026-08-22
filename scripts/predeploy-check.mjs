#!/usr/bin/env node
/**
 * Pre-deploy working-tree guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vercel's CLI deploys the WORKING TREE, not a git ref. `npx vercel --prod`
 * uploads whatever bytes are on disk — it does not check out a branch, does not
 * care what `git log` says, and will happily ship a tree that is months behind
 * the trunk or carries edits nobody has reviewed. That has now cost this project
 * twice, in both directions:
 *
 *   1. 2026-08-02 — a `--prod` deploy ran from a checkout that was 26 commits
 *      AHEAD and 165 BEHIND `origin/mvp-launch`. It REVERTED 262 frontend files
 *      in production — LaunchTokenPage, TrustHubPage, ScannerPage,
 *      SolanaLaunchPage and more. Production served that build for ~10 minutes.
 *      It was caught only because a PR opened off the same tree showed 110
 *      changed files when the actual change was 13.
 *
 *   2. Same day, the opposite direction — production was found serving a
 *      `www.memetic.fun` -> apex redirect that existed in NO commit on any
 *      remote. It had been deployed from an unpushed local tree. So prod can be
 *      AHEAD of trunk, not only behind, and "it works in prod" is not evidence
 *      that the code exists anywhere durable.
 *
 * Both are the same defect: THE TREE THAT SHIPS IS NOT THE TREE THAT WAS
 * REVIEWED. A human "count the changed files" habit is not a control — in case
 * 1 the operator did look, and 110-vs-13 is exactly the kind of number that
 * reads as plausible at a glance.
 *
 * WHAT IT CHECKS  (all of these BLOCK)
 * ------------------------------------
 *   identity   HEAD is byte-identical to the tracked remote branch
 *   ahead      no unpushed commits (case 2 — deploying code with no remote)
 *   behind     no missing commits (case 1 — deploying a stale tree)
 *   dirty      no uncommitted modifications to TRACKED files
 *   project    a .vercel/ directory exists at the deploy root, so the CLI
 *              targets the existing project instead of prompting to create a
 *              new one (a new project deploys to a URL nobody is pointing at)
 *
 * and WARNS on untracked files, because the CLI uploads those too — they are
 * not necessarily wrong (build output, local notes) but they are shipping.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not deploy, and it does not touch the Vercel Git integration. A push
 * to a branch wired as the Vercel "Production Branch" deploys with NO local
 * step at all, so this guard is blind to that path BY CONSTRUCTION. Closing
 * that one is a dashboard setting, not a script. Do not read a green run here
 * as "production is safe" — read it as "this tree is safe to push to Vercel".
 *
 * USAGE
 * -----
 *   node scripts/predeploy-check.mjs              # guard the current tree
 *   node scripts/predeploy-check.mjs --no-fetch   # skip the network round-trip
 *   node scripts/predeploy-check.mjs --self-test  # prove the decision table
 *
 * Exit 0 = safe to deploy. Exit 1 = do not deploy.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The branch a production deploy is expected to ship. */
export const EXPECTED_BRANCH = 'mvp-launch';

/**
 * Pure decision function — no git, no fs, no network. Everything the guard
 * concludes is derived here so it can be exercised by --self-test. Keeping this
 * separate is the whole reason the guard is testable at all: the git plumbing
 * around it cannot be run against a fabricated repo state cheaply.
 *
 * @returns {{ok: boolean, blockers: string[], warnings: string[]}}
 */
export function evaluate(state) {
  const {
    branch,
    headSha,
    remoteSha,
    ahead = 0,
    behind = 0,
    dirtyTracked = [],
    untracked = [],
    hasVercelDir = true,
    expectedBranch = EXPECTED_BRANCH,
  } = state;

  const blockers = [];
  const warnings = [];

  // Branch is a WARNING, not a blocker: deploying a hotfix branch that is
  // otherwise identical to the remote is legitimate. Identity is what matters.
  if (branch !== expectedBranch) {
    warnings.push(
      `on branch '${branch}', not '${expectedBranch}' — fine only if you mean to ship this branch`,
    );
  }

  if (behind > 0) {
    blockers.push(
      `${behind} commit(s) BEHIND the remote — deploying would REVERT work that is already on trunk (this is the 2026-08-02 incident: 262 files)`,
    );
  }

  if (ahead > 0) {
    blockers.push(
      `${ahead} commit(s) AHEAD of the remote — this tree contains code that exists on no remote; deploying it makes production the only copy`,
    );
  }

  // Checked after ahead/behind so the counts explain the mismatch first. A bare
  // sha mismatch with ahead=0 and behind=0 means the branches have diverged.
  if (headSha && remoteSha && headSha !== remoteSha && ahead === 0 && behind === 0) {
    blockers.push(
      `HEAD ${headSha.slice(0, 8)} != remote ${remoteSha.slice(0, 8)} with no ahead/behind count — the branches have diverged`,
    );
  }

  if (dirtyTracked.length > 0) {
    const shown = dirtyTracked.slice(0, 8).join(', ');
    const more = dirtyTracked.length > 8 ? ` (+${dirtyTracked.length - 8} more)` : '';
    blockers.push(
      `${dirtyTracked.length} uncommitted change(s) to tracked files: ${shown}${more}`,
    );
  }

  if (!hasVercelDir) {
    blockers.push(
      'no .vercel/ at the deploy root — the CLI would prompt to create a NEW project, which deploys to a URL nothing points at',
    );
  }

  if (untracked.length > 0) {
    const shown = untracked.slice(0, 6).join(', ');
    const more = untracked.length > 6 ? ` (+${untracked.length - 6} more)` : '';
    warnings.push(
      `${untracked.length} untracked path(s) WILL be uploaded: ${shown}${more}`,
    );
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

// ── git plumbing ───────────────────────────────────────────────────────────
const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

function readRepoState({ fetch: doFetch }) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = `origin/${branch}`;

  if (doFetch) {
    // The 2026-08-02 revert happened because nobody fetched. A stale remote ref
    // makes every check below agree with a tree that is months out of date.
    try {
      git(['fetch', 'origin', branch, '--quiet']);
    } catch {
      console.warn(`⚠️  could not fetch ${upstream} — comparing against a possibly stale ref`);
    }
  }

  let remoteSha = null;
  try {
    remoteSha = git(['rev-parse', upstream]);
  } catch {
    throw new Error(
      `no remote ref '${upstream}'. A branch with no remote cannot be verified against anything — push it first.`,
    );
  }

  const headSha = git(['rev-parse', 'HEAD']);

  let ahead = 0;
  let behind = 0;
  const counts = git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).split(/\s+/);
  if (counts.length === 2) {
    behind = Number(counts[0]) || 0;
    ahead = Number(counts[1]) || 0;
  }

  // `--ignore-submodules=all` is REQUIRED, not cosmetic. In this repo a bare
  // `git status` aborts on the submodule walk ("Invalid path 'C:/Users/…'") and
  // prints NOTHING — which reads as a clean tree. A guard that trusts that
  // output reports "safe to deploy" on a dirty checkout. Verified 2026-08-02.
  const porcelain = git(['-c', 'status.submodulesummary=0', 'status', '--porcelain', '--ignore-submodules=all']);
  const dirtyTracked = [];
  const untracked = [];
  for (const line of porcelain.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (code === '??') untracked.push(path);
    else dirtyTracked.push(path);
  }

  const root = git(['rev-parse', '--show-toplevel']);
  return {
    branch,
    headSha,
    remoteSha,
    ahead,
    behind,
    dirtyTracked,
    untracked,
    hasVercelDir: existsSync(join(root, '.vercel')),
    root,
  };
}

// ── self-test ──────────────────────────────────────────────────────────────
// A guard nobody has seen fail is a guard nobody knows works. Each case below
// asserts the SPECIFIC blocker fires, not merely that ok===false — a check that
// only asserts falsiness passes even when the wrong rule tripped.
function selfTest() {
  const clean = {
    branch: 'mvp-launch',
    headSha: 'a'.repeat(40),
    remoteSha: 'a'.repeat(40),
    ahead: 0,
    behind: 0,
    dirtyTracked: [],
    untracked: [],
    hasVercelDir: true,
  };

  const cases = [
    ['clean tree passes', clean, { ok: true }],
    [
      'behind blocks (the 262-file revert)',
      { ...clean, behind: 165, remoteSha: 'b'.repeat(40) },
      { ok: false, match: /BEHIND/ },
    ],
    [
      'ahead blocks (code on no remote)',
      { ...clean, ahead: 26, remoteSha: 'b'.repeat(40) },
      { ok: false, match: /AHEAD/ },
    ],
    [
      'diverged sha blocks even at 0/0',
      { ...clean, remoteSha: 'b'.repeat(40) },
      { ok: false, match: /diverged/ },
    ],
    [
      'dirty tracked files block',
      { ...clean, dirtyTracked: ['frontend/src/App.tsx'] },
      { ok: false, match: /uncommitted/ },
    ],
    [
      'missing .vercel blocks',
      { ...clean, hasVercelDir: false },
      { ok: false, match: /NEW project/ },
    ],
    [
      'untracked warns but does NOT block',
      { ...clean, untracked: ['notes.md'] },
      { ok: true, warn: /WILL be uploaded/ },
    ],
    [
      'wrong branch warns but does NOT block',
      { ...clean, branch: 'hotfix' },
      { ok: true, warn: /not 'mvp-launch'/ },
    ],
  ];

  let failed = 0;
  for (const [name, state, want] of cases) {
    const got = evaluate(state);
    const problems = [];
    if (got.ok !== want.ok) problems.push(`ok=${got.ok}, want ${want.ok}`);
    if (want.match && !got.blockers.some((b) => want.match.test(b))) {
      problems.push(`no blocker matching ${want.match} (got: ${JSON.stringify(got.blockers)})`);
    }
    if (want.warn && !got.warnings.some((w) => want.warn.test(w))) {
      problems.push(`no warning matching ${want.warn} (got: ${JSON.stringify(got.warnings)})`);
    }
    if (problems.length) {
      failed++;
      console.error(`  ❌ ${name}: ${problems.join('; ')}`);
    } else {
      console.log(`  ✅ ${name}`);
    }
  }
  if (failed) {
    console.error(`\n❌ predeploy-check self-test: ${failed}/${cases.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`\n✅ predeploy-check self-test: ${cases.length}/${cases.length} passed`);
}

// ── main ───────────────────────────────────────────────────────────────────
function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const state = readRepoState({ fetch: !argv.includes('--no-fetch') });
  const { ok, blockers, warnings } = evaluate(state);

  console.log(`branch   ${state.branch}`);
  console.log(`HEAD     ${state.headSha.slice(0, 12)}`);
  console.log(`remote   ${state.remoteSha.slice(0, 12)}  (origin/${state.branch})`);
  console.log(`drift    ${state.ahead} ahead / ${state.behind} behind`);
  console.log('');

  for (const w of warnings) console.warn(`⚠️  ${w}`);
  for (const b of blockers) console.error(`❌ ${b}`);

  if (!ok) {
    console.error('\n🛑 DO NOT DEPLOY. The tree on disk is not the tree that was reviewed.');
    console.error('   Fix with a worktree off the remote rather than by editing this checkout:');
    console.error(`     git worktree add /tmp/deploy origin/${state.branch}`);
    process.exit(1);
  }

  console.log('✅ tree is byte-identical to the remote — safe to deploy.');
  console.log('   Deploy from the REPO ROOT (not frontend/), with .vercel present:');
  console.log('     npx vercel --prod --yes');
  console.log('');
  console.log('   NOTE: this says nothing about the Vercel Git integration. If a branch is');
  console.log('   wired as the Production Branch, a push to it deploys with no local step');
  console.log('   and this guard never runs.');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`❌ predeploy check could not run: ${err.message}`);
  process.exit(1);
}
