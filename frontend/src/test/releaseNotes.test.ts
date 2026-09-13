// The release workflow was a loaded gun, and this is the safety.
//
// .github/workflows/release.yml has ZERO runs, ZERO releases, and no `v*.*.*`
// tag has ever existed in this repo. Its first run would therefore have been
// its only rehearsal, and it had two live defects:
//
//   1. `draft: false` with no `target_commitish`, and a dispatch input whose
//      own description said the tag "must already exist on origin" -- which
//      NOTHING enforced. A single `gh workflow run release.yml -f tag=vX`
//      would create the tag on the default branch and publish a real public
//      release.
//   2. An UNMATCHED `git describe --tags`. This repo tags for bookkeeping
//      (audit-pass-6, audit-remediation, rescue/bayla-ladder, wip-nav-*,
//      wave7-session1-*), `actions/checkout` with `fetch-depth: 0` fetches all
//      of them, and describe matched the nearest one. Measured on trunk
//      972b7230 with only origin's tags present: PREV resolved to
//      `audit-pass-6` and the body came to 1328 lines / 121241 bytes of 1,322
//      commit subjects. GitHub's body limit is 125,000 characters, so it would
//      have FIT and published. 187 of those subjects match a security
//      vocabulary and dozens name a specific closed hole outright.
//
// WHAT IS PINNED -- behaviour and wiring, never wording:
//   * a release cannot be published by CI without a human (draft)
//   * a dispatched release fails closed on a tag that does not exist yet
//   * the notes range is bounded to the previous RELEASE tag, and only
//     `v*.*.*` counts as one -- the repo's other tags must not be boundaries
//   * with no previous release tag the body enumerates NOTHING
//   * even a bounded range is capped, so a long gap cannot re-create the index
//
// Step names, job names and ordering of unrelated steps are NOT asserted.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RELEASE_TAG_GLOB,
  MAX_SUBJECTS,
  globToRegExp,
  isReleaseTag,
  renderNotes,
  collectSubjects,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../.github/scripts/release-notes.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

const source = (): string => readFileSync(WORKFLOW, 'utf-8');

/**
 * Lines with YAML comments stripped, so the rationale prose above a step is
 * never mistaken for the config it describes. (This file's own fix is heavily
 * commented; without this, every assertion below would pass on the comments.)
 */
const configText = (): string =>
  source()
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/**
 * Every `run:` script body in the file, single-line and block form alike.
 */
const runScripts = (): string[] => {
  const lines = source().split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-?\s*run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, indent, rest] = m;
    if (rest.trim() !== '' && !/^[|>][-+]?\d*$/.test(rest.trim())) {
      out.push(rest);
      continue;
    }
    let block = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && !lines[j].startsWith(`${indent} `)) break;
      block += `${lines[j]}\n`;
    }
    out.push(block);
  }
  return out;
};

/**
 * The tags this repository actually carried on 2026-09-09, read off `git tag -l`
 * at trunk 972b7230. `verified-000a24e8` is the one that matters most: it
 * starts with `v`, so a lazier boundary test than the real glob lets it through
 * and the bound silently stops bounding.
 */
const REAL_NON_RELEASE_TAGS = [
  'audit-pass-6',
  'audit-remediation',
  'backup/crazy-nobel-pre-rebase',
  'ceiling-guard-21c5ba1d',
  'ceiling-wrapup-fdf2d929',
  'lend-eoa-whitelist-2026-09-05',
  'pre-rebase-7f7088c5',
  'pushed-9fa65697',
  'rescue/bayla-committed',
  'rescue/bayla-four-fixes',
  'rescue/bayla-ladder',
  'restake-return-strand-fix',
  'reviewed-7f7088c5',
  'route-tabs-migration-work',
  'verified-000a24e8',
  'wave0-runbook-7495c2fb',
  'wave7-session1-cfa7a271',
  'wave7-session1-latest',
  'wip-nav-b0a2a1c4',
  'wip-toweli-cta-a7546d77',
];

/** A handful of the real subjects the 121 KB body would have published. */
const SECURITY_SUBJECTS = [
  '- fix(orderbook): close an ERC1155 ownership bypass on the live listing path (7da08a75)',
  '- fix(api): close the solrpc scan-filter bypass and bill batches per call (79f32a4d)',
  '- fix(ci): close a command injection I introduced in revenue-watch.yml (#267) (e1b0c22f)',
  '- fix(v4-security): close C-1 (CRITICAL), H-1 (HIGH), H-2 -- with exploit tests (89b57851)',
];

describe('release-tag boundary', () => {
  it('uses the same glob the workflow triggers on, so the two cannot disagree', () => {
    // If `on: push: tags:` widens, this has to widen with it. Read the trigger
    // rather than trusting a copy of it.
    const trigger = /tags:\s*\n\s*-\s*["']?([^"'\n]+)["']?/.exec(configText());
    expect(trigger).not.toBeNull();
    expect(trigger![1].trim()).toBe(RELEASE_TAG_GLOB);
  });

  it('accepts release tags, including prereleases', () => {
    expect(isReleaseTag('v1.0.0')).toBe(true);
    expect(isReleaseTag('v0.1.0')).toBe(true);
    expect(isReleaseTag('v10.2.30')).toBe(true);
    expect(isReleaseTag('v1.0.0-rc.1')).toBe(true);
  });

  it('rejects every bookkeeping tag this repo actually carries', () => {
    // THE bug. `git describe --tags` with no --match matched these, and
    // `audit-pass-6` is what it resolved to on trunk.
    const leaked = REAL_NON_RELEASE_TAGS.filter((t) => isReleaseTag(t));
    expect(leaked).toEqual([]);
  });

  it('treats `*` as any-run and every other glob character as literal', () => {
    expect(globToRegExp('v*.*.*').test('v1.2.3')).toBe(true);
    // The dots are literal, not any-character: this is what keeps a dotless
    // `v`-prefixed tag out.
    expect(globToRegExp('v*.*.*').test('verified-000a24e8')).toBe(false);
    expect(globToRegExp('v*.*.*').test('audit-pass-6')).toBe(false);
  });
});

