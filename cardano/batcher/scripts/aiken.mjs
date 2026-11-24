// The pinned Aiken compiler, run on a staged copy of a project (cardano/guards/prove-build.mjs's
// stage(): text only, line endings stripped, the pinned stdlib, nothing downloaded). Shared by
// build-test-deployment.mjs (test parameters) and deploy-compile.mjs (the real deploy's).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COMPILER, STDLIB } from '../../guards/prove-build.mjs';

export const AIKEN = process.env.AIKEN || 'aiken';

export const run = (args, cwd) => {
  const r = spawnSync(AIKEN, args, { cwd, encoding: 'utf-8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (r.error || r.status !== 0) throw new Error(`aiken ${args.join(' ')} failed:\n${r.error?.message ?? ''}${out}`);
  return out;
};

export function checkCompiler(cwd) {
  const version = run(['--version'], cwd).trim();
  if (version !== COMPILER) throw new Error(`${AIKEN} is ${version}, not ${COMPILER}`);
  return version;
}

export function stage(src, dst, stdlib) {
  const walk = (d) => {
    for (const name of readdirSync(join(src, d)).sort()) {
      const rel = d ? `${d}/${name}` : name;
      if (rel === 'build') continue;
      if (statSync(join(src, rel)).isDirectory()) walk(rel);
      else {
        mkdirSync(dirname(join(dst, rel)), { recursive: true });
        writeFileSync(join(dst, rel), readFileSync(join(src, rel), 'utf-8').replace(/\r$/gm, ''));
      }
    }
  };
  walk('');
  const pkgs = join(dst, 'build', 'packages');
  cpSync(stdlib, join(pkgs, 'aiken-lang-stdlib'), { recursive: true, filter: (p) => !/[\\/]\.git([\\/]|$)/.test(p) });
  writeFileSync(join(pkgs, 'packages.toml'), `[[packages]]\nname = "aiken-lang/stdlib"\nversion = "${STDLIB.version}"\nsource = "github"\n`);
  return dst;
}

export function fetchStdlib(work) {
  const dir = join(work, 'stdlib');
  const git = (args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(dir);
  git(['init', '--quiet']);
  git(['fetch', '--quiet', '--depth', '1', STDLIB.repo, STDLIB.commit]);
  git(['checkout', '--quiet', 'FETCH_HEAD']);
  if (git(['rev-parse', 'HEAD']) !== STDLIB.commit) throw new Error(`stdlib checkout is not ${STDLIB.commit}`);
  return dir;
}

/** Builds a staged project; refuses a build that downloaded anything. */
export function build(dir) {
  if (/Downloaded/.test(run(['build'], dir))) throw new Error('aiken downloaded a package instead of the pinned stdlib');
}

/** `blueprint apply` takes one parameter at a time: each result replaces plutus.json. */
export function applier(dir) {
  const apply = (title, arg) => {
    const [m, v] = title.split('.');
    run(['blueprint', 'apply', '-m', m, '-v', v, arg, '-o', 'applied.json'], dir);
    cpSync(join(dir, 'applied.json'), join(dir, 'plutus.json'));
  };
  const v = (title) => JSON.parse(readFileSync(join(dir, 'plutus.json'), 'utf-8')).validators.find((x) => x.title === title);
  const pick = (title) => {
    const x = v(title);
    if ((x.parameters ?? []).length) throw new Error(`${title}: parameters left unapplied`);
    return { hash: x.hash, compiledCode: x.compiledCode };
  };
  return { apply, v, pick };
}
