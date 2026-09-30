// The GitLab standby is a standby only while GitHub's pushes reach it and nothing can rewrite it.
//
// .github/workflows/mirror-to-gitlab.yml runs scripts/git-hosting/mirror-to-gitlab.sh, whose
// behaviour scripts/git-hosting/test/test-mirror.sh proves on throwaway repos. This file pins the
// workflow's shape: when it runs, the pinned host key, the secrets reaching the script only through
// env, the dead-man ping, and that no flag in either file can force, prune or delete.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf-8');
const workflow = () => read('.github', 'workflows', 'mirror-to-gitlab.yml');
const script = () => read('scripts', 'git-hosting', 'mirror-to-gitlab.sh');
/** Lines that are not comments, so rationale prose is never read as config or code. */
const code = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));

// As GitLab publishes them for gitlab.com (docs.gitlab.com/user/gitlab_com, "SSH host keys").
const PUBLISHED_ED25519 = 'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf';
const PUBLISHED_SHA256 = 'SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8';

/** The value of an `env:` key in the workflow, quotes removed. */
const envValue = (name: string): string | undefined => {
  const m = new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`, 'm').exec(code(workflow()).join('\n'));
  return m?.[1].replace(/^'(.*)'$/, '$1');
};

/** Every step's `run:` script body, single-line and block form. */
const runBodies = (src: string): string[] => {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (!m) return;
    if (!/^[|>][-+]?$/.test(m[2].trim())) {
      out.push(m[2]);
      return;
    }
    const body: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (l.trim() !== '' && l.length - l.trimStart().length <= m[1].length) break;
      body.push(l);
    }
    out.push(body.join('\n'));
  });
  return out;
};

/** The `if:` of the step with this name. */
const stepIf = (name: string): string => {
  const src = workflow();
  const step = src.slice(src.indexOf(`- name: ${name}`));
  return /^\s+if:\s*(.+)$/m.exec(step.slice(0, step.indexOf('run:')))?.[1] ?? '';
};

describe('mirror-to-gitlab.yml: when it runs', () => {
  it('runs on every branch and tag push, daily and by hand, never for a pull request', () => {
    const on = workflow().slice(workflow().indexOf('\non:'), workflow().indexOf('\npermissions:'));
    expect(on).toMatch(/\n {2}push:\n {4}branches: \['\*\*'\]\n {4}tags: \['\*\*'\]\n/);
    expect(on).toMatch(/\n {2}schedule:\n {4}- cron: '[\d*/ ,-]+'\n/);
    expect(on).toContain('\n  workflow_dispatch:');
    expect(on, 'a pull request, a fork above all, must never hold the mirror key').not.toMatch(/pull_request/);
  });

  it('starts no job for a deleted branch or tag, so nothing is ever deleted on the standby', () => {
    expect(workflow()).toMatch(/\n {4}if: \$\{\{ github\.event_name != 'push' \|\| !github\.event\.deleted \}\}\n/);
  });

  it('queues runs instead of cancelling them, and has a timeout', () => {
    expect(workflow()).toMatch(/\n {2}cancel-in-progress: false\n/);
    expect(workflow()).toMatch(/\n {4}timeout-minutes: \d+\n/);
  });
});

describe('mirror-to-gitlab.yml: what it may touch', () => {
  it('reads the repository and writes nothing on GitHub', () => {
    expect(workflow()).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(code(workflow()).filter((l) => /:\s*write\b/.test(l))).toEqual([]);
  });

  it('checks out every branch and tag, and leaves no GitHub token in .git', () => {
    expect(workflow()).toMatch(/\n {10}fetch-depth: 0\n/);
    expect(workflow()).toMatch(/\n {10}persist-credentials: false\n/);
  });

  it('hands each secret to a step only as an env value, and interpolates nothing into a script', () => {
    const secretLines = code(workflow()).filter((l) => l.includes('secrets.'));
    expect(secretLines.map((l) => l.trim()).sort()).toEqual([
      'GITLAB_MIRROR_SSH_KEY: ${{ secrets.GITLAB_MIRROR_SSH_KEY }}',
      'HC_PING_URL: ${{ secrets.HC_PING_URL_GITHUB_SCHEDULE }}',
    ]);
    const bodies = runBodies(workflow());
    expect(bodies.length, 'no run: steps found (guards the guard)').toBe(2);
    expect(bodies.filter((b) => b.includes('${{'))).toEqual([]);
  });

  it('lets a failed push fail the run', () => {
    const cfg = code(workflow()).join('\n');
    expect(cfg).not.toMatch(/continue-on-error:\s*true/);
    for (const b of runBodies(workflow())) expect(b).not.toMatch(/\|\|\s*(true|exit\s+0)\b|^\s*set\s+\+e\b/m);
    expect(runBodies(workflow())).toContain('bash scripts/git-hosting/mirror-to-gitlab.sh');
    const cfgScript = code(script()).join('\n');
    expect(cfgScript).toMatch(/^set -euo pipefail$/m);
  });
});

describe('the standby is reached over SSH with a pinned host key', () => {
  it('pins the ed25519 key and fingerprint gitlab.com publishes', () => {
    expect(envValue('GITLAB_HOST_KEY')).toBe(PUBLISHED_ED25519);
    expect(envValue('GITLAB_HOST_KEY_SHA256')).toBe(PUBLISHED_SHA256);
  });

  it('pins a fingerprint that is the key it pins', () => {
    // An SSH fingerprint is base64(sha256(key blob)) without padding, as ssh-keygen -l prints it.
    const blob = Buffer.from(PUBLISHED_ED25519.split(' ')[2], 'base64');
    const fp = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
    expect(fp).toBe(PUBLISHED_SHA256);
  });

  it('checks host keys strictly and never scans for one at run time', () => {
    const both = code(workflow()).join('\n') + code(script()).join('\n');
    expect(code(script()).join('\n')).toContain('StrictHostKeyChecking=yes');
    expect(both).not.toMatch(/ssh-keyscan|StrictHostKeyChecking=(no|accept-new|off)/i);
  });

  it('pushes to gitlab.com over SSH', () => {
    expect(envValue('MIRROR_URL')).toMatch(/^git@gitlab\.com:[\w.-]+\/[\w.-]+\.git$/);
  });
});

describe('nothing in the mirror can rewrite or delete a ref', () => {
  it('uses no forcing, mirroring, pruning or deleting flag and no + refspec', () => {
    for (const [file, text] of [
      ['mirror-to-gitlab.yml', workflow()],
      ['mirror-to-gitlab.sh', script()],
    ]) {
      const c = code(text).join('\n');
      expect(c, file).not.toMatch(/--(?:force|force-with-lease|mirror|prune|delete|all)\b/);
      expect(c, file).not.toMatch(/["'\s]\+refs\//);
      expect(c, file).not.toMatch(/\bpush\b[^\n]*\s-f\b/);
    }
  });

  it('refuses at run time any refspec that could force or delete', () => {
    expect(script()).toContain("[[ $spec == [!+:]*:refs/* ]] || { err \"refusing refspec '$spec'\"; exit 2; }");
  });
});

describe('the dead-man switch', () => {
  it('pings from the daily run only, after the push, pass or fail', () => {
    const cond = stepIf('Ping healthchecks.io (daily run only)');
    expect(cond).toContain('always()');
    expect(cond).toContain("github.event_name == 'schedule'");
    expect(workflow()).toContain('MIRROR_OUTCOME: ${{ steps.mirror.outcome }}');
    expect(workflow()).toMatch(/\n {8}id: mirror\n/);
    const ping = runBodies(workflow()).find((b) => b.includes('curl'));
    expect(ping).toMatch(/suffix=\/fail/);
    expect(ping).toMatch(/https:\/\/\*/);
  });
});

describe('CI proves the pushing on throwaway repos', () => {
  it('runs test-mirror.sh from run-all.sh, which ci.yml runs', () => {
    expect(read('scripts', 'git-hosting', 'test', 'run-all.sh')).toMatch(/for t in [^\n]*\btest-mirror\.sh\b/);
    expect(read('.github', 'workflows', 'ci.yml')).toMatch(/run: bash scripts\/git-hosting\/test\/run-all\.sh\n/);
  });
});