describe('release body is bounded', () => {
  const many = Array.from({ length: 1322 }, (_, i) => `- subject ${i} (abc${i})`);

  it('enumerates nothing when there is no previous release tag', () => {
    // The exact situation this repo is in right now: the first release. The
    // whole history is not "what changed in v1.0.0".
    const body = renderNotes({ tag: 'v1.0.0', prev: '', subjects: many, repoUrl: 'https://x/y' });
    expect(body.split('\n').length).toBeLessThan(15);
    expect(body).not.toContain('subject 0 ');
    expect(body).not.toContain('subject 1321 ');
  });

  it('caps a bounded-but-huge range instead of inlining it', () => {
    const body = renderNotes({
      tag: 'v2.0.0',
      prev: 'v1.0.0',
      subjects: many,
      repoUrl: 'https://x/y',
    });
    expect(body.split('\n').length).toBeLessThan(15);
    expect(body).toContain('/compare/v1.0.0...v2.0.0');
    expect(body).not.toContain('subject 500 ');
  });

  it('keeps no security subject in an over-cap body', () => {
    // The property that actually matters, stated against real subjects rather
    // than a line count.
    const body = renderNotes({
      tag: 'v2.0.0',
      prev: 'v1.0.0',
      subjects: [...SECURITY_SUBJECTS, ...many],
      repoUrl: 'https://x/y',
    });
    for (const subject of SECURITY_SUBJECTS) {
      expect(body).not.toContain(subject);
    }
  });

  it('still lists a normal-sized delta -- the bound is not a mute button', () => {
    const few = ['- fix: a thing (aaa1111)', '- feat: another thing (bbb2222)'];
    const body = renderNotes({ tag: 'v1.1.0', prev: 'v1.0.0', subjects: few, repoUrl: 'https://x/y' });
    for (const subject of few) expect(body).toContain(subject);
  });

  it('does not turn an unreadable range into an empty one', () => {
    // The house's most-repeated bug class. If `git log` fails and the failure
    // is swallowed, the body renders "No non-merge commits between X and Y" --
    // a confident, wrong sentence, published. By the time this runs `prev` has
    // been resolved and `tag` verified to exist, so a failure here is a broken
    // checkout and must stop the release.
    expect(() =>
      collectSubjects('v1.0.0', 'v2.0.0', () => {
        throw new Error('fatal: bad revision');
      }),
    ).toThrow();
  });

  it('asks git for nothing when there is no previous release tag', () => {
    let called = false;
    const subjects = collectSubjects('', 'v1.0.0', () => {
      called = true;
      return 'should not be reached';
    });
    expect(called).toBe(false);
    expect(subjects).toEqual([]);
  });

  it('caps at MAX_SUBJECTS exactly, not one entry either side', () => {
    const at = Array.from({ length: MAX_SUBJECTS }, (_, i) => `- s${i} (h${i})`);
    const over = [...at, `- s${MAX_SUBJECTS} (h${MAX_SUBJECTS})`];
    expect(renderNotes({ tag: 'v2', prev: 'v1', subjects: at })).toContain('- s0 (h0)');
    expect(renderNotes({ tag: 'v2', prev: 'v1', subjects: over })).not.toContain('- s0 (h0)');
  });
});

describe('release.yml cannot publish on its own', () => {
  it('creates a draft, so no CI run reaches the public', () => {
    const config = configText();
    expect(config).toMatch(/^\s*draft:\s*true\s*$/m);
    expect(config).not.toMatch(/^\s*draft:\s*false\s*$/m);
  });

  it('fails closed on a dispatched tag that does not exist yet', () => {
    // The dispatch input's description claimed this precondition; nothing
    // enforced it, and `draft: false` meant the unenforced case published.
    //
    // Pinned as the CLASS of operation, not its spelling: some run: script
    // asks git to RESOLVE a ref under refs/tags/ and exits non-zero when it
    // cannot. The distinction matters -- the pre-existing "Resolve tag" step
    // contains both the string `refs/tags/` (in a ${VAR#prefix} expansion) and
    // an `exit 1`, so a test that only looked for those two would have passed
    // against the unfixed file and proved nothing.
    const gate = runScripts().find(
      (s) => /git\s+(show-ref|rev-parse|cat-file)[^\n]*refs\/tags\//.test(s) && /exit\s+1/.test(s),
    );
    expect(gate, 'no step resolves the dispatched tag before releasing').toBeDefined();
  });

  it('checks the tag exists before it builds or publishes anything', () => {
    const config = configText();
    const gateAt = config.search(/git\s+(show-ref|rev-parse|cat-file)[^\n]*refs\/tags\//);
    const publishAt = config.search(/action-gh-release/);
    expect(gateAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(publishAt);
  });
});

describe('release.yml notes generation stays bounded', () => {
  it('never calls git describe without a --match bound', () => {
    // Stated as a property of every describe invocation rather than as "the
    // script is used", so re-inlining it is fine as long as it stays bounded.
    for (const script of runScripts()) {
      for (const line of script.split('\n')) {
        if (!/git\s+describe/.test(line)) continue;
        expect(line, `unbounded git describe: ${line.trim()}`).toMatch(/--match/);
      }
    }
  });

  it('is wired to the tested generator', () => {
    expect(configText()).toContain('.github/scripts/release-notes.mjs');
  });
});
