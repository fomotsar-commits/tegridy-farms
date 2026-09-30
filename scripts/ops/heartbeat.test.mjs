// node --test scripts/ops/heartbeat.test.mjs
// synthetic-monitor.yml's last step is the dead-man switch for GitHub's own schedules. This
// runs that step's script as GitHub would (bash -eo pipefail) with a fake curl on PATH, so
// what it sends, and what it never prints, is measured rather than read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'synthetic-monitor.yml');
const STEP = 'Heartbeat to healthchecks.io';
// .invalid never resolves (RFC 2606): if the fake curl were bypassed, nothing is sent.
const HC = 'https://hc-ping.invalid/0b1c2d3e-aaaa-bbbb-cccc-SECRET-UUID';
const tmp = (p) => mkdtempSync(join(tmpdir(), `ops-hb-${p}-`));

function findBash() {
  const tries = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'] : ['bash'];
  for (const b of tries) {
    const r = spawnSync(b, ['-c', 'printf %s "$OPS_BASH_PROBE"'], { encoding: 'utf8', env: { ...process.env, OPS_BASH_PROBE: 'seen' } });
    if (r.status === 0 && r.stdout === 'seen') return b;
  }
  throw new Error('no bash that inherits the environment (Git Bash on Windows)');
}

/** The step's lines, its `env:` map and its dedented `run:` script, read from the workflow. */
function heartbeatStep() {
  const lines = readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === `- name: ${STEP}`);
  assert.ok(at > 0, `synthetic-monitor.yml has no '${STEP}' step`);
  const indent = lines[at].indexOf('-');
  let end = at + 1;
  while (end < lines.length && !(lines[end].trim() && lines[end].search(/\S/) <= indent)) end++;
  const step = lines.slice(at, end);
  const env = {};
  const envAt = step.findIndex((l) => l.trim() === 'env:');
  for (let i = envAt + 1; envAt > 0 && /^\s+[A-Z_]+:\s/.test(step[i] || ''); i++) {
    const [, k, v] = /^\s+([A-Z_]+):\s*(.*)$/.exec(step[i]);
    env[k] = v;
  }
  const runAt = step.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  const body = step.slice(runAt + 1);
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return { step, env, script: body.map((l) => l.slice(pad)).join('\n'), isLast: end === lines.length || lines.slice(end).every((l) => !l.trim()) };
}

/** Run the script with a fake curl that records its argv, its stdin and the body file. */
function runStep(envOver = {}, { curlExit = 0 } = {}) {
  const dir = tmp('run');
  const script = join(dir, 'step.sh');
  writeFileSync(script, heartbeatStep().script);
  writeFileSync(join(dir, 'curl'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$FAKE_DIR/curl.args"',
    'cat > "$FAKE_DIR/curl.stdin"',
    'for a in "$@"; do case "$a" in @*) cat "${a#@}" > "$FAKE_DIR/curl.body" ;; esac; done',
    `exit ${curlExit}`,
  ].join('\n'), { mode: 0o755 });
  // Git Bash's launcher puts its own curl ahead of the caller's PATH, so the fake goes first
  // from inside bash; the step is then sourced under GitHub's options (-e, pipefail).
  const r = spawnSync(findBash(), ['--noprofile', '--norc', '-eo', 'pipefail', '-c', 'PATH="$(cd "$FAKE_DIR" && pwd):$PATH"; . "$1"', 'step', script], {
    encoding: 'utf8',
    env: {
      ...process.env, FAKE_DIR: dir, RUNNER_TEMP: dir,
      PROBE_OUTCOME: 'success', REPORT: '', RUN_URL: 'https://github.com/o/r/actions/runs/1', HC_PING_URL: HC, ...envOver,
    },
  });
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, args: read('curl.args'), stdin: read('curl.stdin'), body: read('curl.body') };
}

describe('the heartbeat step in synthetic-monitor.yml', () => {
  test('is the last step, runs after a failure but not a cancel, and binds the secret through env', () => {
    const { step, env, script, isLast } = heartbeatStep();
    assert.ok(isLast, 'the heartbeat must be the final step, so every probe and issue step has run');
    assert.ok(step.some((l) => l.trim() === 'if: ${{ !cancelled() }}'), 'it must run after a failed probe (to send /fail) and not on a cancel');
    assert.ok(step.some((l) => /^\s+timeout-minutes:\s*\d+\s*$/.test(l)), 'the step needs its own time limit');
    assert.equal(env.HC_PING_URL, '${{ secrets.HC_PING_URL_GITHUB_CRONS }}');
    assert.equal(env.PROBE_OUTCOME, '${{ steps.probe.outcome }}');
    assert.ok(!script.includes('${{'), 'a run: script must not interpolate ${{ }}');
    assert.match(readFileSync(WORKFLOW, 'utf8'), /^\s+id: probe$/m);
  });

  test('with no secret: a warning, exit 0, and no request', () => {
    const r = runStep({ HC_PING_URL: '' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning title=No heartbeat::HC_PING_URL_GITHUB_CRONS is not set/);
    assert.equal(r.args, null, 'curl ran without a URL');
  });

  test('a passing probe pings the base URL, which curl reads on stdin and never sees in argv', () => {
    const r = runStep();
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdin.trim(), `url = "${HC}"`);
    assert.ok(!r.args.includes('hc-ping.invalid'), `the ping URL reached curl's argv:\n${r.args}`);
    assert.ok(!r.out.includes(HC) && !r.out.includes('SECRET-UUID'), 'the ping URL was printed');
    for (const flag of ['--max-time', '--retry', '--config', '-fsS']) assert.ok(r.args.split('\n').includes(flag), `curl lacks ${flag}`);
    assert.match(r.body, /^synthetic-monitor: success\nhttps:\/\/github.com\/o\/r\/actions\/runs\/1/);
  });

  test('anything but a passing probe pings /fail, with the report as the body', () => {
    for (const outcome of ['failure', 'skipped', '']) {
      const r = runStep({ PROBE_OUTCOME: outcome, REPORT: '- app shell: HTTP 500' });
      assert.equal(r.code, 0, r.out);
      assert.equal(r.stdin.trim(), `url = "${HC}/fail"`, `outcome '${outcome}'`);
      assert.match(r.body, /- app shell: HTTP 500/);
    }
    assert.equal(runStep({ HC_PING_URL: `${HC}/`, PROBE_OUTCOME: 'failure' }).stdin.trim(), `url = "${HC}/fail"`);
  });

  test('a ping that does not land is a warning, not a red run', () => {
    const r = runStep({}, { curlExit: 22 });
    assert.ok(r.args, 'the fake curl never ran, so this proves nothing');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning title=Heartbeat not delivered::/);
    assert.ok(!r.out.includes(HC));
  });

  test('a secret that is not a plain https URL sends nothing and is never printed', () => {
    for (const bad of ['http://hc-ping.invalid/abc', 'hc-ping.invalid/abc', 'https://', 'https://hc-ping.invalid/a"b', 'https://hc-ping.invalid/a b', 'https://hc-ping.invalid/a\\b']) {
      const r = runStep({ HC_PING_URL: bad });
      assert.equal(r.code, 0, `${bad}: ${r.out}`);
      assert.match(r.out, /is set but is not a plain https URL/, bad);
      assert.equal(r.args, null, `${bad}: curl ran`);
      assert.ok(!r.out.includes(bad), `${bad} was printed`);
    }
  });
});
