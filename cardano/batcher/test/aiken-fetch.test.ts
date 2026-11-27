// Every Aiken run, in the build proof and in the deploy's compile, refuses one that fetched a
// package: "Downloaded ... from network" and "Fetched ... from cache" alike. A stand-in compiler
// (node, running the project's own `build/` or `check/` script) prints what Aiken prints.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

type Runner = { run(args: string[], cwd: string): string; build?(dir: string): void };
// Both read AIKEN when first imported.
process.env.AIKEN = process.execPath;
const load = (p: string) => import(p) as Promise<Runner>;
const prove = await load('../../guards/prove-build.mjs');
const aiken = await load('../scripts/aiken.mjs');

const dir = mkdtempSync(join(tmpdir(), 'aiken-fetch-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** `aiken <command>` in a project of its own that prints `out`. */
function project(name: string, command: string, out: string): string {
  const d = join(dir, name);
  mkdirSync(join(d, command), { recursive: true });
  writeFileSync(join(d, command, 'index.js'), `process.stdout.write(${JSON.stringify(out)});\n`);
  return d;
}

const CLEAN = '    Compiling aiken-lang/stdlib 1.7.0\n    Compiling memetics/role_timelock 0.0.0\n      Summary 0 errors, 0 warnings\n';
const NETWORK = '    Resolving versions\n  Downloaded 1 package in 9.47s from network\n' + CLEAN;
const CACHE = '    Resolving versions\n     Fetched 1 package in 12.38s from cache\n' + CLEAN;

test('a run with nothing fetched passes, in both runners', () => {
  for (const cmd of ['build', 'check']) {
    const d = project(`clean-${cmd}`, cmd, CLEAN);
    assert.equal(prove.run([cmd], d), CLEAN);
    assert.equal(aiken.run([cmd], d), CLEAN);
  }
});

test('a package fetched from the network or from the cache is refused, on check as on build', () => {
  for (const [what, out] of [['network', NETWORK], ['cache', CACHE]] as const) {
    for (const cmd of ['build', 'check']) {
      const d = project(`${what}-${cmd}`, cmd, out);
      assert.throws(() => prove.run([cmd], d), /fetched a package/, `prove-build: ${what} ${cmd}`);
      assert.throws(() => aiken.run([cmd], d), /fetched a package/, `aiken.mjs: ${what} ${cmd}`);
    }
  }
  assert.throws(() => aiken.build?.(project('cache-build-2', 'build', CACHE)), /fetched a package/);
});
