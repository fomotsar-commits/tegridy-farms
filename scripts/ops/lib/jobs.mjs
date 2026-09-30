// The six scheduled jobs, each returning { ok, summary, report, commit? }. They reuse the
// scripts the GitHub workflows ran. A --probe script writes its verdict to $GITHUB_OUTPUT,
// which is a no-op off GitHub unless someone reads it; here it is a temp file this runner
// owns and reads back, and a missing verdict is a failure, never health.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBackup, withoutSecrets } from './backup.mjs';
import { parseGithubOutput, runProcess } from './proc.mjs';
import { readRails } from './revenue-rails.mjs';
import { runSynthetic } from './synthetic.mjs';

export const JOBS = Object.freeze(['synthetic-monitor', 'arb-linkage-monitor', 'revenue-watch', 'registry-onchain', 'npm-advisories', 'supabase-backup']);
// Every directory with its own package-lock.json (npm-advisories.yml's matrix).
export const NPM_PROJECTS = Object.freeze(['.', 'frontend', 'indexer']);
const ARB_STATUSES = ['GO', 'WARN', 'HALT', 'ERROR'];
const CREDIT_STATES = ['stranded', 'clear', 'unknown'];
const MIN = 60_000;

export function defaultPaths(root) {
  return {
    arbConsumer: join(root, 'scripts', 'monitoring', 'arbPauseConsumer.mjs'),
    arbTests: [join(root, 'contracts', 'monitoring', 'lib', 'arbLinkage.test.mjs'), join(root, 'scripts', 'monitoring', 'lib', 'pausePlan.test.mjs')],
    callerCredit: join(root, 'scripts', 'pull-caller-credit.mjs'),
    verifyAddresses: join(root, 'frontend', 'scripts', 'verify-addresses.mjs'),
    verifyLadders: join(root, 'scripts', 'verify-ladder-builds.mjs'),
    npmGate: join(root, '.github', 'scripts', 'npm-advisory-gate.mjs'),
    npmAllowlist: join(root, '.github', 'npm-advisory-allowlist.json'),
  };
}

export function defaultStateDir(env = process.env) {
  if (env.OPS_STATE_DIR) return env.OPS_STATE_DIR;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'tegridy-ops');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'tegridy-ops');
}

/** A child's environment: no secrets, no ping URLs, no GitHub step files, plus `extra`. */
export function childEnv(env, extra = {}) {
  const e = withoutSecrets(env);
  delete e.GITHUB_OUTPUT;
  delete e.GITHUB_STEP_SUMMARY;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') delete e[k];
    else e[k] = v;
  }
  return e;
}

export const describeRun = (r) => (r.error ? `could not start: ${r.error}` : r.timedOut ? 'timed out' : `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}`);
const tail = (text, n = 25) => String(text || '').trim().split(/\r?\n/).slice(-n).join('\n');
const node = process.execPath;

