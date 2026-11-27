// The deploy compiles only what CI proved: provenance passes, nothing under cardano/ differs from
// the commit, and the commit is on trunk. A preprod rehearsal may skip the git checks, out loud;
// a mainnet deploy never. git is stood in for; provenance reads this tree, or a tampered copy.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSource, compileDeployment, TRUNK } from '../scripts/deploy-compile.mjs';
import type { DeployInputs } from '../src/deploy.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const HEAD = 'ab'.repeat(20);
/** git as a clean trunk checkout answers, or with cardano/ edited, or off trunk. */
function git(o: { dirty?: boolean; offTrunk?: boolean } = {}) {
  return (args: string[]): string => {
    if (args[0] === 'rev-parse') return HEAD;
    if (args[0] === 'status') return o.dirty ? ' M cardano/minswap-dex-v2/validators/factory_validator.ak' : '';
    if (args[0] === 'merge-base') {
      assert.deepEqual(args, ['merge-base', '--is-ancestor', HEAD, TRUNK]);
      if (o.offTrunk) throw new Error('exit 1');
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

test('a clean trunk commit whose copies provenance proves is compiled, and says which commit', () => {
  assert.deepEqual(checkSource(1, { git: git() }), { commit: HEAD, proven: true });
  assert.deepEqual(checkSource(0, { git: git() }), { commit: HEAD, proven: true });
});

test('an edited cardano/, or a commit off trunk, is refused on either network', () => {
  for (const network of [0, 1]) {
    assert.throws(() => checkSource(network, { git: git({ dirty: true }) }), /cardano\/ differs from commit/);
    assert.throws(() => checkSource(network, { git: git({ offTrunk: true }) }), /is not on origin\/mvp-launch/);
  }
});

test('--unproven: a preprod rehearsal goes on with a warning; mainnet is refused, clean or not', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(checkSource(0, { unproven: true, git: git({ dirty: true, offTrunk: true }) }), { commit: HEAD, proven: false });
  const said = warn.mock.calls.map((c) => String(c.arguments[0])).join('\n');
  assert.match(said, /WARNING --unproven.*cardano\/ differs/);
  assert.match(said, /WARNING --unproven.*not on origin\/mvp-launch/);
  assert.match(said, /never a deploy/);
  assert.throws(() => checkSource(1, { unproven: true, git: git() }), /preprod rehearsals only/);
});

test('a copy provenance refuses is never compiled, --unproven or not', () => {
  const d = mkdtempSync(join(tmpdir(), 'deploy-src-'));
  try {
    for (const p of ['cardano/minswap-dex-v2', 'cardano/role-timelock/lib/amm_dex_v2', 'cardano/role-timelock/aiken.toml', 'cardano/role-timelock/aiken.lock']) cpSync(join(REPO, p), join(d, p), { recursive: true });
    checkSource(0, { git: git(), root: d });
    const f = join(d, 'cardano/minswap-dex-v2/lib/amm_dex_v2/pool_validation.ak');
    writeFileSync(f, readFileSync(f, 'utf8').replace('pool_in_value == pool_out_value', 'True'));
    assert.throws(() => checkSource(0, { unproven: true, git: git(), root: d }), /provenance refuses this tree/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('compileDeployment checks the source before it runs the compiler', () => {
  const p = { network: 1 } as DeployInputs;
  assert.throws(() => compileDeployment(p, { git: git({ dirty: true }) }), /only a clean trunk commit is compiled/);
  assert.throws(() => compileDeployment(p, { unproven: true, git: git() }), /preprod rehearsals only/);
});
