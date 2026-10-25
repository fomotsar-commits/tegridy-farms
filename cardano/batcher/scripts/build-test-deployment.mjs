#!/usr/bin/env node
// Compiles OUR pool contracts (cardano/minswap-dex-v2 as it stands, the 1333 patch applied) with
// TEST parameters, and writes the scripts the batcher's tests build and simulate batches against:
// test/fixtures/test-deployment.json. Never a real deployment: the seed UTxO and every key are
// made up here. Same compiler, stdlib and parameter order as cardano/guards/prove-build.mjs.
//   AIKEN=<path to aiken 1.0.24> node scripts/build-test-deployment.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPILER, STDLIB, cbor } from '../../guards/prove-build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../../minswap-dex-v2');
const OUT = resolve(HERE, '../test/fixtures/test-deployment.json');
const AIKEN = process.env.AIKEN || 'aiken';

/** Made up for tests: no such UTxO or key exists on any network. */
export const TEST = {
  seedTxIn: `${'5e'.repeat(32)}#0`,
  poolStakeKeyHash: '50'.repeat(28),
};

const run = (args, cwd) => {
  const r = spawnSync(AIKEN, args, { cwd, encoding: 'utf-8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (r.error || r.status !== 0) throw new Error(`aiken ${args.join(' ')} failed:\n${r.error?.message ?? ''}${out}`);
  return out;
};

// cardano/guards/prove-build.mjs stage(): text-only copy, line endings stripped, the pinned stdlib.
function stage(src, dst, stdlib) {
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

function fetchStdlib(work) {
  const dir = join(work, 'stdlib');
  const git = (args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(dir);
  git(['init', '--quiet']);
  git(['fetch', '--quiet', '--depth', '1', STDLIB.repo, STDLIB.commit]);
  git(['checkout', '--quiet', 'FETCH_HEAD']);
  if (git(['rev-parse', 'HEAD']) !== STDLIB.commit) throw new Error(`stdlib checkout is not ${STDLIB.commit}`);
  return dir;
}

const version = run(['--version'], HERE).trim();
if (version !== COMPILER) throw new Error(`${AIKEN} is ${version}, not ${COMPILER}`);
const work = mkdtempSync(join(tmpdir(), 'batcher-deploy-'));
try {
  const dir = stage(PROJECT, join(work, 'ours'), fetchStdlib(work));
  const built = run(['build'], dir);
  if (/Downloaded/.test(built)) throw new Error('aiken downloaded a package instead of the pinned stdlib');
  // Minswap's src/script.ts parameter order (prove-build.mjs applyMainnet), with test values.
  const apply = (title, arg) => {
    const [m, v] = title.split('.');
    run(['blueprint', 'apply', '-m', m, '-v', v, arg, '-o', 'applied.json'], dir);
    cpSync(join(dir, 'applied.json'), join(dir, 'plutus.json'));
  };
  const blueprint = () => JSON.parse(readFileSync(join(dir, 'plutus.json'), 'utf-8')).validators;
  const v = (title) => blueprint().find((x) => x.title === title);
  const [txId, index] = TEST.seedTxIn.split('#');
  apply('authen_minting_policy.validate_authen', cbor.constr(0, [cbor.constr(0, [cbor.bytes(txId)]), cbor.int(Number(index))]));
  const authen = v('authen_minting_policy.validate_authen').hash;
  apply('authen_minting_policy.validate_spend_global_setting', cbor.constr(0, [cbor.constr(0, [cbor.bytes(txId)]), cbor.int(Number(index))]));
  apply('pool_validator.validate_pool', cbor.bytes(authen));
  const pool = v('pool_validator.validate_pool').hash;
  apply('pool_validator.validate_pool_batching', cbor.bytes(authen));
  apply('pool_validator.validate_pool_batching', cbor.constr(1, [cbor.bytes(pool)]));
  const batching = v('pool_validator.validate_pool_batching').hash;
  const expired = v('order_validator.validate_expired_order_cancel').hash;
  const stakeScript = (h) => cbor.constr(0, [cbor.constr(1, [cbor.bytes(h)])]);
  apply('order_validator.validate_order', stakeScript(batching));
  apply('order_validator.validate_order', stakeScript(expired));
  const pick = (title) => {
    const x = v(title);
    if ((x.parameters ?? []).length) throw new Error(`${title}: parameters left unapplied`);
    return { hash: x.hash, compiledCode: x.compiledCode };
  };
  const scripts = {
    authen: pick('authen_minting_policy.validate_authen'),
    globalSetting: pick('authen_minting_policy.validate_spend_global_setting'),
    pool: pick('pool_validator.validate_pool'),
    poolBatching: pick('pool_validator.validate_pool_batching'),
    order: pick('order_validator.validate_order'),
    expiredOrderCancel: pick('order_validator.validate_expired_order_cancel'),
  };
  if (scripts.authen.hash !== scripts.globalSetting.hash) throw new Error('the authen policy and the global setting spend script differ');
  writeFileSync(
    OUT,
    `${JSON.stringify({ compiler: version, stdlib: STDLIB.commit, source: 'cardano/minswap-dex-v2 as it stands (the 1333 patch applied), TEST parameters', test: TEST, scripts }, null, 1)}\n`,
  );
  console.log(`wrote ${OUT}`);
  for (const [k, s] of Object.entries(scripts)) console.log(`${k}: ${s.hash} (${s.compiledCode.length / 2} bytes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