async function probeScript(ctx, script, extraEnv, timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-probe-'));
  const out = join(dir, 'github_output');
  try {
    const r = await ctx.run(node, [script, '--probe'], { cwd: ctx.repoRoot, env: childEnv(ctx.env, { ...extraEnv, GITHUB_OUTPUT: out }), timeoutMs });
    return { r, outputs: parseGithubOutput(existsSync(out) ? readFileSync(out, 'utf8') : '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function syntheticMonitor(ctx) {
  const s = await runSynthetic({ fetchImpl: ctx.fetchImpl, env: ctx.env });
  return { ok: s.ok, summary: s.ok ? 'all probes passed' : `${s.fails.length} probe(s) failing`, report: s.report };
}

async function arbLinkageMonitor(ctx) {
  const p = ctx.paths;
  const { r, outputs } = await probeScript(ctx, p.arbConsumer, { RPC: ctx.env.RPC || ctx.env.ETH_RPC_URL }, 6 * MIN);
  const problems = [];
  if (r.error || r.timedOut || r.code !== 0) problems.push(`the pause consumer did not finish cleanly (${describeRun(r)})`);
  const status = ARB_STATUSES.includes(outputs.arb_status) ? outputs.arb_status : null;
  if (!status) problems.push('the pause consumer wrote no verdict to its output file, so the linkage is UNKNOWN (read as ERROR, never as health)');
  // After the verdict, as in the workflow: a verdict from a rule that fails its tests is not trusted.
  const t = await ctx.run(node, ['--test', ...p.arbTests], { cwd: ctx.repoRoot, env: childEnv(ctx.env), timeoutMs: 5 * MIN });
  if (t.code !== 0) problems.push(`the rule that produced this verdict failed its own tests (${describeRun(t)})`);
  const verdict = status || 'ERROR';
  const ok = problems.length === 0 && (verdict === 'GO' || verdict === 'WARN');
  const report = [
    `Arb linkage: ${verdict}. ${outputs.arb_summary || ''}`.trim(),
    ...problems.map((x) => `- ${x}`),
    '',
    outputs.arb_report || tail(`${r.stdout}\n${r.stderr}`),
  ];
  if (!ok) {
    report.push('', 'The pause is NOT automated and no key is held here. Re-run `node scripts/monitoring/arbPauseConsumer.mjs` locally before broadcasting anything: the guardian and owner addresses are read live and may have moved.');
  }
  if (t.code !== 0) report.push('', tail(`${t.stdout}\n${t.stderr}`));
  return { ok, summary: `arb linkage ${verdict}${problems.length ? ' (with problems)' : ''}`, report: report.join('\n') };
}

async function revenueWatch(ctx) {
  const { r, outputs } = await probeScript(ctx, ctx.paths.callerCredit, {}, 6 * MIN);
  const rails = await ctx.readRails({ fetchImpl: ctx.fetchImpl, env: ctx.env });
  const credit = CREDIT_STATES.includes(outputs.stranded_state) ? outputs.stranded_state : null;
  const blindness = [...rails.unknown];
  if (r.error || r.timedOut || r.code !== 0) blindness.push(`- pull-caller-credit.mjs did not finish cleanly (${describeRun(r)})`);
  if (!credit) blindness.push('- pull-caller-credit.mjs wrote no verdict, so callerCredit is unread');
  else if (credit === 'unknown') blindness.push('- callerCredit could not be read');

  const fingerprint = createHash('sha256').update(`${outputs.stranded_fingerprint || ''}\n${rails.earned.join('\n')}`).digest('hex').slice(0, 16);
  const stateFile = join(ctx.stateDir, 'revenue-watch.fingerprint');
  const last = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : null;
  const body = [
    `Rails: ${rails.state}. callerCredit: ${credit || 'NO VERDICT'}. Fingerprint ${fingerprint} (last reported: ${last || 'none on this machine'}).`,
    '', 'Non-zero rails:', ...(rails.earned.length ? rails.earned : ['- none']),
    '', 'Stranded callerCredit:', outputs.stranded || tail(`${r.stdout}\n${r.stderr}`) || '- not probed',
    '', 'Unreadable this run:', ...(blindness.length ? blindness : ['- none']),
    '', 'Not watched (by decision):', ...(rails.unconfigured.length ? rails.unconfigured : ['- none']),
  ].join('\n');

  // Blind wins: an unread rail is indistinguishable from zero. (The workflow let a permanent
  // "earned" mask it; here any unread rail fails the run.)
  if (blindness.length) {
    return { ok: false, summary: 'BLIND: some rails could not be read, so this run proves nothing about revenue', report: body };
  }
  if (last !== fingerprint) {
    return {
      ok: false,
      summary: last ? 'CHANGED: the revenue picture moved since the last report (news, not a fault)' : 'FIRST READING on this machine, recorded (news, not a fault)',
      report: `${body}\n\nThe next run reports OK unless it changes again.`,
      commit: () => { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, `${fingerprint}\n`); },
    };
  }
  return { ok: true, summary: `unchanged since the last report (${fingerprint})`, report: body };
}

async function registryOnchain(ctx) {
  const fe = join(ctx.repoRoot, 'frontend');
  if (!existsSync(join(fe, 'node_modules', 'viem'))) {
    return { ok: false, summary: 'cannot run: frontend/node_modules is missing', report: 'verify-addresses.mjs imports viem. Run `npm ci --ignore-scripts` in frontend/ of this checkout first.' };
  }
  const env = childEnv(ctx.env);
  const offline = await ctx.run(node, [ctx.paths.verifyAddresses], { cwd: fe, env, timeoutMs: 5 * MIN });
  const onchain = await ctx.run(node, [ctx.paths.verifyAddresses, '--onchain'], { cwd: fe, env, timeoutMs: 10 * MIN });
  const ladders = await ctx.run(node, [ctx.paths.verifyLadders], { cwd: ctx.repoRoot, env, timeoutMs: 10 * MIN });
  const problems = [];
  const notes = [];
  if (offline.code !== 0) problems.push(`registry structure (offline) failed (${describeRun(offline)})`);
  if (onchain.code !== 0) problems.push(`registry vs live chain failed (${describeRun(onchain)})`);
  if (ladders.code !== 0) problems.push(`ladder build check failed (${describeRun(ladders)})`);
  if (!ladders.stdout.includes('LADDER BUILDS SHIPPED BY THE REGISTRY')) problems.push("no ladder table was produced: green here would mean 'nothing was checked'");
  if (!onchain.stdout.includes('live chain state')) problems.push('no chain section was produced: nothing was read from the chain');
  const cov = [...onchain.stdout.matchAll(/chain read: (\d+) considered, (\d+) NOT CHECKED/g)].pop();
  if (!cov) problems.push("no 'chain read: N considered, M NOT CHECKED' line, so this run cannot say what it verified");
  else {
    const [considered, skipped] = [Number(cov[1]), Number(cov[2])];
    if (considered > 0 && skipped >= considered) problems.push(`all ${considered} addresses were skipped (the RPC did not answer): this run verified NOTHING`);
    else if (skipped > 0) notes.push(`warn: ${skipped} of ${considered} addresses were NOT CHECKED (the RPC did not answer)`);
  }
  const at = onchain.stdout.indexOf('live chain state');
  const report = [
    ...problems.map((x) => `- ${x}`), ...notes, '',
    at === -1 ? tail(`${onchain.stdout}\n${onchain.stderr}`) : onchain.stdout.slice(at).trim(),
    '', tail(`${ladders.stdout}\n${ladders.stderr}`, 20),
  ];
  if (offline.code !== 0) report.push('', tail(`${offline.stdout}\n${offline.stderr}`));
  return { ok: problems.length === 0, summary: problems.length ? `${problems.length} problem(s)` : 'registry matches the chain', report: report.join('\n') };
}

function npmCommand() {
  const nodeDir = dirname(process.execPath);
  for (const cli of [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(cli)) return { cmd: node, args: [cli, 'audit', '--json'], shell: false };
  }
  return { cmd: 'npm audit --json', args: [], shell: true };
}

// A blocking advisory fails the run once, when it first appears. Later runs still list it
// but pass, so a known red cannot hold the check down and mute the next new advisory (or
// a job that stopped running). The gate's own rules decide what blocks.
async function npmAdvisories(ctx) {
  const gate = await import(pathToFileURL(ctx.paths.npmGate).href);
  let allowlist;
  try {
    allowlist = JSON.parse(readFileSync(ctx.paths.npmAllowlist, 'utf8'));
  } catch (e) {
    return { ok: false, summary: 'the advisory allowlist could not be read', report: `${ctx.paths.npmAllowlist}: ${e.message}` };
  }
  const problems = [];
  const sections = [];
  const blocking = [];
  for (const p of NPM_PROJECTS) {
    const npm = ctx.npmCommand ? ctx.npmCommand() : npmCommand();
    const audit = await ctx.run(npm.cmd, npm.args, { cwd: join(ctx.repoRoot, p), env: childEnv(ctx.env), timeoutMs: 5 * MIN, shell: npm.shell });
    // npm's exit code is not the verdict (it is non-zero for "found" and "offline" alike); the gate is.
    if (!audit.stdout.trim()) {
      problems.push(`${p}: npm audit produced no output at all (${describeRun(audit)}) ${tail(audit.stderr, 3)}`.trim());
      continue;
    }
    let result;
    try {
      result = gate.evaluate({ report: JSON.parse(audit.stdout), allowlist, project: p });
    } catch (e) {
      problems.push(`${p}: the audit cannot be trusted (${e.message})`);
      continue;
    }
    sections.push(gate.renderSummary(p, result));
    for (const a of result.blocking) blocking.push(`${p} ${a.ghsa}`);
  }

  const stateFile = join(ctx.stateDir, 'npm-advisories.blocking');
  const known = new Set(existsSync(stateFile) ? readFileSync(stateFile, 'utf8').split(/\r?\n/).filter(Boolean) : []);
  const fresh = blocking.filter((b) => !known.has(b));
  const record = () => { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, blocking.map((b) => `${b}\n`).join('')); };
  const report = [
    ...problems.map((x) => `- ${x}`),
    ...(blocking.length ? ['Blocking (high or critical, not allowlisted):', ...blocking.map((b) => `- ${b}${fresh.includes(b) ? '  NEW' : ''}`)] : []),
    '', ...sections,
  ].join('\n').trim();
  if (problems.length) return { ok: false, summary: problems.join('; '), report };
  if (fresh.length) {
    return { ok: false, summary: `NEW blocking advisories: ${fresh.join(', ')}. Fix or triage them; later runs pass while this list does not grow`, report, commit: record };
  }
  return {
    ok: true,
    summary: blocking.length
      ? `${blocking.length} known blocking advisories, reported before: fix or triage them`
      : `no unforgiven high/critical advisories in ${NPM_PROJECTS.join(', ')}`,
    report,
    commit: blocking.length === known.size ? undefined : record,
  };
}

async function supabaseBackup(ctx) {
  const r = await ctx.runBackup({ env: ctx.env, fetchImpl: ctx.fetchImpl });
  return { ok: r.ok, summary: r.ok ? 'backup written and verified' : 'BACKUP FAILED: no new restore point exists', report: r.lines.join('\n') };
}

export const JOB_IMPLS = Object.freeze({
  'synthetic-monitor': syntheticMonitor,
  'arb-linkage-monitor': arbLinkageMonitor,
  'revenue-watch': revenueWatch,
  'registry-onchain': registryOnchain,
  'npm-advisories': npmAdvisories,
  'supabase-backup': supabaseBackup,
});

export function defaultContext({ env, fetchImpl, repoRoot, stateDir }) {
  return { env, fetchImpl, repoRoot, stateDir, run: runProcess, paths: defaultPaths(repoRoot), readRails, runBackup };
}
