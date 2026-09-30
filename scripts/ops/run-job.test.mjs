// node --test scripts/ops/run-job.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './lib/env-file.mjs';
import { runBackup, writeCanary } from './lib/backup.mjs';
import { GPG_TIMEOUT_MS } from './lib/gpg.mjs';
import { defaultPullDir, MAX_RENAMES, pullGithubBackups, RENAME_RETRY_MS, STALE_DAYS } from './lib/github-backups.mjs';
import { clampBody, PING_WORST_MS, pingEnvName, resolvePingUrl, scrubSecrets, sendPing } from './lib/healthchecks.mjs';
import { childEnv, defaultPaths, JOB_IMPLS, JOBS, NPM_PROJECTS } from './lib/jobs.mjs';
import { parseGithubOutput, runProcess } from './lib/proc.mjs';
import { EVM_BALANCES, EVM_CALLS, REQUEST_TIMEOUT_MS as RAILS_TIMEOUT_MS, readRails, SQUADS_VAULT } from './lib/revenue-rails.mjs';
import { DUMP_DEADLINE_MS } from './lib/supabase-dump.mjs';
import { ALIASES, CANONICAL, DEFAULT_INDEXER, FOREIGN, REQUEST_TIMEOUT_MS as SYNTHETIC_TIMEOUT_MS, runSynthetic } from './lib/synthetic.mjs';
import { runJob } from './run-job.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HC = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';
const tmp = (p) => mkdtempSync(join(tmpdir(), `ops-${p}-`));
const noSleep = async () => {};
const workflow = (name) => {
  const p = join(REPO_ROOT, '.github', 'workflows', name);
  assert.ok(existsSync(p), `${name} is gone: re-home this parity pin to wherever the job now lives, or drop it on purpose`);
  return readFileSync(p, 'utf8');
};

/** A fetch that records every call and answers pings with `pingStatus`. */
function pingFetch({ pingStatus = 200, calls = [] } = {}) {
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body, method: init.method });
    return new Response('OK', { status: pingStatus });
  };
  return { impl, calls };
}
const quiet = () => { const lines = []; return { lines, log: (s) => lines.push(String(s)) }; };
const fakeJob = (result) => ({ 'synthetic-monitor': async () => result });

