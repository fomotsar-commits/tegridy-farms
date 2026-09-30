// node --test scripts/ops/run-job.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './lib/env-file.mjs';
import { clampBody, pingEnvName, resolvePingUrl, scrubSecrets, sendPing } from './lib/healthchecks.mjs';
import { childEnv, defaultPaths, JOB_IMPLS, JOBS, NPM_PROJECTS } from './lib/jobs.mjs';
import { parseGithubOutput, runProcess } from './lib/proc.mjs';
import { EVM_BALANCES, EVM_CALLS, readRails, SQUADS_VAULT } from './lib/revenue-rails.mjs';
import { ALIASES, CANONICAL, DEFAULT_INDEXER, FOREIGN, runSynthetic } from './lib/synthetic.mjs';
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
    const env = { HC_PING_URL_SYNTHETIC_MONITOR: HC, SUPABASE_SERVICE_KEY: 'eyJsecret-service-key-value', ETH_RPC_URL: 'https://eth.example/v2/apikey123456' };
    const { impl, calls } = pingFetch();
    const out = quiet();
    const err = quiet();
    const st = tmp('st');
    await runJob('synthetic-monitor', {
      env, fetchImpl: impl, stateDir: st, log: out.log, warn: err.log,
      jobs: fakeJob({ ok: false, summary: 'x', report: `leak ${env.SUPABASE_SERVICE_KEY} via ${env.ETH_RPC_URL} and ${HC}` }),
    });
    const everything = [...out.lines, ...err.lines, calls[1].body, readFileSync(join(st, 'synthetic-monitor.last.txt'), 'utf8')].join('\n');
    for (const v of Object.values(env)) assert.ok(!everything.includes(v), `leaked: ${v}`);
    assert.match(calls[1].body, /<SUPABASE_SERVICE_KEY>.*<ETH_RPC_URL>.*<HC_PING_URL_SYNTHETIC_MONITOR>/);
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

  test('an empty audit or a failing gate fails; the reports go to a temp dir, not the repo', async () => {
    const seen = [];
    const run = (auditOut, gateCode) => async (_cmd, args, opts) => {
      if (args.includes('--allowlist')) {
        seen.push(args[args.indexOf('--report') + 1]);
        return { code: gateCode, stdout: `### npm advisories ${args[args.indexOf('--project') + 1]}`, stderr: '', timedOut: false, error: null };
      }
      return { code: 1, stdout: auditOut(opts.cwd), stderr: '', timedOut: false, error: null };
    };
    const job = (r) => JOB_IMPLS['npm-advisories']({ env: {}, repoRoot: REPO_ROOT, run: r, paths: defaultPaths(REPO_ROOT), npmCommand: () => ({ cmd: 'npm', args: ['audit', '--json'], shell: false }) });
    const ok = await job(run(() => '{"vulnerabilities":{}}', 0));
    assert.equal(ok.ok, true, ok.report);
    assert.equal(seen.length, 3);
    for (const p of seen) assert.ok(!p.startsWith(REPO_ROOT), `report written inside the repo: ${p}`);
    const empty = await job(run((cwd) => (cwd.endsWith('indexer') ? '' : '{}'), 0));
    assert.equal(empty.ok, false);
    assert.match(empty.report, /indexer: npm audit produced no output at all/);
    const blocked = await job(run(() => '{}', 1));
    assert.equal(blocked.ok, false);
    assert.match(blocked.summary, /the advisory gate failed/);
  });
});

describe('scheduling', () => {
  test('register-tasks.ps1 schedules exactly the runner jobs, none more often than every 15 minutes', () => {
    const ps1 = readFileSync(join(REPO_ROOT, 'scripts', 'ops', 'register-tasks.ps1'), 'utf8');
    const names = [...ps1.matchAll(/Name\s*=\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...names].sort(), [...JOBS].sort());
    const minutes = [...ps1.matchAll(/EveryMinutes\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(minutes.length >= 3, 'no repeating cadences found');
    for (const m of minutes) assert.ok(m >= 15, `a cadence of ${m} minutes`);
  });

  test('ops.env.example parses cleanly and names every job ping URL and every backup secret', () => {
    const { vars, errors } = parseEnvText(readFileSync(join(REPO_ROOT, 'scripts', 'ops', 'ops.env.example'), 'utf8'));
    assert.deepEqual(errors, []);
    for (const j of JOBS) assert.ok(pingEnvName(j) in vars, `${pingEnvName(j)} missing from the example`);
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE']) assert.ok(k in vars, k);
  });

  test('childEnv strips secrets and GitHub step files and applies overrides', () => {
    const e = childEnv({ A: '1', BACKUP_PASSPHRASE: 'x', SUPABASE_SERVICE_KEY: 'y', HC_PING_URL_Q: 'z', GITHUB_OUTPUT: 'o', RPC: 'keep' }, { B: '2', RPC: '' });
    assert.deepEqual(e, { A: '1', B: '2' });
  });
});
