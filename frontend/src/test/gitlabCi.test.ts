// GitLab CI runs the GitHub workflow files under act; it never copies a gate out of them.
// Pinned here: every push or pull_request workflow is run by exactly one GitLab job, or is
// listed below with the reason it is not; each job runs only its one command; no job can
// hand the Docker socket or a leftover of one run to workflow code; the secret scan reads
// nothing the change controls; and scripts/ci/local-gates.sh runs only commands CI runs.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf-8');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const workflowFiles = () => readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

// Workflows GitLab CI does not run. A new push or pull_request workflow that is in neither
// list and has no GitLab job turns this suite red.
const EXCLUDED: Record<string, string> = {
  'codeql.yml': 'GitHub only: SARIF goes to GitHub code scanning, and the CodeQL licence covers CI for code hosted on GitHub.com.',
  'release.yml': 'Publishes a GitHub Release through the GitHub API (softprops/action-gh-release); no v* tag has ever been cut.',
  'solana-deploy-artifact.yml': 'Manual mainnet builds: its inputs are spliced into scripts, so an act port needs an input allowlist first, and its program build has the unset-SIZE bug.',
  'arb-linkage-monitor.yml': 'Schedule only; moves to the ops scheduler.',
  'revenue-watch.yml': 'Schedule only; moves to the ops scheduler.',
  'synthetic-monitor.yml': 'Schedule only; moves to the ops scheduler.',
  'supabase-backup.yml': 'Schedule only, and it holds secrets; moves to the ops scheduler.',
  'contracts-coverage.yml': 'Schedule and dispatch only; moves to the ops scheduler.',
};
const REPLACED: Record<string, { job: string; why: string }> = {
  'gitleaks.yml': { job: 'gitleaks', why: 'gitleaks-action reads PR commits through the GitHub API; the job runs the pinned binary over the same range.' },
};
// A wired workflow whose red does not block a merge. Every other one blocks.
const MAY_FAIL: Record<string, string> = {
  'registry-onchain.yml': 'Reads mainnet over public RPCs; never a required check on GitHub either.',
};

/** Event names under a workflow's top-level `on:` block. */
function triggers(src: string): Set<string> {
  const events = new Set<string>();
  let inOn = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^on:/.test(line)) { inOn = true; continue; }
    if (/^\S/.test(line)) { inOn = false; continue; }
    const key = /^ {2}([a-z_]+):/.exec(line);
    if (inOn && key) events.add(key[1]);
  }
  return events;
}

interface Job { name: string; keys: Map<string, string[]>; hidden: boolean }

/** Top-level blocks of .gitlab-ci.yml with their 2-space keys, `extends` folded in. */
function gitlabJobs(): Job[] {
  const blocks: Job[] = [];
  let cur: Job | null = null;
  let key: string | null = null;
  for (const line of read('.gitlab-ci.yml').split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const top = /^([^\s:]+):\s*(.*)$/.exec(line);
    if (top) {
      cur = { name: top[1], keys: new Map(), hidden: top[1].startsWith('.') };
      blocks.push(cur);
      key = null;
      continue;
    }
    const sub = /^ {2}([a-z_]+):\s*(.*)$/.exec(line);
    if (cur && sub) {
      key = sub[1];
      cur.keys.set(key, sub[2] ? [sub[2]] : []);
      continue;
    }
    if (cur && key) cur.keys.get(key)!.push(line.trim());
  }
  const byName = new Map(blocks.map((b) => [b.name, b]));
  for (const b of blocks) {
    const parent = b.keys.get('extends')?.[0];
    if (!parent) continue;
    for (const [k, v] of byName.get(parent)?.keys ?? []) if (!b.keys.has(k)) b.keys.set(k, v);
  }
  return blocks;
}

const RESERVED = new Set(['workflow', 'variables', 'default', 'stages', 'include']);
const jobs = () => gitlabJobs().filter((b) => !b.hidden && !RESERVED.has(b.name));
/** The workflow files a job hands to act. */
const actTargets = (j: Job) =>
  (j.keys.get('script') ?? []).flatMap((l) => /scripts\/ci\/act-job\.sh\s+([\w.-]+\.ya?ml)\b/.exec(l)?.[1] ?? []);

