#!/usr/bin/env node
// Takes the test fixtures again from mainnet, read only: both BAYLA pools' accounts at one
// finalized slot (tests/fixtures/accounts/<pool>/<key>.bin, a bincode `Account` each, as the
// test kit writes them) and the deployed program (tests/fixtures/memetics.so, the ELF cut to
// its own length, so its sha256 is the registry's). Three requests, 2.5 s apart. Prints the
// slot, the time and the hash to pin in tests/parity.rs. Run from this folder:
//
//   node scripts/take-fixtures.mjs [rpc url, default the public mainnet endpoint]

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RPC = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const POOLS = ['ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm'];
// The sysvars the kit snapshots beside a pool (test-kit rpc.rs `from_rpc`).
const SYSVARS = [
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111',
];
// PoolState offsets (src/state.rs `pool_fields`): the fee tier, two token accounts, two mints, the price record.
const POOL_KEYS = [8, 72, 104, 168, 200, 296];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

let last = 0;
async function rpc(method, params) {
  const wait = last + 2500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  // Lamports and rent epochs are u64: keep their exact digits.
  const body = JSON.parse(await res.text(), (k, v, ctx) =>
    (k === 'lamports' || k === 'rentEpoch') && typeof v === 'number' ? BigInt(ctx.source) : v);
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function accounts(keys) {
  const { context, value } = await rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'finalized' }]);
  return { slot: context.slot, map: new Map(keys.map((k, i) => {
    if (!value[i]) throw new Error(`${k} does not exist`);
    return [k, value[i]];
  })) };
}

/** bincode `solana_account::Account`: lamports, data (u64 length first), owner, executable, rent_epoch. */
function bincode(a) {
  const data = Buffer.from(a.data[0], 'base64');
  const out = Buffer.alloc(8 + 8 + data.length + 32 + 1 + 8);
  out.writeBigUInt64LE(a.lamports, 0);
  out.writeBigUInt64LE(BigInt(data.length), 8);
  data.copy(out, 16);
  decode58(a.owner).copy(out, 16 + data.length);
  out[48 + data.length] = a.executable ? 1 : 0;
  out.writeBigUInt64LE(a.rentEpoch, 49 + data.length);
  return out;
}

function decode58(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const hex = n.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

const first = await accounts([...POOLS, PROGRAM]);
const wanted = new Set([...SYSVARS, PROGRAM]);
const perPool = new Map();
for (const pool of POOLS) {
  const a = first.map.get(pool);
  if (a.owner !== PROGRAM) throw new Error(`${pool} is not owned by the pool program`);
  const data = Buffer.from(a.data[0], 'base64');
  const keys = [pool, ...POOL_KEYS.map((o) => b58(data.subarray(o, o + 32)))];
  perPool.set(pool, keys);
  for (const k of keys) wanted.add(k);
}
const snap = await accounts([...wanted]);
for (const [pool, keys] of perPool) {
  const dir = join('tests/fixtures/accounts', pool);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.bin')) rmSync(join(dir, f));
  for (const k of [...keys, ...SYSVARS]) writeFileSync(join(dir, `${k}.bin`), bincode(snap.map.get(k)));
}

const programAccount = Buffer.from(snap.map.get(PROGRAM).data[0], 'base64');
const programData = b58(programAccount.subarray(4, 36));
const { context, value } = await rpc('getAccountInfo', [programData, { encoding: 'base64', commitment: 'finalized' }]);
const pd = Buffer.from(value.data[0], 'base64');
const elf = pd.subarray(45);
// ELF64: e_shoff at 0x28, e_shentsize at 0x3a, e_shnum at 0x3c; the section headers end the file.
const length = Number(elf.readBigUInt64LE(0x28)) + elf.readUInt16LE(0x3a) * elf.readUInt16LE(0x3c);
if (elf.readUInt32BE(0) !== 0x7f454c46 || length > elf.length || elf.subarray(length).some((b) => b !== 0)) {
  throw new Error('the program data does not hold one ELF followed by zeros');
}
writeFileSync('tests/fixtures/memetics.so', elf.subarray(0, length));

const clock = Buffer.from(snap.map.get(SYSVARS[0]).data[0], 'base64');
console.log(`accounts: finalized slot ${snap.slot}, clock ${new Date(Number(clock.readBigInt64LE(32)) * 1000).toISOString()}`);
console.log(`program: ${programData} at slot ${context.slot}, last deployed slot ${pd.readBigUInt64LE(4)}`);
console.log(`memetics.so: ${length} bytes, sha256 ${createHash('sha256').update(elf.subarray(0, length)).digest('hex')}`);
