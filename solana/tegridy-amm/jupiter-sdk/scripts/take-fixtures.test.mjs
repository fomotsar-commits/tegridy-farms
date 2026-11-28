// take-fixtures.mjs against a stub chain, never the network: the script, tests/parity.rs and
// the fixtures are copied into a temporary tree beside a stub registry, and `fetch` is
// replaced (node --import) by one that answers the script's three reads. Each run takes about
// 5 s: the script keeps its 2.5 s between requests. From this folder, on Node 24 (.nvmrc):
//   node --test scripts/take-fixtures.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CRATE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const POOLS = ['ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm'];
const SYSVARS = [
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111',
];
const POOL_KEYS = [8, 72, 104, 168, 200, 296];
// A URL that resolves nowhere: even with the stub missing, no request could reach a chain.
const NOWHERE = 'http://stub.invalid/';
const U64_MAX = 18446744073709551615n;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A stub key: 32 bytes of `n`. */
const keyBytes = (n) => Buffer.alloc(32, n);

// The stub `fetch`, loaded into the script's process. It answers from STUB_CHAIN's accounts
// and refuses the call numbered `failCall`, as a node that falls behind would.
const STUB = `
import { readFileSync } from 'node:fs';
const chain = JSON.parse(readFileSync(process.env.STUB_CHAIN, 'utf8'));
let calls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url) !== ${JSON.stringify(NOWHERE)}) throw new Error('stub fetch: refused ' + url);
  const { method, params } = JSON.parse(init.body);
  calls += 1;
  const get = (k) => chain.accounts[k] ?? null;
  const result = method === 'getMultipleAccounts' ? params[0].map(get) : get(params[0]);
  const body = calls === chain.failCall
    ? { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'stub: node is behind' } }
    : { jsonrpc: '2.0', id: 1, result: { context: { slot: 1000 + calls }, value: result } };
  // u64s go out as bare numbers, as a node sends them.
  return new Response(JSON.stringify(body).replace(/"(lamports|rentEpoch)":"(\\d+)"/g, '"$1":$2'));
};
`;

/** One ELF the script reads as such: its section headers end at byte 192, zeros after. */
function fakeElf() {
  const elf = Buffer.alloc(192);
  for (let i = 0; i < elf.length; i++) elf[i] = (i * 7 + 3) % 251 || 1;
  elf.writeUInt32BE(0x7f454c46, 0);
  elf.writeBigUInt64LE(64n, 0x28); // e_shoff
  elf.writeUInt16LE(64, 0x3a); // e_shentsize
  elf.writeUInt16LE(2, 0x3c); // e_shnum: 64 + 2 * 64 = 192
  return elf;
}

/** The stub chain: both pools, their six keys each, the sysvars, the program and its data. */
function stubChain({ trailing = 0 } = {}) {
  const accounts = {};
  const put = (k, data, owner) => {
    accounts[k] = { data: [data.toString('base64'), 'base64'], owner, lamports: '2039280', executable: false, rentEpoch: String(U64_MAX), space: data.length };
  };
  POOLS.forEach((pool, i) => {
    const data = Buffer.alloc(637, 0);
    POOL_KEYS.forEach((o, j) => {
      const k = keyBytes(10 * i + j + 1);
      k.copy(data, o);
      put(b58(k), Buffer.alloc(165, 10 * i + j + 1), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    });
    put(pool, data, PROGRAM);
  });
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(1_800_000_000n, 32);
  put(SYSVARS[0], clock, 'Sysvar1111111111111111111111111111111111111');
  put(SYSVARS[1], Buffer.alloc(8, 1), 'Sysvar1111111111111111111111111111111111111');
  put(SYSVARS[2], Buffer.alloc(16, 2), 'Sysvar1111111111111111111111111111111111111');
  const programData = keyBytes(99);
  put(PROGRAM, Buffer.concat([Buffer.from([2, 0, 0, 0]), programData]), 'BPFLoaderUpgradeab1e11111111111111111111111');
  const header = Buffer.alloc(45);
  header.writeUInt32LE(3, 0);
  header.writeBigUInt64LE(470_000_000n, 4);
  const tail = Buffer.alloc(64);
  tail[10] = trailing;
  const elf = fakeElf();
  put(b58(programData), Buffer.concat([header, elf, tail]), 'BPFLoaderUpgradeab1e11111111111111111111111');
  return { accounts, elf, programData: b58(programData) };
}

/** Every file under `dir`, by path, as its sha256. */
function tree(dir, root = dir, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tree(p, root, out);
    else out[relative(root, p)] = sha(readFileSync(p));
  }
  return out;
}

