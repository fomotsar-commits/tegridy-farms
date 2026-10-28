// node --test scripts/ops/heartbeat.test.mjs
// The dead-man pings sent outside scripts/ops/lib/healthchecks.mjs. synthetic-monitor.yml's last
// step runs as GitHub would (bash -eo pipefail) with a fake curl on PATH; the git-vault-backup
// task's runner runs under Windows PowerShell with a fake Invoke-WebRequest. What each sends,
// and what it never prints, is measured rather than read.
import { before, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Stand-ins for what GitHub puts in each env expression. The script gets only the names the
// step declares, so a binding deleted from the workflow fails here as it would on GitHub.
const GITHUB_VALUES = { HC_PING_URL: HC, PROBE_OUTCOME: 'success', REPORT: '', RUN_URL: 'https://github.com/o/r/actions/runs/1' };

/** Run the script with a fake curl that records its argv, its stdin and the body file, and answers. */
function runStep(envOver = {}, { curlExit = 0, answer = 'OK' } = {}) {
  const { script: source, env: declared } = heartbeatStep();
  const stepEnv = {};
  for (const k of Object.keys(declared)) {
    assert.ok(k in GITHUB_VALUES, `the step declares ${k}: give it a stand-in value in GITHUB_VALUES`);
    stepEnv[k] = k in envOver ? envOver[k] : GITHUB_VALUES[k];
  }
  for (const k of Object.keys(envOver)) assert.ok(k in declared, `the test sets ${k}, but the step's env: does not bind it`);
  const inherited = { ...process.env };
  for (const k of Object.keys(GITHUB_VALUES)) delete inherited[k];
  const dir = tmp('run');
  const script = join(dir, 'step.sh');
  writeFileSync(script, source);
  writeFileSync(join(dir, 'curl'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$FAKE_DIR/curl.args"',
    'cat > "$FAKE_DIR/curl.stdin"',
    'for a in "$@"; do case "$a" in @*) cat "${a#@}" > "$FAKE_DIR/curl.body" ;; esac; done',
    // healthchecks.io's answer goes where -o says, as curl writes it: only when the request succeeded.
    `[ ${curlExit} -ne 0 ] || { prev=; for a in "$@"; do [ "$prev" != -o ] || printf '%s' "$FAKE_ANSWER" > "$a"; prev=$a; done; }`,
    `exit ${curlExit}`,
  ].join('\n'), { mode: 0o755 });
  // Git Bash's launcher puts its own curl ahead of the caller's PATH, so the fake goes first
  // from inside bash; the step is then sourced under GitHub's options (-e, pipefail).
  const r = spawnSync(findBash(), ['--noprofile', '--norc', '-eo', 'pipefail', '-c', 'PATH="$(cd "$FAKE_DIR" && pwd):$PATH"; . "$1"', 'step', script], {
    encoding: 'utf8',
    env: { ...inherited, FAKE_DIR: dir, FAKE_ANSWER: answer, RUNNER_TEMP: dir, ...stepEnv },
  });
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, args: read('curl.args'), stdin: read('curl.stdin'), body: read('curl.body') };
}

