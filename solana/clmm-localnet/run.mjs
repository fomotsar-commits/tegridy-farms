// One run from nothing: setup.mjs (mainnet copies, fresh keys), a fresh local validator,
// suite.mjs. Every run starts from the same clean chain. A mutant's env reaches setup too.
// usage: node run.mjs [--mutant <id>] [--stop <phase>] [--keep]   (--keep leaves the validator up)
import { spawn, spawnSync } from 'node:child_process';
import { MUTANTS } from './mutants.mjs';
import { RPC } from './lib/config.mjs';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const mutant = arg('--mutant');
const env = { ...process.env, ...(mutant ? MUTANTS[mutant].env : {}), CLMM_MUTANT: mutant || '', CLMM_STOP: arg('--stop') || '' };
const node = (script, ...a) => {
  const r = spawnSync(process.execPath, [script, ...a], { stdio: 'inherit', env, cwd: import.meta.dirname });
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}`);
};

// WSL stops its machine about a minute after the last wsl.exe client exits, detached processes
// and all, so this run holds one open until it ends.
const keepAlive = spawn('wsl', ['-e', 'bash', '-lc', 'exec sleep 86400'], { stdio: 'ignore' });
const keep = process.argv.includes('--keep');
let code = 0;
try {
  node('validator.mjs', '--stop');
  node('setup.mjs');
  node('validator.mjs');
  for (let i = 0; ; i++) {
    const ok = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }).then((r) => r.json()).then((j) => j.result === 'ok').catch(() => false);
    if (ok) break;
    if (i > 240) throw new Error('validator did not come up; see <ledger>.out in WSL');
    await new Promise((r) => setTimeout(r, 1000));
  }
  node('suite.mjs');
} catch (e) {
  console.error(e.message);
  code = 1;
} finally {
  if (!keep) { try { node('validator.mjs', '--stop'); } catch { /* reported above */ } keepAlive.kill(); } else keepAlive.unref();
}
process.exit(code);
