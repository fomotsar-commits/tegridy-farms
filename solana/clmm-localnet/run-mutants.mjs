// Red first: each mutant (mutants.mjs) runs the suite on a fresh chain with one broken input,
// and its target check must come out FAIL. Then the restore: a clean run on a fresh chain must
// pass every check, with the program's bytes and source unchanged.
// Three chains run side by side, each with its own ports, ledger and work folder; a sweep uses a
// 3 s lock (CLMM_TIME_LOCK) unless the mutant sets its own. The restore run uses the default lock.
// usage: node run-mutants.mjs [id ...]      writes mutants-<start time>.json into CLMM_WORK
// env CLMM_SO (the program, as validator.mjs), CLMM_LEDGER_BASE and CLMM_PORT_BASE: another session's chains may hold the defaults.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MUTANTS } from './mutants.mjs';
import { WORK, REPO } from './lib/config.mjs';

const WORKERS = Number(process.env.CLMM_WORKERS || 3);
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MUTANTS);
const SO = process.env.CLMM_SO || '/root/clmm-p1/tegridy-clmm/target/deploy/raydium_clmm.so';
const LEDGERS = process.env.CLMM_LEDGER_BASE || '/root/clmm-p1/ledger';
const PORT_BASE = Number(process.env.CLMM_PORT_BASE || 20899);
const programSha = () => execFileSync('wsl', ['-e', 'bash', '-lc', `sha256sum ${SO}`]).toString().split(' ')[0];
const sourceTree = () => execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD:solana/tegridy-clmm']).toString().trim();
const dirty = () => execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'solana/tegridy-clmm']).toString().trim();
const shaBefore = programSha();
const treeBefore = sourceTree();
const out = { started: new Date().toISOString(), programSha: shaBefore, sourceTree: treeBefore, workers: WORKERS, mutants: [] };

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['run.mjs', ...args], { cwd: import.meta.dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.resume();
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('exit', (code) => resolve({ code, err }));
  });
}

const queue = [...ids];
async function worker(i) {
  const work = join(WORK, `w${i}`);
  mkdirSync(work, { recursive: true });
  copyFileSync(join(WORK, 'deactivate-features.txt'), join(work, 'deactivate-features.txt'));
  for (let id; (id = queue.shift()); ) {
    const f = join(work, `results-mutant-${id}.json`);
    if (existsSync(f)) rmSync(f);
    const t0 = Date.now();
    const env = { ...process.env, CLMM_WORK: work, CLMM_PORT: String(PORT_BASE + 2000 * i), CLMM_LEDGER: `${LEDGERS}-w${i}`, CLMM_TIME_LOCK: '3', ...(MUTANTS[id].env || {}) };
    // A run whose target was never judged (a validator that did not start, under load) gets one more try.
    let r = await run(['--mutant', id], env);
    if (!existsSync(f)) r = await run(['--mutant', id], env);
    const res = existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null;
    const target = res?.checks.find((c) => c.id === MUTANTS[id].target);
    const red = !!target && !target.pass;
    out.mutants.push({ id, target: MUTANTS[id].target, what: MUTANTS[id].what, red, judged: !!target, counts: target?.counts ?? null, seconds: Math.round((Date.now() - t0) / 1000), exit: r.code, worker: i });
    console.log(`${red ? 'RED ' : 'MISS'} ${id} -> ${MUTANTS[id].target} (w${i}, ${Math.round((Date.now() - t0) / 1000)} s): ${target ? target.counts : 'target never judged (exit ' + r.code + ')'}`);
    if (!target) console.log(r.err.split('\n').slice(-8).join('\n'));
  }
}
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));

// The restore: a clean run from nothing, with the default lock, after every mutant.
if (process.env.CLMM_NO_RESTORE) { for (const m of out.mutants) if (!m.red) console.log('not red:', m.id); process.exit(out.mutants.every((m) => m.red) ? 0 : 1); }
const clean = join(WORK, 'results-clean.json');
if (existsSync(clean)) rmSync(clean);
const r = await run([], { ...process.env, CLMM_WORK: WORK });
const res = existsSync(clean) ? JSON.parse(readFileSync(clean, 'utf-8')) : null;
out.restore = {
  cleanChecks: res?.checks.length ?? 0, cleanFailed: res ? res.checks.filter((c) => !c.pass).map((c) => c.id) : ['no result'],
  programShaAfter: programSha(), sourceTreeAfter: sourceTree(), sourceDirty: dirty(), exit: r.code,
};
out.restore.ok = !!res && out.restore.cleanFailed.length === 0 && out.restore.programShaAfter === shaBefore && out.restore.sourceTreeAfter === treeBefore && !out.restore.sourceDirty;
out.finished = new Date().toISOString();
out.mutants.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
writeFileSync(join(WORK, `mutants-${out.started.replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 1));
const missed = out.mutants.filter((m) => !m.red);
console.log(`\n${out.mutants.length} mutants, ${out.mutants.length - missed.length} red, ${missed.length} not red${missed.length ? ': ' + missed.map((m) => m.id).join(', ') : ''}`);
console.log(`restore: ${out.restore.ok ? 'proven' : 'NOT proven'} (clean ${out.restore.cleanChecks} checks, failed [${out.restore.cleanFailed}], program ${out.restore.programShaAfter.slice(0, 12)}, source ${out.restore.sourceDirty ? 'DIRTY' : 'clean'})`);
process.exit(missed.length || !out.restore.ok ? 1 : 0);
