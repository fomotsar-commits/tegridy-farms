#!/usr/bin/env node
// Run one scheduled job and report it to healthchecks: /start, then success or /fail with
// the report as the body. With no HC_PING_URL_<JOB> the job still runs and says loudly
// that no alarm will hear it. Any scheduler can call this: Task Scheduler, cron, CI.
//   node scripts/ops/run-job.mjs <job> [--env-file <path outside any repo>]...
// Exit 0 ok; 1 the job failed; 2 usage; 3 the job passed but the alarm path is broken.

import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFiles, takeEnvFileFlag } from './lib/env-file.mjs';
import { clampBody, resolvePingUrl, scrubSecrets, sendPing } from './lib/healthchecks.mjs';
import { defaultContext, defaultStateDir, JOB_IMPLS, JOBS } from './lib/jobs.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const banner = (msg) => `\n${'!'.repeat(78)}\n!! ${msg}\n${'!'.repeat(78)}\n`;

export async function runJob(job, {
  env = process.env, fetchImpl = fetch, repoRoot = REPO_ROOT, stateDir, log = console.log, warn = console.error,
  jobs = JOB_IMPLS, context = {}, sleep, now = () => Date.now(),
} = {}) {
  if (!JOBS.includes(job) || !jobs[job]) {
    warn(`unknown job '${job}'. Jobs: ${JOBS.join(', ')}`);
    return 2;
  }
  const ping = resolvePingUrl(env, job);
  let alarmBroken = false;
  if (!ping.url && ping.problem === 'unset') {
    warn(banner(`${ping.name} is not set, so this run reaches NO alarm. Only whoever reads this output will see a failure. Put the ping URL in the ops env file.`));
  } else if (!ping.url) {
    warn(banner(`${ping.name} is set but is ${ping.problem}, so no ping will be sent. Fix it in the ops env file.`));
    alarmBroken = true;
  } else {
    const s = await sendPing({ url: ping.url, kind: 'start', fetchImpl, sleep });
    if (!s.ok) {
      warn(`WARNING: the start ping (${ping.name}) failed: ${s.error}`);
      alarmBroken = true;
    }
  }

  const dir = stateDir || defaultStateDir(env);
  const ctx = { ...defaultContext({ env, fetchImpl, repoRoot, stateDir: dir }), ...context };
  const started = now();
  let result;
  try {
    result = await jobs[job](ctx);
  } catch (e) {
    result = { ok: false, summary: `the job crashed: ${e?.message || e}`, report: String(e?.stack || e) };
  }
  const secs = ((now() - started) / 1000).toFixed(1);
  const text = scrubSecrets(`[${job}] ${result.ok ? 'OK' : 'FAIL'}: ${result.summary}\n\n${result.report}\n\n(${secs}s on ${hostname()})`, env);
  log(text);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${job}.last.txt`), `${new Date().toISOString()}\n${text}\n`);
  } catch (e) {
    warn(`WARNING: could not write ${job}.last.txt in ${dir}: ${e.message}`);
  }

  // Only "no alarm configured" counts as told. A set but unusable URL told nobody.
  let delivered = ping.problem === 'unset';
  if (ping.url) {
    const p = await sendPing({ url: ping.url, kind: result.ok ? 'success' : 'fail', body: clampBody(text), fetchImpl, sleep });
    delivered = p.ok;
    if (!p.ok) {
      warn(banner(`The ${result.ok ? 'success' : 'fail'} ping (${ping.name}) was NOT delivered: ${p.error}. healthchecks will raise it as a missed ping.`));
      alarmBroken = true;
    }
  }
  // Recorded only once someone was told (or no alarm is configured at all), so an
  // undelivered change is reported again on the next run.
  if (result.commit && delivered) await result.commit();
  if (!result.ok) return 1;
  return alarmBroken ? 3 : 0;
}

async function main() {
  const { envFiles, rest } = takeEnvFileFlag(process.argv.slice(2));
  const [job, ...extra] = rest;
  if (!job || extra.length || job === '--help') {
    console.error(`usage: node scripts/ops/run-job.mjs <job> [--env-file <path>]...\njobs: ${JOBS.join(', ')}`);
    return 2;
  }
  loadEnvFiles(envFiles);
  return runJob(job);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`run-job could not start: ${e?.message || e}`);
    process.exitCode = 2;
  });
}