describe('the heartbeat step in synthetic-monitor.yml', () => {
  test('is the last step, runs after a failure but not a cancel, and binds the secret through env', () => {
    const { step, env, script, isLast } = heartbeatStep();
    assert.ok(isLast, 'the heartbeat must be the final step, so every probe and issue step has run');
    assert.ok(step.some((l) => l.trim() === 'if: ${{ !cancelled() }}'), 'it must run after a failed probe too (the schedule fired either way), and not on a cancel');
    assert.deepEqual(env, {
      HC_PING_URL: '${{ secrets.HC_PING_URL_GITHUB_CRONS }}',
      PROBE_OUTCOME: '${{ steps.probe.outcome }}',
      REPORT: '${{ steps.probe.outputs.report }}',
      RUN_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
    });
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
    assert.ok(!r.out.includes('SECRET-UUID'), 'the ping URL was printed');
    for (const flag of ['--config', '-fsS', '--retry-all-errors']) assert.ok(r.args.split('\n').includes(flag), `curl lacks ${flag}`);
    assert.match(r.body, /^synthetic-monitor: success\nhttps:\/\/github.com\/o\/r\/actions\/runs\/1/);
    assert.match(r.out, /^Heartbeat sent \(probe: success\)\.$/m);
  });

  test('a ping counts as delivered only when healthchecks.io answers exactly "OK"', () => {
    // It answers 200 "OK (not found)" to a URL that names no check, and 200 "OK (rate limited)".
    for (const answer of ['OK (not found)', 'OK (rate limited)', '', 'ok']) {
      const r = runStep({}, { answer });
      assert.ok(r.args, 'the fake curl never ran, so this proves nothing');
      assert.equal(r.code, 0, `'${answer}' made the run red:\n${r.out}`);
      assert.ok(r.out.includes(`::warning title=Heartbeat not delivered::healthchecks.io answered "${answer}"`), `'${answer}':\n${r.out}`);
      assert.doesNotMatch(r.out, /Heartbeat sent/, `'${answer}' counted as delivered`);
    }
    for (const answer of ['OK\n', ' OK\r\n']) {
      const r = runStep({}, { answer });
      assert.match(r.out, /^Heartbeat sent \(probe: success\)\.$/m, JSON.stringify(answer));
      assert.doesNotMatch(r.out, /::warning/, JSON.stringify(answer));
    }
  });

  test('an answer that is not "OK" is printed on one line, without the ping URL', () => {
    // Something between (a captive portal, a proxy) may echo the request back.
    const r = runStep({}, { answer: `<p>\n::error::${HC}\n</p>` });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning title=Heartbeat not delivered::healthchecks.io answered "<p> ::error::<HC_PING_URL_GITHUB_CRONS> <\/p>"/);
    assert.ok(!r.out.includes('SECRET-UUID'), 'the ping URL was printed');
    assert.doesNotMatch(r.out, /^::error::/m, 'a line break in the answer started a workflow command');
  });

  test("every retry fits inside the step's time limit, and the step inside the job's", () => {
    const argv = runStep().args.split('\n');
    const value = (f) => {
      assert.ok(argv.includes(f), `curl lacks ${f}`);
      return Number(argv[argv.indexOf(f) + 1]);
    };
    const tries = value('--retry') + 1;
    const worstSeconds = tries * value('--max-time') + (tries - 1) * value('--retry-delay');
    const stepMinutes = Number(/^\s+timeout-minutes:\s*(\d+)\s*$/m.exec(heartbeatStep().step.join('\n'))?.[1]);
    const jobMinutes = Number(/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(readFileSync(WORKFLOW, 'utf8'))?.[1]);
    assert.ok(tries >= 3, `only ${tries} attempt(s): one lost packet would skip a heartbeat`);
    assert.ok(worstSeconds < stepMinutes * 60, `curl may run ${worstSeconds} s, but the step is killed at ${stepMinutes} min and sends nothing`);
    assert.ok(stepMinutes < jobMinutes, `the step's ${stepMinutes} min limit is not inside the job's ${jobMinutes} min`);
  });

  test('every run pings the base URL, pass or fail, with the outcome and report as the body', () => {
    // A /fail would hold the check DOWN through a probe outage, and a stop in GitHub's
    // schedules during it would then send no email. The prod-incident issue reports the probe.
    for (const outcome of ['success', 'failure', 'skipped', '']) {
      const r = runStep({ PROBE_OUTCOME: outcome, REPORT: '- app shell: HTTP 500' });
      assert.equal(r.code, 0, r.out);
      assert.equal(r.stdin.trim(), `url = "${HC}"`, `outcome '${outcome}'`);
      assert.ok(r.body.startsWith(`synthetic-monitor: ${outcome}\n`), `outcome '${outcome}': ${r.body}`);
      assert.match(r.body, /- app shell: HTTP 500/);
    }
    assert.equal(runStep({ HC_PING_URL: `${HC}/`, PROBE_OUTCOME: 'failure' }).stdin.trim(), `url = "${HC}"`);
  });

  test('a ping that does not land is a warning, not a red run', () => {
    const r = runStep({}, { curlExit: 22 });
    assert.ok(r.args, 'the fake curl never ran, so this proves nothing');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning title=Heartbeat not delivered::/);
    assert.ok(!r.out.includes('SECRET-UUID'), 'the ping URL was printed');
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

describe("the git-vault-backup task's ping (register-backup-task.ps1)", {
  skip: process.platform !== 'win32' && 'the backup task runs only on Windows',
}, () => {
  const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
  let dir;
  before(() => {
    dir = tmp('vault');
    writeFileSync(join(dir, 'ops.env'), `HC_PING_URL_GIT_VAULT_BACKUP=${HC}\n`);
    const r = spawnSync('powershell.exe', [...PS, join(REPO_ROOT, 'scripts', 'git-hosting', 'register-backup-task.ps1'), '-InstallOnly',
      '-InstallDir', join(dir, 'install'), '-EnvFile', join(dir, 'ops.env'), '-Dest', join(dir, 'dest')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The installed backup becomes a stub: one log line, then the exit code the test asks for.
    writeFileSync(join(dir, 'install', 'backup-bundles.sh'), 'echo "stub backup" >> "$BACKUP_LOG"\nexit "${FAKE_CODE:-0}"\n');
    // A function named Invoke-WebRequest wins over the cmdlet in the runner it calls.
    writeFileSync(join(dir, 'with-fake-iwr.ps1'), [
      'function Invoke-WebRequest { param($Uri, $Method, $Body, [switch]$UseBasicParsing, $TimeoutSec)',
      '  Set-Content -LiteralPath (Join-Path $env:FAKE_DIR "iwr.uri") -Value $Uri',
      '  if ($env:FAKE_THROW) { throw "Unable to connect to $Uri" }',
      '  [pscustomobject]@{ StatusCode = 200; Content = [IO.File]::ReadAllText((Join-Path $env:FAKE_DIR "answer.txt")) } }',
      '& $args[0]',
      'exit $LASTEXITCODE',
    ].join('\r\n'));
  });

  /** Run the installed runner once; healthchecks.io's answer is `answer`, the backup exits `code`. */
  function runTask({ answer = 'OK', code = 0, unreachable = false } = {}) {
    const log = join(dir, 'install', 'backup.log');
    rmSync(log, { force: true });
    writeFileSync(join(dir, 'answer.txt'), answer);
    const r = spawnSync('powershell.exe', [...PS, join(dir, 'with-fake-iwr.ps1'), join(dir, 'install', 'run-backup.ps1')], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_DIR: dir, FAKE_CODE: String(code), FAKE_THROW: unreachable ? '1' : '' },
    });
    const text = readFileSync(log, 'utf8');
    assert.match(text, /^stub backup$/m, `the stub backup did not run:\n${r.stdout}${r.stderr}`);
    return { code: r.status, log: text, last: text.trim().split(/\r?\n/).at(-1), uri: readFileSync(join(dir, 'iwr.uri'), 'utf8').trim() };
  }

  test('an answer of "OK" is logged as pinged, success or fail', () => {
    for (const answer of ['OK', 'OK\r\n', ' OK ']) {
      const r = runTask({ answer });
      assert.equal(r.last, 'alarm: pinged (success)', JSON.stringify(answer));
      assert.equal(r.code, 0);
      assert.equal(r.uri, HC);
    }
    const r = runTask({ code: 1 });
    assert.equal(r.last, 'alarm: pinged (fail)');
    assert.equal(r.code, 1, 'the task must keep the backup exit code');
    assert.equal(r.uri, `${HC}/fail`);
  });

  test('any other answer is logged as an alarm with what it said, and the task keeps its exit code', () => {
    // healthchecks.io answers 200 "OK (not found)" to a URL that names no check, and 200 "OK (rate limited)".
    for (const answer of ['OK (not found)', 'OK (rate limited)', '', 'ok']) {
      for (const code of [0, 1]) {
        const r = runTask({ answer, code });
        assert.ok(r.last.startsWith(`alarm: the ping was answered "${answer}", not "OK"`), `'${answer}', exit ${code}: ${r.last}`);
        assert.equal(r.code, code);
      }
    }
  });

  test('the log never holds the ping URL, and an answer stays on one line', () => {
    const echoed = runTask({ answer: `<p>\r\n${HC}/fail\r\n</p>`, code: 1 });
    assert.ok(echoed.last.startsWith('alarm: the ping was answered "<p> <HC_PING_URL_GIT_VAULT_BACKUP>/fail </p>"'), echoed.last);
    const unreachable = runTask({ unreachable: true });
    assert.match(unreachable.last, /^alarm: the ping failed: Unable to connect to <HC_PING_URL_GIT_VAULT_BACKUP>$/);
    for (const r of [echoed, unreachable]) assert.ok(!r.log.includes('SECRET-UUID'), `the ping URL reached the log:\n${r.log}`);
  });
});
