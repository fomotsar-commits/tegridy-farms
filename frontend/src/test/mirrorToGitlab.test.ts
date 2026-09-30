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
  expect(src, `no step named ${name}`).toContain(`- name: ${name}\n`);
  const step = src.slice(src.indexOf(`- name: ${name}\n`));
  return /^\s+if:\s*(.+)$/m.exec(step.slice(0, step.indexOf('run:')))?.[1] ?? '';
};

/** The text of one job, from its id line to the next job's. */
const job = (id: string): string => {
  const src = workflow();
  const start = src.indexOf(`\n  ${id}:\n`);
  expect(start, `no job ${id}`).toBeGreaterThan(-1);
  const next = src.slice(start + 1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
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

  it('runs one mirror job per ref at a time, the full runs in the trunk queue, never cancelling one that runs', () => {
    // Job-level, so a full run that GitHub cancels while it waits still starts the ping job.
    expect(workflow()).not.toMatch(/^concurrency:/m);
    expect(code(job('mirror')).join('\n')).toContain(
      "\n    concurrency:\n" +
        "      group: mirror-to-gitlab-${{ github.event_name == 'push' && github.ref || 'refs/heads/mvp-launch' }}\n" +
        '      cancel-in-progress: false\n',
    );
  });

  it('gives every job a timeout', () => {
    expect(job('mirror')).toMatch(/\n {4}timeout-minutes: \d+\n/);
    expect(job('ping')).toMatch(/\n {4}timeout-minutes: \d+\n/);
  });

  it('hands the script the event, the ref and the deleted flag from GitHub, unchanged', () => {
    const push = job('mirror').slice(job('mirror').indexOf('- name: Push to GitLab'));
    expect(push).toContain('          MIRROR_EVENT: ${{ github.event_name }}\n');
    expect(push).toContain('          MIRROR_REF: ${{ github.ref }}\n');
    expect(push).toContain('          MIRROR_DELETED: ${{ github.event.deleted }}\n');
    expect(stepIf('Push to GitLab'), 'a skipped push step would leave the job green').toBe('');
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
      'HC_PING_URL: ${{ secrets.HC_PING_URL_GITLAB_STANDBY }}',
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

  it('pushes over SSH to the standby that docs/GIT_HOSTING.md names, never the vault', () => {
    const standby = /^STANDBY=https:\/\/gitlab\.com\/([\w.-]+\/[\w.-]+\.git)\s/m.exec(read('docs', 'GIT_HOSTING.md'));
    expect(standby, 'the STANDBY= line of docs/GIT_HOSTING.md').not.toBeNull();
    expect(envValue('MIRROR_URL')).toBe(`git@gitlab.com:${standby![1]}`);
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
  it('is its own job after the mirror job, for the daily and manual runs, whatever the mirror job did', () => {
    // A job, not a step: a mirror job cancelled while it waited in the queue still gets a ping.
    const ping = job('ping');
    expect(ping).toContain('\n    needs: mirror\n');
    expect(ping).toContain("\n    if: ${{ always() && github.event_name != 'push' }}\n");
    expect(ping).toContain('          MIRROR_RESULT: ${{ needs.mirror.result }}\n');
  });

  it('sends success only for a mirror job that succeeded, and keeps the URL off the command line', () => {
    const body = runBodies(job('ping'))[0];
    expect(body).toContain('if [ "$MIRROR_RESULT" = success ]; then suffix=\'\'; else suffix=/fail; fi');
    expect(body).toMatch(/\| curl [^\n]*--config -\n?$/);
    expect(body).not.toMatch(/curl[^\n]*\$HC_PING_URL/);
  });
});

describe('CI proves the pushing on throwaway repos', () => {
  it('runs test-mirror.sh from run-all.sh, which ci.yml runs', () => {
    expect(read('scripts', 'git-hosting', 'test', 'run-all.sh')).toMatch(/for t in [^\n]*\btest-mirror\.sh\b/);
    expect(read('.github', 'workflows', 'ci.yml')).toMatch(/run: bash scripts\/git-hosting\/test\/run-all\.sh\n/);
  });
});