/** Runs the script once in a fresh copy of this folder. `registry` changes the registry's row. */
function run(t, { failCall = 0, trailing = 0, registry = (row) => row } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'take-fixtures-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const crate = join(tmp, 'solana/tegridy-amm/jupiter-sdk');
  for (const p of ['scripts/take-fixtures.mjs', 'tests/parity.rs', 'tests/fixtures/memetics.so', 'tests/fixtures/accounts']) {
    cpSync(join(CRATE, p), join(crate, p), { recursive: true });
  }
  const chain = stubChain({ trailing });
  const row = registry({
    id: 'cp-swap-programdata-restart',
    address: chain.programData,
    expect: { type: 'program-owned', holdsProgram: { bytes: chain.elf.length, sha256: sha(chain.elf) } },
  });
  mkdirSync(join(tmp, 'frontend/scripts'), { recursive: true });
  writeFileSync(join(tmp, 'frontend/scripts/addresses.json'), JSON.stringify({ solana: [row] }));
  writeFileSync(join(tmp, 'chain.json'), JSON.stringify({ accounts: chain.accounts, failCall }));
  writeFileSync(join(tmp, 'stub-fetch.mjs'), STUB);
  const before = tree(join(crate, 'tests'));
  const p = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(join(tmp, 'stub-fetch.mjs')).href, join(crate, 'scripts/take-fixtures.mjs'), NOWHERE],
    { cwd: crate, env: { ...process.env, STUB_CHAIN: join(tmp, 'chain.json') }, encoding: 'utf8', timeout: 60_000 },
  );
  return { ...p, crate, chain, before, after: tree(join(crate, 'tests')) };
}

test('the build the registry expects: every fixture is written and its hash pinned', (t) => {
  const r = run(t);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(join(r.crate, 'tests/fixtures/memetics.so')), r.chain.elf);
  const parity = readFileSync(join(r.crate, 'tests/parity.rs'), 'utf8');
  const old = readFileSync(join(CRATE, 'tests/parity.rs'), 'utf8');
  assert.equal(parity, old.replace(/"[0-9a-f]{64}"/, `"${sha(r.chain.elf)}"`));
  assert.notEqual(parity, old);
  POOLS.forEach((pool, i) => {
    const dir = join(r.crate, 'tests/fixtures/accounts', pool);
    const keys = [pool, ...POOL_KEYS.map((_, j) => b58(keyBytes(10 * i + j + 1))), ...SYSVARS];
    assert.deepEqual(readdirSync(dir).sort(), keys.map((k) => `${k}.bin`).sort(), pool);
    // bincode `Account`: lamports, data length, data, owner, executable, rent epoch.
    const a = r.chain.accounts[pool];
    const data = Buffer.from(a.data[0], 'base64');
    const bin = readFileSync(join(dir, `${pool}.bin`));
    assert.equal(bin.readBigUInt64LE(0), 2039280n);
    assert.equal(bin.readBigUInt64LE(8), BigInt(data.length));
    assert.deepEqual(bin.subarray(16, 16 + data.length), data);
    assert.equal(b58(bin.subarray(16 + data.length, 48 + data.length)), PROGRAM);
    assert.equal(bin[48 + data.length], 0);
    assert.equal(bin.readBigUInt64LE(49 + data.length), U64_MAX);
  });
  assert.match(r.stdout, new RegExp(`sha256 ${sha(r.chain.elf)}, the registry's`));
});

for (const [name, opts, why] of [
  ['a build the registry does not expect', { registry: (row) => ({ ...row, expect: { ...row.expect, holdsProgram: { ...row.expect.holdsProgram, sha256: sha('another build') } } }) }, /the registry expects/],
  ['program data at an address the registry does not name', { registry: (row) => ({ ...row, address: PROGRAM }) }, /the registry expects/],
  ['a third read the node refuses', { failCall: 3 }, /stub: node is behind/],
  ['program data with more than one ELF and zeros', { trailing: 1 }, /one ELF followed by zeros/],
]) {
  test(`${name}: nothing is written`, (t) => {
    const r = run(t, opts);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, why);
    assert.deepEqual(r.after, r.before);
  });
}