describe('GitLab CI runs the workflow files', () => {
  it('finds its jobs (guards the guard)', () => {
    expect(jobs().length).toBeGreaterThanOrEqual(8);
    expect(jobs().filter((j) => actTargets(j).length > 0).length).toBeGreaterThanOrEqual(6);
  });

  it('runs every push or pull_request workflow in exactly one job, or says why not', () => {
    const problems: string[] = [];
    for (const f of workflowFiles()) {
      const events = triggers(read('.github', 'workflows', f));
      const runners = jobs().filter((j) => actTargets(j).includes(f)).map((j) => j.name);
      if (EXCLUDED[f] || REPLACED[f]) {
        if (runners.length) problems.push(`${f} is listed as not run here, yet ${runners.join(', ')} runs it`);
      } else if (events.has('push') || events.has('pull_request')) {
        if (runners.length !== 1) problems.push(`${f} has a push/pull_request trigger and ${runners.length} GitLab jobs run it (want 1)`);
      } else {
        problems.push(`${f} is neither run by a GitLab job nor listed in EXCLUDED with a reason`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('lists only workflows that exist, once each, with a reason', () => {
    const files = new Set(workflowFiles());
    const listed = [...Object.keys(EXCLUDED), ...Object.keys(REPLACED), ...Object.keys(MAY_FAIL)];
    expect(listed.filter((f) => !files.has(f))).toEqual([]);
    expect(Object.keys(EXCLUDED).filter((f) => f in REPLACED)).toEqual([]);
    for (const why of [...Object.values(EXCLUDED), ...Object.values(REPLACED).map((r) => r.why)]) {
      expect(why.length).toBeGreaterThan(20);
    }
    const targets = jobs().flatMap(actTargets);
    expect(targets.filter((f) => !files.has(f))).toEqual([]);
  });

  it('keeps the job that replaces each replaced workflow', () => {
    const names = new Set(jobs().map((j) => j.name));
    expect(Object.values(REPLACED).map((r) => r.job).filter((j) => !names.has(j))).toEqual([]);
  });

  it('names every workflow it does not run in the .gitlab-ci.yml comments', () => {
    const comments = read('.gitlab-ci.yml').split(/\r?\n/).filter((l) => /^\s*#/.test(l)).join('\n');
    expect([...Object.keys(EXCLUDED), ...Object.keys(REPLACED)].filter((f) => !comments.includes(f))).toEqual([]);
  });

  it('runs every job in every pipeline, and lets only the listed workflows fail', () => {
    const problems: string[] = [];
    for (const j of jobs()) {
      for (const k of ['rules', 'when', 'only', 'except']) {
        if (j.keys.has(k)) problems.push(`${j.name} sets \`${k}\`, so some pipelines would not run it`);
      }
      const needs = j.keys.get('needs');
      if (actTargets(j).length && needs && needs.join(' ') !== '[]') problems.push(`${j.name} waits on another job; a workflow runs on its own, as on GitHub`);
      const mayFail = actTargets(j).length > 0 && actTargets(j).every((f) => MAY_FAIL[f]);
      if (j.keys.has('allow_failure') && !mayFail) problems.push(`${j.name} may fail without blocking, and is not in MAY_FAIL`);
    }
    expect(problems).toEqual([]);
  });

  // GitLab runs before_script and script in one shell, so an `exit 0` there ends the job green.
  it('gives each job exactly its one command, and nothing that runs before or after it', () => {
    const own: Record<string, string> = {
      'pipeline-exists': 'bash scripts/ci/act-job.sh --self-test',
      gitleaks: 'bash scripts/ci/gitleaks-range.sh',
    };
    const problems: string[] = [];
    for (const j of jobs()) {
      const want = actTargets(j).length ? `bash scripts/ci/act-job.sh ${actTargets(j)[0]}` : own[j.name];
      if (!want) problems.push(`${j.name} is a job this test does not know`);
      else if (JSON.stringify(j.keys.get('script')) !== JSON.stringify([`- ${want}`])) {
        problems.push(`${j.name} runs ${JSON.stringify(j.keys.get('script'))}, not just \`${want}\``);
      }
    }
    for (const b of gitlabJobs()) {
      for (const k of ['before_script', 'after_script', 'hooks']) if (b.keys.has(k)) problems.push(`${b.name} sets \`${k}\``);
    }
    expect(problems).toEqual([]);
  });

  it('always has a pipeline, on our runner only, for merge requests and trunk pushes', () => {
    const always = jobs().find((j) => j.name === 'pipeline-exists');
    expect(always, 'the always-run job is gone').toBeDefined();
    for (const k of ['rules', 'when', 'only', 'except', 'needs']) expect(always!.keys.has(k)).toBe(false);
    const blocks = gitlabJobs();
    expect(blocks.find((b) => b.name === 'default')?.keys.get('tags')).toEqual(['[tegridy-runner]']);
    expect(jobs().filter((j) => j.keys.has('tags')).map((j) => j.name)).toEqual([]);
    // Exactly these two conditions, whole: a clause appended to either one could skip it.
    const rules = blocks.find((b) => b.name === 'workflow')?.keys.get('rules') ?? [];
    expect(rules.filter((l) => l.startsWith('- '))).toEqual([
      '- if: $CI_PIPELINE_SOURCE == "merge_request_event"',
      '- if: $CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "mvp-launch"',
    ]);
    expect(rules.filter((l) => !l.startsWith('- ') && !/^(auto_cancel:|on_new_commit: [a-z_]+)$/.test(l))).toEqual([]);
  });
});

/** Every file the CI and runner setup are made of: .gitlab-ci.yml and scripts/ci/**. */
function ciFiles(): { file: string; lines: string[] }[] {
  const out: { file: string; lines: string[] }[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(REPO_ROOT, rel))) {
      const p = `${rel}/${e}`;
      if (statSync(join(REPO_ROOT, p)).isDirectory()) walk(p);
      else out.push({ file: p, lines: read(p).split(/\r?\n/) });
    }
  };
  walk('scripts/ci');
  out.push({ file: '.gitlab-ci.yml', lines: read('.gitlab-ci.yml').split(/\r?\n/) });
  return out;
}
const code = (lines: string[]) => lines.filter((l) => !/^\s*#/.test(l));

describe('no job can hand the Docker socket to workflow code', () => {
  it('reads the CI files (guards the guard)', () => {
    expect(ciFiles().map((f) => f.file)).toEqual(expect.arrayContaining([
      '.gitlab-ci.yml', 'scripts/ci/act-job.sh', 'scripts/ci/runner/setup-wsl-runner.sh', 'scripts/ci/act/Dockerfile',
    ]));
  });

  it('tells act to mount no socket into job containers', () => {
    // act mounts the host socket by default; only `-` turns that off.
    expect(code(read('scripts/ci/act-job.sh').split(/\r?\n/)).join('\n')).toMatch(/--container-daemon-socket -(\s|$)/m);
  });

  it('never names any other socket for act', () => {
    const bad = ciFiles().flatMap(({ file, lines }) =>
      code(lines).flatMap((l) => [...l.matchAll(/--container-daemon-socket(?:=|\s+)(\S+)/g)]
        .filter((m) => m[1] !== '-').map(() => `${file}: ${l.trim()}`)));
    expect(bad).toEqual([]);
  });

  it('never mounts docker.sock; the only one named is the runner user\'s own rootless socket', () => {
    const ownSocket = /DOCKER_HOST="?unix:\/\/(\$RUNTIME|\/run\/user\/\d+)\/docker\.sock/;
    const removesRootSocket = /^\s*rm -f \/var\/run\/docker\.sock\s*$/;
    const bad = ciFiles().flatMap(({ file, lines }) =>
      code(lines).filter((l) => /docker\.sock\b|\/var\/run\/docker/.test(l))
        .filter((l) => !(ownSocket.test(l) || removesRootSocket.test(l)) || /\s(-v|--volume|--mount)[\s=]/.test(l))
        .map((l) => `${file}: ${l.trim()}`));
    expect(bad).toEqual([]);
  });

  it('never runs a container privileged or with added capabilities', () => {
    const bad = ciFiles().flatMap(({ file, lines }) =>
      code(lines).filter((l) => /--privileged|privileged\s*=\s*true|--cap-add|--container-cap-add|--userns[= ]host/.test(l))
        .map((l) => `${file}: ${l.trim()}`));
    expect(bad).toEqual([]);
  });

  it('gives act no host access, no secrets, and no variables but the repository name', () => {
    const src = code(read('scripts', 'ci', 'act-job.sh').split(/\r?\n/)).join('\n');
    expect(src.match(/--container-options|--bind\b|-self-hosted|--secret(?![-\w])|(^|\s)-s\s+"?[A-Za-z_]+=/gm) ?? []).toEqual([]);
    expect([...src.matchAll(/-P\s+"([^"]*)"/g)].map((m) => m[1])).toEqual(['ubuntu-latest=$img']);
    expect([...src.matchAll(/--env\s+"([A-Za-z_]+)=/g)].map((m) => m[1]).sort()).toEqual(['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER']);
    expect([...src.matchAll(/--(env|secret|var|input)-file\s+(\S+)/g)].map((m) => m[2])).toEqual(Array(4).fill('"$run/empty"'));
  });

  it('lets the verdict alone decide a workflow job', () => {
    const src = read('scripts', 'ci', 'act-job.sh').replace(/\r\n/g, '\n');
    expect(src).toMatch(/^set -euo pipefail$/m);
    expect(src).toMatch(
      /\n {2}if verdict "\$run\/ids" "\$run\/act\.jsonl" "\$rc" "\$run\/needs"; then\n {4}echo "act-job: GREEN"\n {2}else\n {4}echo [^\n]*\n {4}return 1\n {2}fi\n\}\n\nmain "\$@"\n$/,
    );
  });

  it('lets nothing one pipeline leaves reach the next', () => {
    const src = code(read('scripts', 'ci', 'act-job.sh').split(/\r?\n/)).join('\n');
    // One job at a time, act's shared tool cache volume dropped, and a merge request's
    // actions/cache writes kept off the store trunk pushes read (cache_store, self-tested).
    expect(src).toMatch(/^ {2}\[ "\$\{ACT_EXCLUSIVE_RUNNER:-\}" = 1 \] \|\|\n {4}die /m);
    expect(src).toMatch(/^ {2}docker volume rm -f act-toolcache >\/dev\/null$/m);
    expect(src).toMatch(/^ {2}cache=\$\(cache_store "\$EVENT" "\$state" "\$run"\)$/m);
    expect(src.match(/--cache-server-path\s+\S+/g)).toEqual(['--cache-server-path "$cache"']);
    // The job token stays out of the .git that act copies into every container.
    const yml = code(read('.gitlab-ci.yml').split(/\r?\n/)).join('\n');
    expect(yml.match(/FF_GIT_URLS_WITHOUT_TOKENS.*/g)).toEqual(['FF_GIT_URLS_WITHOUT_TOKENS: "true"']);
    expect(yml).toMatch(/^variables:\n(?: {2}.*\n)*? {2}FF_GIT_URLS_WITHOUT_TOKENS: "true"$/m);
    expect(src).toContain('grep -rqF --exclude-dir=objects -f - "$(git rev-parse --absolute-git-dir)" <<<"$CI_JOB_TOKEN" || found=$?');
    expect(src).toMatch(/^ {4}\[ "\$found" -eq 1 \] \|\| die /m);
  });

  it('pins act, gitleaks, gitlab-runner and the act image by hash', () => {
    const pins = read('scripts', 'ci', 'runner', 'pins.env');
    for (const tool of ['ACT_LINUX_X86_64', 'GITLEAKS_LINUX_X64', 'GITLAB_RUNNER_LINUX_AMD64']) {
      expect(pins).toMatch(new RegExp(`^${tool}_SHA256=[0-9a-f]{64}$`, 'm'));
    }
    for (const tool of ['ACT', 'GITLEAKS', 'GITLAB_RUNNER']) expect(pins).toMatch(new RegExp(`^${tool}_VERSION=\\d+\\.\\d+\\.\\d+$`, 'm'));
    expect(read('scripts', 'ci', 'act', 'Dockerfile')).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
    expect(read('scripts', 'ci', 'act-job.sh')).toContain('"$ACT_VERSION"');
    expect(read('scripts', 'ci', 'gitleaks-range.sh')).toContain('"$GITLEAKS_VERSION"');
  });

  it('runs jobs as a user with no root path: no sudo, no docker group, no new privileges', () => {
    const setup = code(read('scripts', 'ci', 'runner', 'setup-wsl-runner.sh').split(/\r?\n/)).join('\n');
    expect(setup).not.toMatch(/usermod\s+[^\n]*-a?G[^\n]*\b(docker|sudo)\b|gpasswd\s+-a\s+\S+\s+(docker|sudo)|adduser\s+\S+\s+(docker|sudo)/);
    expect(setup).toContain('NoNewPrivileges=true');
    expect(setup).toContain('User=$CI_USER');
    expect(setup).toMatch(/\[automount\]\nenabled=false/);
    expect(setup).toMatch(/\[interop\]\nenabled=false/);
  });
});

describe('the secret scan reads nothing the change controls', () => {
  it('scans a clone with no working tree, with gitleaks:allow off and the base commit\'s config', () => {
    const src = code(read('scripts', 'ci', 'gitleaks-range.sh').split(/\r?\n/)).join('\n').replace(/\\\n\s*/g, ' ');
    // gitleaks loads .gitleaksignore from the folder it scans; a clone with no checkout has none.
    expect(src).toMatch(/^git clone -q --no-checkout --shared \. "\$work\/repo"$/m);
    const scan = src.split('\n').filter((l) => /^gitleaks\s/.test(l));
    expect(scan).toHaveLength(1);
    expect(scan[0]).toMatch(/ --ignore-gitleaks-allow /);
    expect(scan[0]).toMatch(/ --config "\$work\/gitleaks\.toml" /);
    expect(scan[0]).toMatch(/ --gitleaks-ignore-path "\$work\/ignore" /);
    expect(scan[0]).toMatch(/ "\$work\/repo"$/);
    expect(src).toContain('git show "$from:.gitleaks.toml" >"$work/gitleaks.toml"');
    expect(src).toContain('git show "$from:.gitleaksignore" >"$work/ignore/.gitleaksignore"');
  });
});

/** A command as a comparable string: line continuations joined, whitespace collapsed. */
const norm = (s: string) => s.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

/** Every `gate <area> "<label>" <dir> <command>` line in local-gates.sh. */
function gates(): { area: string; command: string }[] {
  return read('scripts', 'ci', 'local-gates.sh')
    .split(/\r?\n/)
    .flatMap((l) => {
      const m = /^\s*gate (root|frontend|contracts|solana) "[^"]*" \S+ (.+)$/.exec(l);
      return m ? [{ area: m[1], command: norm(m[2]) }] : [];
    });
}

/** Every script line CI runs: workflow `run:` lines and .gitlab-ci.yml script items. */
function ciLines(): string[] {
  return [...workflowFiles().map((f) => read('.github', 'workflows', f)), read('.gitlab-ci.yml')]
    .flatMap((src) => code(src.split(/\r?\n/)).join('\n').replace(/\\\r?\n\s*/g, ' ').split('\n'))
    .map((l) => l.trim().replace(/^-?\s*run:\s*/, '').replace(/^-\s+/, '').replace(/\s+/g, ' '));
}
/** Is `cmd` a whole command on `line`, not the front of a longer one? */
const runsIn = (cmd: string, line: string) =>
  new RegExp(`(^|[\\s;&|(!])${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s*[;&|)])`).test(line);

describe('local-gates.sh runs only what CI runs', () => {
  it('finds its gates in every area (guards the guard)', () => {
    expect(gates().length).toBeGreaterThanOrEqual(25);
    for (const area of ['root', 'frontend', 'contracts', 'solana']) expect(gates().some((g) => g.area === area)).toBe(true);
  });

  it('runs no command that no workflow and no GitLab job runs, word for word', () => {
    const lines = ciLines();
    expect(gates().filter((g) => !lines.some((l) => runsIn(g.command, l))).map((g) => g.command)).toEqual([]);
  });

  // That it also runs every command of the CLAUDE.md build recipe is pinned in
  // frontDoor.test.ts, which already reads CLAUDE.md as a doc guard.

  it('runs every self-test and node --test that ci.yml runs', () => {
    const named = code(read('.github', 'workflows', 'ci.yml').split(/\r?\n/))
      .flatMap((l) => /^\s*(?:-\s*)?run:\s*(node (?:--test \S.*|\S+\.mjs --self-test))\s*$/.exec(l)?.[1] ?? [])
      .map(norm);
    expect(named.length).toBeGreaterThanOrEqual(8);
    const commands = new Set(gates().map((g) => g.command));
    const missing = named.filter((c) => !commands.has(c));
    expect(missing, 'add a `gate <area> "<label>" <dir> <command>` line for each to scripts/ci/local-gates.sh').toEqual([]);
  });
});