describe('the runner and its alarm', () => {
  test('with no ping URL the job still runs, a loud warning names the variable, and the exit code is the verdict', async () => {
    let ran = 0;
    const out = quiet();
    const err = quiet();
    const { impl, calls } = pingFetch();
    const code = await runJob('synthetic-monitor', {
      env: {}, fetchImpl: impl, stateDir: tmp('st'), log: out.log, warn: err.log,
      jobs: { 'synthetic-monitor': async () => { ran++; return { ok: false, summary: 'down', report: 'r' }; } },
    });
    assert.equal(ran, 1);
    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.match(err.lines.join('\n'), /HC_PING_URL_SYNTHETIC_MONITOR is not set, so this run reaches NO alarm/);
  });

  test('pings /start before the job, then the base URL with the report on success', async () => {
    const { impl, calls } = pingFetch();
    let seenAtRun = -1;
    const code = await runJob('synthetic-monitor', {
      env: { HC_PING_URL_SYNTHETIC_MONITOR: `${HC}/` }, fetchImpl: impl, stateDir: tmp('st'), log: () => {}, warn: () => {},
      jobs: { 'synthetic-monitor': async () => { seenAtRun = calls.length; return { ok: true, summary: 'fine', report: 'all good' }; } },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls.map((c) => c.url), [`${HC}/start`, HC]);
    assert.equal(seenAtRun, 1, 'the start ping was not sent before the job ran');
    assert.match(calls[1].body, /\[synthetic-monitor\] OK: fine[\s\S]*all good/);
  });

  test('a failed job pings /fail with the report as the body, and writes the last-run file', async () => {
    const { impl, calls } = pingFetch();
    const st = tmp('st');
    const code = await runJob('synthetic-monitor', {
      env: { HC_PING_URL_SYNTHETIC_MONITOR: HC }, fetchImpl: impl, stateDir: st, log: () => {}, warn: () => {},
      jobs: fakeJob({ ok: false, summary: '2 probe(s) failing', report: '- app shell: HTTP 500' }),
    });
    assert.equal(code, 1);
    assert.equal(calls[1].url, `${HC}/fail`);
    assert.match(calls[1].body, /FAIL: 2 probe\(s\) failing[\s\S]*app shell: HTTP 500/);
    assert.match(readFileSync(join(st, 'synthetic-monitor.last.txt'), 'utf8'), /app shell: HTTP 500/);
  });

  test('a crashing job is a failure with the crash in the body', async () => {
    const { impl, calls } = pingFetch();
    const code = await runJob('synthetic-monitor', {
      env: { HC_PING_URL_SYNTHETIC_MONITOR: HC }, fetchImpl: impl, stateDir: tmp('st'), log: () => {}, warn: () => {},
      jobs: { 'synthetic-monitor': async () => { throw new Error('kaboom'); } },
    });
    assert.equal(code, 1);
    assert.equal(calls[1].url, `${HC}/fail`);
    assert.match(calls[1].body, /the job crashed: kaboom/);
  });

  test('no secret and no ping URL reaches the output, the body or the last-run file', async () => {
    const env = {
      HC_PING_URL_SYNTHETIC_MONITOR: HC, SUPABASE_SERVICE_KEY: 'eyJsecret-service-key-value',
      ETH_RPC_URL: 'https://eth.example/v2/apikey123456', SUPABASE_URL: 'https://projref123456.supabase.co',
    };
    const { impl, calls } = pingFetch();
    const out = quiet();
    const err = quiet();
    const st = tmp('st');
    await runJob('synthetic-monitor', {
      env, fetchImpl: impl, stateDir: st, log: out.log, warn: err.log,
      jobs: fakeJob({ ok: false, summary: 'x', report: `leak ${env.SUPABASE_SERVICE_KEY} via ${env.ETH_RPC_URL} and ${HC} at ${env.SUPABASE_URL}` }),
    });
    const everything = [...out.lines, ...err.lines, calls[1].body, readFileSync(join(st, 'synthetic-monitor.last.txt'), 'utf8')].join('\n');
    for (const v of Object.values(env)) assert.ok(!everything.includes(v), `leaked: ${v}`);
    assert.match(calls[1].body, /<SUPABASE_SERVICE_KEY>.*<ETH_RPC_URL>.*<HC_PING_URL_SYNTHETIC_MONITOR>.*<SUPABASE_URL>/);
  });

  test('a start ping that fails makes a passing run exit 3, even when the result ping gets through', async () => {
    const calls = [];
    const impl = async (url) => { calls.push(String(url)); return new Response('', { status: String(url).endsWith('/start') ? 503 : 200 }); };
    const code = await runJob('synthetic-monitor', {
      env: { HC_PING_URL_SYNTHETIC_MONITOR: HC }, fetchImpl: impl, stateDir: tmp('st'), log: () => {}, warn: () => {}, sleep: noSleep,
      jobs: fakeJob({ ok: true, summary: 'ok', report: '' }),
    });
    assert.equal(code, 3);
    assert.deepEqual(calls, [`${HC}/start`, `${HC}/start`, `${HC}/start`, HC]);
  });

  test('a ping URL that is set but unusable told nobody, so a change is not recorded as told', async () => {
    const run = async (env) => {
      let committed = false;
      const code = await runJob('revenue-watch', {
        env, fetchImpl: pingFetch().impl, stateDir: tmp('st'), log: () => {}, warn: () => {},
        jobs: { 'revenue-watch': async () => ({ ok: false, summary: 'CHANGED', report: 'r', commit: () => { committed = true; } }) },
      });
      return { code, committed };
    };
    for (const url of ['http://hc-ping.com/abc', 'hc-ping.com/abc']) {
      assert.deepEqual(await run({ HC_PING_URL_REVENUE_WATCH: url }), { code: 1, committed: false }, url);
    }
    // With no alarm configured at all there is nobody to wait for, so the change is recorded.
    assert.deepEqual(await run({}), { code: 1, committed: true });
  });

  test('an undelivered ping retries 3 times and exits 3 when the job passed; a bad URL exits 3 without sending', async () => {
    const { impl, calls } = pingFetch({ pingStatus: 503 });
    const err = quiet();
    const code = await runJob('synthetic-monitor', {
      env: { HC_PING_URL_SYNTHETIC_MONITOR: HC }, fetchImpl: impl, stateDir: tmp('st'), log: () => {}, warn: err.log, sleep: noSleep,
      jobs: fakeJob({ ok: true, summary: 'ok', report: '' }),
    });
    assert.equal(code, 3);
    assert.equal(calls.length, 6);
    assert.match(err.lines.join('\n'), /NOT delivered/);
    assert.ok(!err.lines.join('\n').includes(HC));
    const bad = pingFetch();
    const code2 = await runJob('synthetic-monitor', {
      env: { HC_PING_URL_SYNTHETIC_MONITOR: 'http://hc-ping.com/abc' }, fetchImpl: bad.impl, stateDir: tmp('st'), log: () => {}, warn: () => {},
      jobs: fakeJob({ ok: true, summary: 'ok', report: '' }),
    });
    assert.equal(code2, 3);
    assert.equal(bad.calls.length, 0);
  });

  test('backup-pull pings HC_PING_URL_BACKUP_PULL, and a stale backup pings /fail with the reason', async () => {
    const { impl, calls } = pingFetch();
    const seen = [];
    const code = await runJob('backup-pull', {
      env: { HC_PING_URL_BACKUP_PULL: HC, BACKUP_PULL_DIR: tmp('pulldir') }, fetchImpl: impl, stateDir: tmp('st'), log: () => {}, warn: () => {},
      jobs: JOB_IMPLS,
      context: {
        run: async () => ({ code: 0, stdout: '[]', stderr: '', timedOut: false, error: null }),
        pullGithubBackups: async (args) => { seen.push(args); return { ok: false, summary: 'STALE: the weekly GitHub backup has stopped', lines: ['x'] }; },
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(calls.map((c) => c.url), [`${HC}/start`, `${HC}/fail`]);
    assert.match(calls[1].body, /\[backup-pull\] FAIL: STALE/);
    assert.equal(typeof seen[0].run, 'function', 'the job must hand the pull its process runner');
    assert.ok(seen[0].env.BACKUP_PULL_DIR, 'the job must hand the pull its env');
  });

  test('the pulled backups go to OneDrive by default, or to BACKUP_PULL_DIR', () => {
    assert.equal(defaultPullDir({}), join(homedir(), 'OneDrive', 'backups', 'supabase-github'));
    assert.equal(defaultPullDir({ BACKUP_PULL_DIR: 'D:\\x' }), 'D:\\x');
  });

  test('an unknown job is a usage error', async () => {
    assert.equal(await runJob('nope', { warn: () => {} }), 2);
  });

  test('ping helpers', async () => {
    assert.equal(pingEnvName('npm-advisories'), 'HC_PING_URL_NPM_ADVISORIES');
    assert.deepEqual(resolvePingUrl({}, 'x'), { name: 'HC_PING_URL_X', url: null, problem: 'unset' });
    assert.equal(resolvePingUrl({ HC_PING_URL_X: 'nonsense' }, 'x').problem, 'not a URL');
    assert.equal(scrubSecrets('a short1 b', { MY_KEY: 'short1' }), 'a short1 b', 'values under 8 chars are left alone');
    const big = clampBody('x'.repeat(20000), 10000);
    assert.ok(Buffer.byteLength(big) <= 10000 && /\[cut: \d+ more bytes/.test(big));
    let n = 0;
    const r = await sendPing({ url: HC, kind: 'fail', fetchImpl: async () => { n++; throw new TypeError('fetch failed'); }, sleep: noSleep });
    assert.equal(r.ok, false);
    assert.equal(n, 3);
  });
});

describe('--probe scripts are read through a file the runner owns', () => {
  const stubDir = tmp('stubs');
  const stub = (name, body) => { const p = join(stubDir, name); writeFileSync(p, body); return p; };
  const writeOut = (lines) => `import { appendFileSync } from 'node:fs';\nif (!process.argv.includes('--probe')) process.exit(9);\nappendFileSync(process.env.GITHUB_OUTPUT, ${JSON.stringify(lines)} + '\\n');\n`;
  const passTests = stub('pass.test.mjs', "import { test } from 'node:test';\ntest('ok', () => {});\n");
  const failTests = stub('fail.test.mjs', "import { test } from 'node:test';\ntest('bad', () => { throw new Error('x'); });\n");
  const ctxFor = (consumer, tests = [passTests]) => ({ paths: { ...defaultPaths(REPO_ROOT), arbConsumer: consumer, arbTests: tests } });
  const arb = (consumer, tests) => JOB_IMPLS['arb-linkage-monitor']({ env: { PATH: process.env.PATH }, repoRoot: REPO_ROOT, run: runProcess, ...ctxFor(consumer, tests) });
  const block = (status, fp = 'f1') => `arb_status=${status}\narb_summary=arb linkage ${status} at 9x\narb_fingerprint=${fp}\narb_report<<EOF_x\nplan for ${status}\nEOF_x`;

  test('GO and WARN pass; HALT and ERROR fail with the prepared plan in the report', async () => {
    for (const [status, ok] of [['GO', true], ['WARN', true], ['HALT', false], ['ERROR', false]]) {
      const r = await arb(stub(`c-${status}.mjs`, writeOut(block(status))));
      assert.equal(r.ok, ok, `${status}: ${r.report}`);
      assert.match(r.report, new RegExp(`Arb linkage: ${status}[\\s\\S]*plan for ${status}`));
    }
  });

  test('a script that prints its verdict to stdout instead of the file FAILS: off GitHub that is the silent no-op', async () => {
    const r = await arb(stub('stdout-only.mjs', `console.log(${JSON.stringify(block('GO'))});\n`));
    assert.equal(r.ok, false);
    assert.match(r.report, /wrote no verdict/);
  });

  test('a crash before any output fails, and so does an unknown status', async () => {
    assert.equal((await arb(stub('crash.mjs', 'throw new Error("import broke");\n'))).ok, false);
    assert.equal((await arb(stub('weird.mjs', writeOut('arb_status=MAYBE')))).ok, false);
  });

  test('a GO followed by a non-zero exit fails: --probe exits 0 whenever it finishes', async () => {
    const r = await arb(stub('go-then-die.mjs', `${writeOut(block('GO'))}process.exit(1);\n`));
    assert.equal(r.ok, false);
    assert.match(r.report, /did not finish cleanly \(exit 1\)/);
  });

  test('a GO from a rule that fails its own tests fails', async () => {
    const r = await arb(stub('go.mjs', writeOut(block('GO'))), [failTests]);
    assert.equal(r.ok, false);
    assert.match(r.report, /failed its own tests/);
  });

  test('the child gets no secrets, no ping URLs, and RPC from ETH_RPC_URL as the workflow did', async () => {
    const dump = stub('env.mjs', "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GITHUB_OUTPUT, 'arb_status=GO\\narb_report<<E\\n' + JSON.stringify(process.env) + '\\nE\\n');\n");
    const r = await JOB_IMPLS['arb-linkage-monitor']({
      env: { PATH: process.env.PATH, ETH_RPC_URL: 'https://rpc.example', SUPABASE_SERVICE_KEY: 's3cret-key', BACKUP_PASSPHRASE: 'pw-pw-pw', HC_PING_URL_X: HC, GITHUB_STEP_SUMMARY: 'x' },
      repoRoot: REPO_ROOT, run: runProcess, ...ctxFor(dump),
    });
    const seen = JSON.parse(r.report.split('\n').find((l) => l.startsWith('{')));
    assert.equal(seen.RPC, 'https://rpc.example');
    for (const k of ['SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE', 'HC_PING_URL_X', 'GITHUB_STEP_SUMMARY']) assert.equal(seen[k], undefined, k);
    assert.ok(seen.GITHUB_OUTPUT && !seen.GITHUB_OUTPUT.startsWith(REPO_ROOT), 'the output file must be a temp file outside the repo');
  });

  test('parseGithubOutput reads key=value and heredoc blocks, last write wins, and drops an unclosed block', () => {
    assert.deepEqual(parseGithubOutput('a=1\nb<<D\nx\ny\nD\na=2\nc<<Z\nnever closed'), { a: '2', b: 'x\ny' });
    // Text inside an unclosed block (RPC-supplied, say) must not become a key.
    assert.deepEqual(parseGithubOutput('arb_status=HALT\narb_report<<D\nrpc said:\narb_status=GO'), { arb_status: 'HALT' });
  });

  test('the real consumer and caller-credit scripts still write the keys this runner reads', () => {
    for (const [file, keys] of [
      ['scripts/monitoring/lib/pausePlan.mjs', ['arb_status=', 'arb_summary=', 'arb_report<<']],
      ['scripts/lib/caller-credit.mjs', ['stranded_state=', 'stranded_fingerprint=', 'stranded<<']],
    ]) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const k of keys) assert.ok(src.includes(k), `${file} no longer writes ${k}`);
    }
  });
});

describe('revenue-watch', () => {
  const stubDir = tmp('rev');
  const credit = (state, fp = 'cafe') => {
    const p = join(stubDir, `credit-${state}-${fp}.mjs`);
    writeFileSync(p, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GITHUB_OUTPUT, ${JSON.stringify(`stranded_state=${state}\nstranded_fingerprint=${fp}\nstranded<<E\n${state} report\nE`)} + '\\n');\n`);
    return p;
  };
  const rails = (over = {}) => async () => ({ earned: ['- **SwapFeeRouter.totalETHFees()**: `0x2ba7def3000`'], unknown: [], unconfigured: [], state: 'earned', ...over });
  const job = (creditScript, readRailsImpl, stateDir) => JOB_IMPLS['revenue-watch']({
    env: { PATH: process.env.PATH }, repoRoot: REPO_ROOT, run: runProcess, stateDir, readRails: readRailsImpl,
    paths: { ...defaultPaths(REPO_ROOT), callerCredit: creditScript },
  });

  test('alerts once on a new picture, records it only when told to, then stays quiet until it changes', async () => {
    const st = tmp('revst');
    const first = await job(credit('stranded'), rails(), st);
    assert.equal(first.ok, false);
    assert.match(first.summary, /FIRST READING/);
    assert.equal(existsSync(join(st, 'revenue-watch.fingerprint')), false, 'recorded before anyone was told');
    await first.commit();
    const again = await job(credit('stranded'), rails(), st);
    assert.equal(again.ok, true, again.report);
    const moved = await job(credit('stranded', 'beef'), rails(), st);
    assert.equal(moved.ok, false);
    assert.match(moved.summary, /CHANGED/);
  });

  test('an unreadable rail fails even while another rail reads earned (the workflow let "earned" mask it)', async () => {
    const r = await job(credit('clear'), rails({ unknown: ['- RevenueDistributor ETH balance: RPC request failed'] }), tmp('revst'));
    assert.equal(r.ok, false);
    assert.match(r.summary, /BLIND/);
    assert.match(r.report, /RPC request failed/);
  });

  test('an unread or missing callerCredit verdict is blind, never clear', async () => {
    assert.match((await job(credit('unknown'), rails(), tmp('a'))).summary, /BLIND/);
    const silent = join(stubDir, 'silent.mjs');
    writeFileSync(silent, 'process.exit(0);\n');
    const r = await job(silent, rails(), tmp('b'));
    assert.match(r.summary, /BLIND/);
    assert.match(r.report, /wrote no verdict/);
  });

  test('the runner records the change only after the fail ping is delivered', async () => {
    const st = tmp('revrun');
    const jobs = { 'revenue-watch': (ctx) => JOB_IMPLS['revenue-watch']({ ...ctx, readRails: rails(), paths: { ...ctx.paths, callerCredit: credit('stranded') } }) };
    const down = pingFetch({ pingStatus: 500 });
    assert.equal(await runJob('revenue-watch', { env: { PATH: process.env.PATH, HC_PING_URL_REVENUE_WATCH: HC }, fetchImpl: down.impl, stateDir: st, jobs, log: () => {}, warn: () => {}, sleep: noSleep }), 1);
    assert.equal(existsSync(join(st, 'revenue-watch.fingerprint')), false);
    const up = pingFetch();
    assert.equal(await runJob('revenue-watch', { env: { PATH: process.env.PATH, HC_PING_URL_REVENUE_WATCH: HC }, fetchImpl: up.impl, stateDir: st, jobs, log: () => {}, warn: () => {} }), 1);
    assert.equal(up.calls.at(-1).url, `${HC}/fail`);
    assert.equal(existsSync(join(st, 'revenue-watch.fingerprint')), true);
    assert.equal(await runJob('revenue-watch', { env: { PATH: process.env.PATH, HC_PING_URL_REVENUE_WATCH: HC }, fetchImpl: up.impl, stateDir: st, jobs, log: () => {}, warn: () => {} }), 0);
  });

  test('readRails: zero is zero, a JSON-RPC error is unknown, never zero, and garbage is not revenue', async () => {
    const answer = (fn) => async (url, init) => new Response(JSON.stringify(fn(JSON.parse(init.body), url)));
    const zero = await readRails({ fetchImpl: answer((b) => (b.method === 'getTokenAccountsByOwner' ? { result: { value: [] } } : { result: `0x${'0'.repeat(64)}` })), env: {} });
    assert.deepEqual([zero.state, zero.earned, zero.unknown], ['zero', [], []]);
    assert.equal(zero.unconfigured.length, 1);
    const err = await readRails({ fetchImpl: answer(() => ({ error: { code: -32000, message: 'rate limited' } })), env: {} });
    assert.equal(err.state, 'partial');
    assert.equal(err.unknown.length, 5);
    const junk = await readRails({ fetchImpl: answer((b) => (b.method === 'getTokenAccountsByOwner' ? { result: { value: [] } } : { result: 'not hex' })), env: {} });
    assert.deepEqual(junk.earned, []);
    assert.equal(junk.unknown.length, 4);
    const spl = await readRails({ fetchImpl: answer((b) => (b.method === 'getTokenAccountsByOwner'
      ? { result: { value: [{ account: { data: { parsed: { info: { mint: 'MintA', tokenAmount: { amount: '5', uiAmountString: '0.5' } } } } } }, { account: { data: { parsed: { info: { mint: 'MintB', tokenAmount: { amount: '0', uiAmountString: '0' } } } } } }] } }
      : { result: '0x0' })), env: { SOLANA_FEE_ACCOUNT: 'FeeWallet111' } });
    assert.deepEqual(spl.earned, ['- **Squads partner vault** (SPL): MintA:0.5', '- **Solana swap-fee wallet** (SPL): MintA:0.5']);
  });

  test('reads the same rails, addresses and selectors as revenue-watch.yml', () => {
    const wf = workflow('revenue-watch.yml');
    for (const c of EVM_CALLS) assert.ok(wf.includes(`eth_call "${c.name}"`) && new RegExp(`${c.to}\\s+${c.data}`).test(wf), c.name);
    for (const b of EVM_BALANCES) assert.ok(new RegExp(`eth_balance "${b.name.replace(/[()]/g, '\\$&')}"\\s+${b.address}`).test(wf), b.name);
    assert.ok(wf.includes(`sol_tokens "Squads partner vault" "${SQUADS_VAULT}"`));
  });
});

describe('synthetic-monitor', () => {
  const OK_BODIES = {
    [`https://${CANONICAL}/`]: '<script src="/assets/index-abc.js">',
    alchemy: '{"floorPrice":1.2}',
    'action=query': '{"orders":[],"count":0}',
    'trade-query': '{"trades":[],"count":0}',
  };
  function site(over = {}) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, redirect: init?.redirect });
      if (over[url]) return over[url]();
      const u = new URL(url);
      if (ALIASES.includes(u.host)) return new Response(null, { status: 308, headers: { Location: `https://${CANONICAL}/` } });
      if (u.host === FOREIGN) return new Response('<html>Island Lab</html>', { status: 200 });
      if (url === `${DEFAULT_INDEXER}/ready`) return new Response('', { status: 200 });
      const APP = `https://${CANONICAL}/`;
      const key = url === APP ? APP : Object.keys(OK_BODIES).find((k) => k !== APP && url.includes(k));
      return new Response(OK_BODIES[key] ?? 'not found', { status: key ? 200 : 404 });
    };
    return { impl, calls };
  }
  const run = (over) => { const s = site(over); return runSynthetic({ fetchImpl: s.impl, env: {} }).then((r) => ({ ...r, calls: s.calls })); };

  test('a healthy site passes, and no request ever follows a redirect', async () => {
    const r = await run();
    assert.equal(r.ok, true, r.report);
    assert.ok(r.calls.every((c) => c.redirect === 'manual'));
    assert.ok(r.calls.some((c) => c.url === `${DEFAULT_INDEXER}/ready`), 'the indexer was not probed');
  });

  for (const [label, url, response, want] of [
    ['a 500 app shell', `https://${CANONICAL}/`, () => new Response('err', { status: 500 }), /app shell: HTTP 500/],
    ['an app shell without hashed assets', `https://${CANONICAL}/`, () => new Response('<html>stale</html>'), /expected content missing \(\/assets\/\)/],
    ['a syncing indexer', `${DEFAULT_INDEXER}/ready`, () => new Response('', { status: 503 }), /indexer \/ready: HTTP 503/],
    ['an unreachable indexer', `${DEFAULT_INDEXER}/ready`, () => { throw new TypeError('fetch failed'); }, /indexer \/ready: request failed/],
    ['a temporary alias redirect', 'https://www.memetics.finance/', () => new Response(null, { status: 302, headers: { Location: `https://${CANONICAL}/` } }), /expected a permanent redirect \(301 or 308\).*got 302/],
    ['an alias serving the app itself', 'https://tegridyfarms.vercel.app/', () => new Response('<script src="/assets/x.js">'), /got 200/],
    ['an alias redirecting elsewhere', 'https://www.memetics.finance/', () => new Response(null, { status: 308, headers: { Location: 'https://evil.example/' } }), /not the canonical host/],
    ['the foreign host serving our shell', `https://${FOREIGN}/`, () => new Response('<script src="/assets/x.js">'), /THIS VENUE is answering/],
  ]) {
    test(`${label} fails`, async () => {
      const r = await run({ [url]: response });
      assert.equal(r.ok, false);
      assert.match(r.report, want);
    });
  }

  test('a relative Location onto the canonical host passes; a foreign 308 is inconclusive, not a failure', async () => {
    const r = await run({
      'https://www.memetics.finance/': () => new Response(null, { status: 308, headers: { Location: `https://${CANONICAL}/x` } }),
      [`https://${FOREIGN}/`]: () => new Response(null, { status: 308, headers: { Location: 'https://elsewhere/' } }),
    });
    assert.equal(r.ok, true, r.report);
    assert.match(r.report, /memetic\.fun answered 308, so the "not us" check is inconclusive/);
  });

  test('degraded:true passes (as in the workflow) but is said out loud', async () => {
    const r = await run({ [`https://${CANONICAL}/api/orderbook?action=query&contract=0xd774557b647330C91Bf44cfEAB205095f7E6c367&limit=1`]: () => new Response('{"orders":[],"count":0,"degraded":true}') });
    assert.equal(r.ok, true);
    assert.match(r.report, /warn: orderbook answered degraded:true/);
  });

  test('requests every URL synthetic-monitor.yml probes, and the same alias and foreign hosts', async () => {
    const wf = workflow('synthetic-monitor.yml');
    const urls = [...wf.matchAll(/^\s*probe "[^"]+" "([^"]+)" "[^"]*"/gm)].map((m) => m[1].replace('$BASE', `https://${CANONICAL}`).replace('$CANONICAL', CANONICAL));
    assert.ok(urls.length >= 5, 'found too few probe lines in the workflow');
    const r = await run();
    for (const u of urls) assert.ok(r.calls.some((c) => c.url === u), `not probed: ${u}`);
    assert.deepEqual(/ALIASES="([^"]+)"/.exec(wf)[1].split(' '), ALIASES);
    assert.equal(/FOREIGN="([^"]+)"/.exec(wf)[1], FOREIGN);
  });
});

