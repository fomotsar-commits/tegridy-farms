#!/usr/bin/env node
// Compiles OUR pool contracts (cardano/minswap-dex-v2 as it stands: the 1333 patch, the opening fee) with
// TEST parameters, and writes the scripts the batcher's tests build and simulate batches against:
// test/fixtures/test-deployment.json. Never a real deployment: the seed UTxO and every key are
// made up here. Same compiler, stdlib and parameter order as cardano/guards/prove-build.mjs.
//   AIKEN=<path to aiken 1.0.24> node scripts/build-test-deployment.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STDLIB, cbor } from '../../guards/prove-build.mjs';
import { applier, build, checkCompiler, fetchStdlib, stage } from './aiken.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '../../minswap-dex-v2');
const OUT = resolve(HERE, '../test/fixtures/test-deployment.json');

/** Made up for tests: no such UTxO or key exists on any network. */
export const TEST = {
  seedTxIn: `${'5e'.repeat(32)}#0`,
  poolStakeKeyHash: '50'.repeat(28),
};

const version = checkCompiler(HERE);
const work = mkdtempSync(join(tmpdir(), 'batcher-deploy-'));
try {
  const dir = stage(PROJECT, join(work, 'ours'), fetchStdlib(work));
  build(dir);
  // Minswap's src/script.ts parameter order (prove-build.mjs applyMainnet), with test values.
  const { apply, v, pick } = applier(dir);
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
    `${JSON.stringify({ compiler: version, stdlib: STDLIB.commit, source: 'cardano/minswap-dex-v2 as it stands (the 1333 patch and the pool creation fee applied), TEST parameters', test: TEST, scripts }, null, 1)}\n`,
  );
  console.log(`wrote ${OUT}`);
  for (const [k, s] of Object.entries(scripts)) console.log(`${k}: ${s.hash} (${s.compiledCode.length / 2} bytes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
