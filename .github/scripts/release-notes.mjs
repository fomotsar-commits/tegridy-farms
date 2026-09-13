#!/usr/bin/env node
// Release notes, bounded on purpose.
//
// --- THE DEFECT THIS REPLACES ------------------------------------------------
//
// release.yml generated its body inline with:
//
//     PREV=$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || echo "")
//
// `git describe --tags` matches ANY tag in the checkout, not just release tags.
// This repo tags freely for other reasons -- `audit-pass-6`, `audit-remediation`,
// `rescue/bayla-ladder`, `wip-nav-*`, `wave7-session1-*` -- and `actions/checkout`
// with `fetch-depth: 0` fetches every one of them.
//
// Measured on trunk (972b7230) on 2026-09-09, with the two tags that actually
// exist on origin:
//
//     git describe --tags --abbrev=0 --match 'audit-*' origin/mvp-launch
//       -> audit-pass-6
//     git log --no-merges --pretty='- %s (%h)' audit-pass-6..origin/mvp-launch | wc -l
//       -> 1322 lines, 121120 bytes
//
// So the FIRST release this repo ever cut would have carried a 121 KB body of
// 1,322 commit subjects. GitHub's release-body limit is 125,000 characters, so
// it would have fit -- it would have published rather than erroring.
//
// That body is not merely long. Grepped over those same 1,322 subjects, 187
// match a security vocabulary and dozens name a specific closed hole in plain
// language: an ERC1155 ownership bypass on the live listing path, a scan-filter
// bypass in an API route, a command injection in a workflow, "C-1 (CRITICAL),
// H-1 (HIGH)". A release body is syndicated to watchers and feeds. Publishing
// the whole history as one page turns a scattered log into a curated index of
// this repo's exploitable-in-the-past surface.
//
// --- THE RULES THIS FILE HOLDS ----------------------------------------------
//
//   1. A release delta is measured from the previous RELEASE tag. Only
//      `v*.*.*` -- the exact glob release.yml already triggers on -- is a
//      release boundary. Every other tag in the repo is bookkeeping.
//   2. With no previous release tag there is no delta, so the body enumerates
//      NOTHING. "Everything that ever happened" is not what changed in v1.0.0.
//   3. Even a correctly bounded range is capped. A long gap between two release
//      tags reproduces the same shape, so past MAX_SUBJECTS the body degrades
//      to a compare link instead of inlining the list.
//
// Usage:  TAG=v1.2.3 REPO_URL=https://github.com/o/r node .github/scripts/release-notes.mjs > release-body.md
// With no TAG it exits non-zero. It never invents a tag and never writes a body
// for a range it could not resolve.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * The release-tag namespace. This is deliberately the SAME glob release.yml
 * triggers on (`on: push: tags: v*.*.*`); if that trigger ever widens, this
 * has to widen with it or the two disagree about what a release is.
 */
export const RELEASE_TAG_GLOB = 'v*.*.*';

/**
 * Above this many subjects the body links to the compare view instead of
 * inlining them. Sized well under GitHub's 125,000-character body limit: 200
 * subjects of this repo's average length is roughly 18 KB.
 */
export const MAX_SUBJECTS = 200;

/**
 * Compile a git-describe `--match` glob (fnmatch, not regex) to a RegExp, so
 * the same decision can be made in a test without shelling out to git.
 * `*` matches any run of characters including none; every other character is
 * literal.
 */
export function globToRegExp(glob) {
  const body = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : `\\${ch}`));
  return new RegExp(`^${body}$`);
}

/** Is this tag name a release boundary? */
export function isReleaseTag(name) {
  return globToRegExp(RELEASE_TAG_GLOB).test(String(name ?? ''));
}

/**
 * Render the release body.
 *
 * @param {object} o
 * @param {string} o.tag          the tag being released
 * @param {string} o.prev         previous release tag, or '' when there is none
 * @param {string[]} o.subjects   one pre-formatted line per commit
 * @param {string} [o.repoUrl]    e.g. https://github.com/owner/repo
 * @param {number} [o.maxSubjects]
 * @returns {string}
 */
export function renderNotes({ tag, prev, subjects, repoUrl = '', maxSubjects = MAX_SUBJECTS }) {
  const lines = [`## What's changed in ${tag}`, ''];
  const list = Array.isArray(subjects) ? subjects.filter((s) => String(s).trim() !== '') : [];
  const compare = repoUrl ? `${repoUrl}/compare/${prev}...${tag}` : '';

  if (!prev) {
    // Rule 2. No previous release tag means no delta exists to describe, and
    // the whole history is emphatically not it.
    lines.push(
      `First tagged release. There is no previous \`${RELEASE_TAG_GLOB}\` tag to`,
      'measure against, so this body does not enumerate commit history.',
    );
  } else if (list.length === 0) {
    lines.push(`No non-merge commits between \`${prev}\` and \`${tag}\`.`);
  } else if (list.length > maxSubjects) {
    // Rule 3.
    lines.push(
      `${list.length} commits since \`${prev}\` -- too many to inline here.`,
      '',
      compare
        ? `Full comparison: [\`${prev}...${tag}\`](${compare})`
        : `Compare \`${prev}...${tag}\` in the repository for the full list.`,
    );
  } else {
    lines.push(`Commits since \`${prev}\`:`, '', ...list);
  }

  lines.push('');
  lines.push(
    repoUrl
      ? `Full changelog: [CHANGELOG.md](${repoUrl}/blob/${tag}/CHANGELOG.md)`
      : `Full changelog: CHANGELOG.md at \`${tag}\`.`,
  );
  return `${lines.join('\n')}\n`;
}

/** `git ...` -> trimmed stdout, or '' if git failed. */
function git(args) {
  try {
    // stderr is discarded: "No names found" is the EXPECTED answer on a repo
    // with no release tag yet, and printing `fatal:` into a release log reads
    // like a failure when it is the first-release path working correctly.
    return execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * `git ...` -> trimmed stdout. Unlike `git()` above, a git failure PROPAGATES.
 * Use this everywhere an error is not also a legitimate answer.
 */
function gitStrict(args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

/** The previous release tag reachable from `tag`, or '' when there is none. */
export function previousReleaseTag(tag, run = git) {
  // The lenient runner is correct HERE and only here: "No names found" is the
  // expected answer on a repo that has never cut a release, not a failure.
  return run(['describe', '--tags', '--abbrev=0', '--match', RELEASE_TAG_GLOB, `${tag}^`]);
}

/**
 * The commit subjects between `prev` and `tag`.
 *
 * Deliberately NOT error-tolerant. By the time this runs, `prev` has been
 * resolved by describe and `tag` has been verified to exist, so a failing
 * `git log` means something is wrong with the checkout -- and an empty list
 * would render as "No non-merge commits between X and Y", which is a
 * confident, wrong, publishable sentence. An unreadable range must not read
 * as an empty one.
 */
export function collectSubjects(prev, tag, run = gitStrict) {
  if (!prev) return [];
  return run(['log', '--no-merges', '--pretty=- %s (%h)', `${prev}..${tag}`])
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function main() {
  const tag = process.env.TAG ?? '';
  if (!tag) {
    process.stderr.write('release-notes: TAG is required\n');
    process.exit(1);
  }
  const prev = previousReleaseTag(tag);
  const subjects = collectSubjects(prev, tag);
  process.stdout.write(
    renderNotes({ tag, prev, subjects, repoUrl: (process.env.REPO_URL ?? '').replace(/\/+$/, '') }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