describe('registry-onchain', () => {
  const GOOD = { offline: 'ok', onchain: '── live chain state ──\n  x ok\n\n  chain read: 112 considered, 0 NOT CHECKED (the RPC did not answer)\n', ladders: 'LADDER BUILDS SHIPPED BY THE REGISTRY\n 6 fixed' };
  const repoWithViem = () => { const r = tmp('reg'); mkdirSync(join(r, 'frontend', 'node_modules', 'viem'), { recursive: true }); return r; };
  const fakeRun = (o) => async (_cmd, args) => {
    const s = args.join(' ');
    const [out, code] = s.includes('--onchain') ? [o.onchain, o.onchainCode ?? 0] : s.includes('verify-ladder') ? [o.ladders, o.laddersCode ?? 0] : [o.offline, o.offlineCode ?? 0];
    return { code, stdout: out, stderr: '', timedOut: false, error: null };
  };
  const job = (o, root = repoWithViem()) => JOB_IMPLS['registry-onchain']({ env: {}, repoRoot: root, run: fakeRun({ ...GOOD, ...o }), paths: defaultPaths(root) });

  test('passes on a full read; a partial skip passes with a warning', async () => {
    assert.equal((await job({})).ok, true);
    const partial = await job({ onchain: GOOD.onchain.replace('0 NOT CHECKED', '5 NOT CHECKED') });
    assert.equal(partial.ok, true);
    assert.match(partial.report, /warn: 5 of 112 addresses were NOT CHECKED/);
  });

  for (const [label, o, want] of [
    ['every address skipped', { onchain: GOOD.onchain.replace('0 NOT CHECKED', '112 NOT CHECKED') }, /verified NOTHING/],
    ['no chain section', { onchain: 'chain read: 1 considered, 0 NOT CHECKED' }, /no chain section/],
    ['no coverage line', { onchain: '── live chain state ──' }, /no 'chain read/],
    ['no ladder table', { ladders: 'hmm' }, /no ladder table/],
    ['a failing chain read', { onchainCode: 1 }, /registry vs live chain failed/],
    ['a failing offline check', { offlineCode: 1 }, /registry structure \(offline\) failed/],
  ]) {
    test(`fails on ${label}`, async () => {
      const r = await job(o);
      assert.equal(r.ok, false);
      assert.match(r.report, want);
    });
  }

  test('fails, and says how to fix it, when frontend/node_modules is missing', async () => {
    const r = await job({}, tmp('bare'));
    assert.equal(r.ok, false);
    assert.match(r.report, /npm ci --ignore-scripts/);
  });
});

describe('npm-advisories', () => {
  test('audits every directory with its own package-lock.json, and the same set as the workflow matrix', () => {
    const locked = readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .filter((d) => existsSync(join(REPO_ROOT, d.name, 'package-lock.json')))
      .map((d) => d.name);
    if (existsSync(join(REPO_ROOT, 'package-lock.json'))) locked.push('.');
    assert.deepEqual([...NPM_PROJECTS].sort(), locked.sort());
    const m = /project:\s*\[([^\]]+)\]/.exec(workflow('npm-advisories.yml'));
    assert.deepEqual([...NPM_PROJECTS], m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')));
  });

  // An `npm audit --json` report holding one high advisory per GHSA id.
  const audit = (ids) => JSON.stringify({
    vulnerabilities: Object.fromEntries(ids.map((g) => [`pkg-${g}`, {
      name: `pkg-${g}`, fixAvailable: true, via: [{ url: `https://github.com/advisories/${g}`, severity: 'high', name: `pkg-${g}`, title: 't' }],
    }])),
    metadata: { vulnerabilities: { total: ids.length } },
  });
  const projectOf = (cwd) => (cwd.endsWith('frontend') ? 'frontend' : cwd.endsWith('indexer') ? 'indexer' : '.');
  /** Run the job with the real gate; `found` maps a project to its advisory ids (or raw stdout). */
  const npmRun = (found, stateDir, allowlist = { accepted: [], baseline: { expires: '2099-01-01', projects: {} } }) => {
    const dir = tmp('allow');
    writeFileSync(join(dir, 'allowlist.json'), JSON.stringify(allowlist));
    const run = async (_cmd, _args, opts) => {
      const f = found[projectOf(opts.cwd)] ?? [];
      return { code: 1, stdout: typeof f === 'string' ? f : audit(f), stderr: '', timedOut: false, error: null };
    };
    return JOB_IMPLS['npm-advisories']({
      env: {}, repoRoot: REPO_ROOT, run, stateDir, paths: { ...defaultPaths(REPO_ROOT), npmAllowlist: join(dir, 'allowlist.json') },
      npmCommand: () => ({ cmd: 'npm', args: ['audit', '--json'], shell: false }),
    });
  };
  const A = 'GHSA-aaaa-aaaa-aaaa';
  const B = 'GHSA-bbbb-bbbb-bbbb';

  test('a new blocking advisory fails once; later runs list it and pass, so the next new one still alerts', async () => {
    const st = tmp('npmst');
    const first = await npmRun({ frontend: [A] }, st);
    assert.equal(first.ok, false);
    assert.match(first.summary, new RegExp(`NEW blocking advisories: frontend ${A}`));
    await first.commit();
    const again = await npmRun({ frontend: [A] }, st);
    assert.equal(again.ok, true, again.report);
    assert.match(again.summary, /1 known blocking advisories/);
    assert.match(again.report, new RegExp(`- frontend ${A}`));
    const more = await npmRun({ frontend: [A], indexer: [B] }, st);
    assert.equal(more.ok, false);
    assert.match(more.summary, new RegExp(`NEW blocking advisories: indexer ${B}\\.`));
  });

  test('a fixed advisory is forgotten, so its return alerts again', async () => {
    const st = tmp('npmst');
    await (await npmRun({ frontend: [A] }, st)).commit();
    const fixed = await npmRun({}, st);
    assert.equal(fixed.ok, true);
    await fixed.commit();
    assert.equal((await npmRun({ frontend: [A] }, st)).ok, false);
  });

  test('an unusable audit fails every run and records nothing', async () => {
    const st = tmp('npmst');
    const empty = await npmRun({ indexer: '' }, st);
    assert.equal(empty.ok, false);
    assert.match(empty.report, /indexer: npm audit produced no output at all/);
    assert.equal(empty.commit, undefined);
    const shapeless = await npmRun({ frontend: '{}' }, st);
    assert.equal(shapeless.ok, false);
    assert.match(shapeless.summary, /frontend: the audit cannot be trusted/);
  });

  test('the allowlist still decides what blocks', async () => {
    const accepted = { accepted: [{ ghsa: A, reason: 'reviewed: not reachable from our code', expires: '2099-01-01' }], baseline: { expires: '2099-01-01', projects: {} } };
    const r = await npmRun({ frontend: [A] }, tmp('npmst'), accepted);
    assert.equal(r.ok, true, r.report);
    assert.match(r.summary, /no unforgiven high\/critical advisories/);
  });
});

describe('scheduling', () => {
  const PS1 = join(REPO_ROOT, 'scripts', 'ops', 'register-tasks.ps1');
  const ps1 = readFileSync(PS1, 'utf8');

  test('register-tasks.ps1 schedules exactly the runner jobs, none more often than every 15 minutes', () => {
    const names = [...ps1.matchAll(/Name\s*=\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...names].sort(), [...JOBS].sort());
    // Day to day GitHub runs its own schedules; this PC only pulls the backups. The six
    // GitHub jobs are registered only with -Failover, so no job ever has two schedulers.
    const modes = Object.fromEntries([...ps1.matchAll(/Name = '([a-z-]+)'; Mode = '([a-z]+)'/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(modes, Object.fromEntries(JOBS.map((j) => [j, j === 'backup-pull' ? 'normal' : 'failover'])));
    const minutes = [...ps1.matchAll(/EveryMinutes\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(minutes.length >= 3, 'no repeating cadences found');
    for (const m of minutes) assert.ok(m >= 15, `a cadence of ${m} minutes`);
  });

  test('this PC is off at night, so the daily and weekly jobs start between 10:00 and 18:00 local', () => {
    const slots = [...ps1.matchAll(/(?:DailyAt|WeeklyAt)\s*=\s*'(?:[A-Za-z]+ )?(\d\d):(\d\d)'/g)].map((m) => Number(m[1]));
    assert.equal(slots.length, 4, 'expected two daily slots and two weekly slots');
    for (const h of slots) assert.ok(h >= 10 && h < 18, `a slot at ${h}:xx, when the PC is usually off`);
  });

  test('backup-pull runs when one missed weekly backup is already stale, and an on-time one is not', () => {
    const [, day, hh, mm] = /Name = 'backup-pull';[^}]*WeeklyAt = '([A-Za-z]+) (\d\d):(\d\d)'/.exec(ps1);
    const [, cm, ch, cdow] = /cron: "(\d+) (\d+) \* \* (\d)"/.exec(workflow('supabase-backup.yml'));
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const utcOffset of [-7, -6]) { // this PC's Mountain time, winter and summer
      const pullH = DOW.indexOf(day) * 24 + Number(hh) + Number(mm) / 60 - utcOffset;
      const backupH = Number(cdow) * 24 + Number(ch) + Number(cm) / 60;
      const sinceOnTime = (((pullH - backupH) % 168) + 168) % 168;
      assert.ok(sinceOnTime / 24 < STALE_DAYS - 1, `UTC${utcOffset}: an on-time backup is ${(sinceOnTime / 24).toFixed(1)} days old at the pull, too close to stale`);
      assert.ok((sinceOnTime + 168) / 24 > STALE_DAYS, `UTC${utcOffset}: one missed backup still reads fresh at the pull`);
    }
  });

  test("every task's time limit exceeds its job's own timeouts plus two pings", async () => {
    // Measured, not declared: each job runs against recorders, and every child timeout and
    // request it would wait on is added up (the backup: its dump deadline and gpg calls).
    const budget = {};
    const recorder = () => {
      const limits = [];
      const run = async (_cmd, _args, opts) => { limits.push(opts.timeoutMs); return { code: 0, stdout: '', stderr: '', timedOut: false, error: null }; };
      return { limits, run, sum: () => limits.reduce((a, b) => a + b, 0) };
    };
    const counter = (answer) => { const c = { n: 0 }; c.fetch = async () => { c.n++; return answer(); }; return c; };
    const syn = counter(() => new Response('', { status: 200 }));
    await runSynthetic({ fetchImpl: syn.fetch, env: {} });
    budget['synthetic-monitor'] = syn.n * SYNTHETIC_TIMEOUT_MS;
    const arb = recorder();
    await JOB_IMPLS['arb-linkage-monitor']({ env: {}, repoRoot: REPO_ROOT, run: arb.run, paths: defaultPaths(REPO_ROOT) });
    budget['arb-linkage-monitor'] = arb.sum();
    const rev = recorder();
    const rpc = counter(() => new Response('{"result":"0x0"}'));
    await JOB_IMPLS['revenue-watch']({
      env: { SOLANA_FEE_ACCOUNT: 'FeeWallet111' }, repoRoot: REPO_ROOT, run: rev.run, stateDir: tmp('bud'), readRails, fetchImpl: rpc.fetch, paths: defaultPaths(REPO_ROOT),
    });
    budget['revenue-watch'] = rev.sum() + rpc.n * RAILS_TIMEOUT_MS;
    const reg = recorder();
    const root = tmp('bud');
    mkdirSync(join(root, 'frontend', 'node_modules', 'viem'), { recursive: true });
    await JOB_IMPLS['registry-onchain']({ env: {}, repoRoot: root, run: reg.run, paths: defaultPaths(root) });
    budget['registry-onchain'] = reg.sum();
    const npm = recorder();
    await JOB_IMPLS['npm-advisories']({ env: {}, repoRoot: REPO_ROOT, run: npm.run, stateDir: tmp('bud'), paths: defaultPaths(REPO_ROOT), npmCommand: () => ({ cmd: 'npm', args: [], shell: false }) });
    budget['npm-advisories'] = npm.sum();
    let gpgCalls = 0;
    const same = (_g, _p, data) => { gpgCalls++; return data; };
    const dir = tmp('bud');
    writeCanary({ dir, passphrase: 'p', gpgBin: 'none', encrypt: (_g, _p, d) => d });
    const tables = async () => new Response('[]', { status: 200, headers: { 'Content-Range': '*/0' } });
    await runBackup({
      env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', BACKUP_PASSPHRASE: 'p' }, fetchImpl: tables, dest: dir, gpgBin: 'none', cipher: { encrypt: same, decrypt: same },
    });
    assert.ok(gpgCalls >= 3, `expected the canary check, the encrypt and the verify, counted ${gpgCalls}`);
    budget['supabase-backup'] = DUMP_DEADLINE_MS + gpgCalls * GPG_TIMEOUT_MS;
    // A minimal well-formed file (AES256 session key, then a one-byte encrypted data packet),
    // so every download succeeds and the most calls the job can make are counted.
    const pgp = Buffer.from([0x8c, 0x0d, 0x04, 0x09, 0x03, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd2, 0x01, 0x01]);
    const listed = JSON.stringify([9, 8, 7, 6, 5].map((id) => ({ databaseId: id, createdAt: new Date(Date.now() - id * 3_600_000).toISOString(), conclusion: 'success', event: 'schedule' })));
    const pullRec = recorder();
    const ghRun = async (cmd, args, opts) => {
      await pullRec.run(cmd, args, opts);
      if (args[1] === 'list') return { code: 0, stdout: listed, stderr: '', timedOut: false, error: null };
      const d = args[args.indexOf('--dir') + 1];
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'supabase-backup-2026-09-28.tar.gz.gpg'), pgp);
      return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
    };
    await JOB_IMPLS['backup-pull']({ env: { BACKUP_PULL_DIR: tmp('bud') }, run: ghRun, pullGithubBackups });
    assert.equal(pullRec.limits.length, 4, 'expected one list and three downloads');
    // Plus every rename the pull makes, each retried for up to RENAME_RETRY_MS.
    budget['backup-pull'] = pullRec.sum() + MAX_RENAMES * RENAME_RETRY_MS;

    const limits = Object.fromEntries([...ps1.matchAll(/Name = '([a-z-]+)';[^}]*LimitMinutes = (\d+)/g)].map((m) => [m[1], Number(m[2]) * 60_000]));
    assert.deepEqual(Object.keys(limits).sort(), [...JOBS].sort());
    for (const job of JOBS) {
      assert.ok(budget[job] > 0, `${job}: measured no time budget at all`);
      const need = budget[job] + 2 * PING_WORST_MS + 30_000;
      assert.ok(limits[job] >= need, `${job}: the task limit is ${limits[job] / 60_000} min but the job may take ${(need / 60_000).toFixed(1)} min`);
    }
  });

  test('register-tasks.ps1 refuses env files that git or OneDrive would copy, and a checkout in OneDrive', {
    skip: process.platform !== 'win32' && 'register-tasks.ps1 runs only on Windows',
  }, () => {
    const root = tmp('ps1');
    const at = (...p) => { const f = join(root, ...p); mkdirSync(dirname(f), { recursive: true }); return f; };
    writeFileSync(at('repo', 'scripts', 'ops', 'run-job.mjs'), '');
    writeFileSync(at('env', 'ops.env'), 'HC_PING_URL_SYNTHETIC_MONITOR=https://hc-ping.com/x\n');
    writeFileSync(at('env', 'backup.env'), "BACKUP_PASSPHRASE='x'\n");
    writeFileSync(at('env', 'leaky.env'), "SUPABASE_SERVICE_KEY='x'\n");
    mkdirSync(at('git', '.git', 'x'), { recursive: true });
    writeFileSync(at('git', 'ops.env'), '');
    writeFileSync(at('OneDrive', 'ops.env'), '');
    writeFileSync(at('OneDrive', 'repo', 'scripts', 'ops', 'run-job.mjs'), '');
    const run = (over = {}) => {
      const p = { RepoRoot: at('repo'), EnvFile: at('env', 'ops.env'), BackupEnvFile: at('env', 'backup.env'), ...over };
      const args = Object.entries(p).flatMap(([k, v]) => (v === true ? [`-${k}`] : [`-${k}`, v]));
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-DryRun', ...args], { encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
    };
    const listing = (out, jobs) => Object.fromEntries(jobs.map((j) => [j, new RegExp(`^\\s*${j} .* reads (.*)$`, 'm').exec(out)?.[1].trim()]));
    // Day to day: only backup-pull, reading ops.env only, while the owner is signed in (gh's
    // login lives in the Windows credential store). backup.env is never looked at.
    const normal = run();
    assert.equal(normal.code, 0, normal.out);
    assert.match(normal.out, /Would register 1 normal task\(s\) .*\(runs only while you are signed in, in a console window: leave it open\)/);
    assert.deepEqual(listing(normal.out, JOBS), Object.fromEntries(JOBS.map((j) => [j, j === 'backup-pull' ? 'ops.env' : undefined])));
    assert.doesNotMatch(normal.out, /backup\.env/);
    // Failover: the six GitHub jobs, and only the backup task is given the file with the service key.
    const ok = run({ Failover: true });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /Would register 6 failover task\(s\) .*\(runs whether or not you are signed in, no window\)/);
    assert.deepEqual(listing(ok.out, JOBS), Object.fromEntries(JOBS.map((j) => [j, j === 'backup-pull' ? undefined : j === 'supabase-backup' ? 'ops.env + backup.env' : 'ops.env'])));
    // Each mode removes the other mode's tasks, so no job ever has two schedulers. The dry run
    // names each one even though none is registered here.
    const removes = (out) => [...out.matchAll(/^\s*would remove(?: if present)?: \\Tegridy\\([a-z-]+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(removes(normal.out), JOBS.filter((j) => j !== 'backup-pull').sort());
    assert.deepEqual(removes(ok.out), ['backup-pull']);
    for (const [label, over, want] of [
      ['env file in a git work tree', { EnvFile: at('git', 'ops.env') }, /the env file .* is inside the git work tree/],
      ['env file in OneDrive', { EnvFile: at('OneDrive', 'ops.env') }, /inside OneDrive, which would sync your secrets/],
      ['env file in a git work tree (failover)', { Failover: true, EnvFile: at('git', 'ops.env') }, /the env file .* is inside the git work tree/],
      ['backup env file in a git work tree', { Failover: true, BackupEnvFile: at('git', 'ops.env') }, /the env file .* is inside the git work tree/],
      ['backup env file in OneDrive', { Failover: true, BackupEnvFile: at('OneDrive', 'ops.env') }, /inside OneDrive, which would sync your secrets/],
      ['checkout in OneDrive', { RepoRoot: at('OneDrive', 'repo') }, /is inside OneDrive, which hollows node_modules/],
      ['the service key in the file every task reads', { EnvFile: at('env', 'leaky.env') }, /holds SUPABASE_SERVICE_KEY/],
      ['one file for both', { Failover: true, BackupEnvFile: at('env', 'ops.env') }, /are the same file/],
    ]) {
      const r = run(over);
      assert.notEqual(r.code, 0, `${label}: not refused\n${r.out}`);
      assert.match(r.out.replace(/\s+/g, ' '), want, label);
    }
  });

  test('register-tasks.ps1 warns day to day when gh is not on PATH, unless GH_BIN names it', {
    skip: process.platform !== 'win32' && 'register-tasks.ps1 runs only on Windows',
  }, () => {
    const root = tmp('ps1gh');
    const at = (...p) => { const f = join(root, ...p); mkdirSync(dirname(f), { recursive: true }); return f; };
    writeFileSync(at('repo', 'scripts', 'ops', 'run-job.mjs'), '');
    writeFileSync(at('env', 'ops.env'), 'HC_PING_URL_BACKUP_PULL=https://hc-ping.com/x\n');
    writeFileSync(at('env', 'ghbin.env'), `GH_BIN=${join(root, 'gh.exe')}\n`);
    writeFileSync(at('env', 'backup.env'), "BACKUP_PASSPHRASE='x'\n");
    // Only Windows' own folders on PATH, so no gh; node is passed by its full path.
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const psDir = join(sys, 'System32', 'WindowsPowerShell', 'v1.0');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
    env.Path = [join(sys, 'System32'), psDir].join(';');
    const run = (envFile, ...extra) => {
      const r = spawnSync(join(psDir, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-DryRun',
        '-RepoRoot', at('repo'), '-EnvFile', envFile, '-BackupEnvFile', at('env', 'backup.env'), '-NodePath', process.execPath, ...extra], { encoding: 'utf8', env });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      return `${r.stdout}\n${r.stderr}`.replace(/\s+/g, ' ');
    };
    const warning = /The GitHub CLI \(gh\) is not on PATH, so backup-pull will fail/;
    assert.match(run(at('env', 'ops.env')), warning);
    assert.doesNotMatch(run(at('env', 'ghbin.env')), warning);
    assert.doesNotMatch(run(at('env', 'ops.env'), '-Failover'), warning, 'a failover does not run backup-pull, so it does not need gh');
  });

  test('the env examples parse cleanly: ops.env has every ping URL and no backup secret; backup.env has the backup settings', () => {
    const read = (f) => parseEnvText(readFileSync(join(REPO_ROOT, 'scripts', 'ops', f), 'utf8'));
    const ops = read('ops.env.example');
    const backup = read('backup.env.example');
    assert.deepEqual([...ops.errors, ...backup.errors], []);
    for (const j of JOBS) assert.ok(pingEnvName(j) in ops.vars, `${pingEnvName(j)} missing from ops.env.example`);
    for (const k of ['SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE']) assert.ok(!(k in ops.vars), `${k} is in the file every job reads`);
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE']) assert.ok(k in backup.vars, k);
  });

  test('childEnv strips secrets and GitHub step files and applies overrides', () => {
    const e = childEnv({ A: '1', BACKUP_PASSPHRASE: 'x', SUPABASE_SERVICE_KEY: 'y', HC_PING_URL_Q: 'z', GITHUB_OUTPUT: 'o', RPC: 'keep' }, { B: '2', RPC: '' });
    assert.deepEqual(e, { A: '1', B: '2' });
  });
});
