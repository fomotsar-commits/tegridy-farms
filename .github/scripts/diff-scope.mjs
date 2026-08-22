#!/usr/bin/env node
// Does this pull request touch anything a given workflow is responsible for?
//
// ─── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────
//
// Four workflows here were path-filtered at the WORKFLOW level and paired with a
// `-not-applicable.yml` shim publishing the same check name, following GitHub's
// documented "skipped but required" recipe. That recipe has a hole, and the hole
// was live:
//
//   `paths` runs a workflow when ANY changed file matches. `paths-ignore` runs
//   one when ANY changed file does NOT match. They are not complements, so a PR
//   touching both `contracts/**` and `frontend/**` triggers BOTH, and two check
//   runs are created with the same name.
//
// The shims carried a comment arguing this was safe because the shim finishes in
// seconds and "the real verdict is always the last one written". That is not how
// GitHub resolves a duplicated check name. Measured on PR #205 (head
// a4706efb): two check runs named `Slither / Static analysis` — the real
// 4-minute analysis FAILED, the 2-second shim passed, and the PR's check list
// surfaced only the pass. The real result was not merely outranked, it was
// absent. `all-tests-pass` was duplicated on the same PR and agreed by luck.
//
// A required-status rule on either name would have been satisfied by an echo.
// That is the third instance of this repo's documented failure mode — a gate
// that reports green without having checked — and it is why the shims are gone.
//
// ─── THE REPLACEMENT ──────────────────────────────────────────────────────────
//
// The filter moves from the workflow to the JOB. Each real workflow now triggers
// on every pull request, so exactly ONE check run is ever created under its
// name, and a `scope` job decides whether the expensive job actually runs. A job
// skipped by an `if:` reports success to branch protection, which is the outcome
// the shims existed to produce — reached now without a second run that can
// disagree.
//
// ─── FAIL OPEN TOWARD RUNNING ─────────────────────────────────────────────────
//
// Every uncertain path here answers `true` — run the real job. A wrong `true`
// costs CI minutes. A wrong `false` skips a gate and reports success for having
// done so, which is the exact failure being fixed. There is no symmetry between
// those two errors and this file never pretends there is: an empty file list, an
// unreadable one, a pattern list that is somehow empty — all run.
//
// Usage:  git diff --name-only base head | node .github/scripts/diff-scope.mjs 'contracts/**' 'a/b.ts'
// Prints `true` or `false` on stdout. Exit code is 0 unless the ARGUMENTS are
// unusable, which is a bug in the caller rather than a verdict.

/**
 * Compile one workflow path pattern to a regex.
 *
 * GitHub's filter syntax, restricted to the two forms our workflows actually
 * use: a literal path, and a `**` prefix-match. `*` matches within one segment,
 * `**` crosses separators. Everything else is escaped literally — a pattern this
 * cannot express must not silently match nothing.
 */
export function patternToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    // `foo/**` covers `foo` itself as well as everything under it, so the
    // separator is part of the wildcard rather than a required character.
    // Emitting `foo\/.*` instead would make the pattern miss the directory
    // entry — a miss, and every miss here skips a gate.
    if (c === '/' && pattern.slice(i, i + 3) === '/**') {
      out += '(?:\\/.*)?';
      i += 2;
      continue;
    }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        // `**/x` must also match a top-level `x`; swallow the separator.
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Does any changed file fall inside the workflow's scope?
 *
 * @param {string[]} files    paths as git/GitHub report them, repo-relative
 * @param {string[]} patterns the workflow's `paths:` list
 */
export function inScope(files, patterns) {
  // Both directions of "we were told nothing" run the job. A caller that hands
  // us no patterns has not narrowed anything, and a PR that reports no files is
  // a broken read, not an empty change set.
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  if (!Array.isArray(files) || files.length === 0) return true;
  const res = patterns.map(patternToRegExp);
  return files.some((f) => res.some((re) => re.test(f)));
}

/** Read the whole of stdin. Any failure is an empty read, which means "run". */
async function readStdin() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return '';
  }
}

export function parseFileList(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ── entrypoint ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && process.argv[1].endsWith('diff-scope.mjs');
if (isMain) {
  const patterns = process.argv.slice(2);
  if (patterns.length === 0) {
    // Not a verdict — a caller that passes no patterns has written a job that
    // can never narrow anything, and should be told rather than handed `true`.
    console.error('diff-scope: no patterns given; pass the workflow\'s `paths:` list as arguments');
    process.exit(2);
  }
  const files = parseFileList(await readStdin());
  const verdict = inScope(files, patterns);
  console.error(
    `diff-scope: ${files.length} changed file(s) against ${patterns.length} pattern(s) -> ${verdict}`,
  );
  if (!verdict) {
    // Name what was skipped. A silent skip and a silent pass look identical in
    // a log six weeks later.
    console.error(`diff-scope: none of [${patterns.join(', ')}] matched; the real job will be skipped`);
  }
  process.stdout.write(verdict ? 'true' : 'false');
}
