#!/usr/bin/env node
// Reads, never writes: the venue's BAYLA/SOL pool and every account a slice touches, as mainnet
// holds them now, for the rehearsal test (`cargo test -- --ignored`). The pool and its program
// come from frontend/scripts/addresses.json by id; the rest from the pool's own bytes.
//
//   node fetch-mainnet.mjs [rpc url] > /tmp/mainnet.json
//
// It PRINTS the file and never writes one: what lands on disk is the operator's redirect (from a
// POSIX shell: Windows PowerShell 5.1's `>` writes UTF-16, which the test cannot read). And it
// prints only what it has checked: every account is owned by the program it should be (each coin
// and its vault by the token program the pool names for that side), is not executable, and holds
// base64 data of its account's size carrying the tag that says what it is;
// each vault holds its own coin, and the price record names the pool; every slot and lamport
// count is a bounded whole number; every address decodes to 32 bytes. Anything else stops it
// with one line naming what it refused, before a byte is printed. Only the fields the test reads
// are kept.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeKey, encodeKey } from '../../guards/key-guard.mjs';

const [rpc = 'https://api.mainnet-beta.solana.com', extra] = process.argv.slice(2);
if (extra !== undefined || !/^https?:\/\/[^\s]+$/.test(rpc)) {
  throw new Error('usage: node fetch-mainnet.mjs [rpc url] > <out.json>');
}

const registry = JSON.parse(readFileSync(new URL('../../../frontend/scripts/addresses.json', import.meta.url)));
const row = (id) => {
  const r = registry.solana.find((x) => x.id === id);
  if (!r) throw new Error(`no registry row ${id}`);
  return r.address;
};

const CP_SWAP = row('cp-swap-program-restart');
const tag = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

const refuse = (what) => {
  throw new Error(`refused: ${what}`);
};
const key = (s, what) => (typeof s === 'string' && decodeKey(s) ? s : refuse(`${what} is not a 32-byte key`));
const whole = (n, what) => (Number.isSafeInteger(n) && n >= 0 ? n : refuse(`${what} is not a bounded whole number`));

async function read(keys) {
  const body = { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed' }] };
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) refuse(`rpc answered HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.result) throw new Error(`rpc: ${JSON.stringify(j?.error ?? j)}`);
  const values = j.result.value;
  if (!Array.isArray(values) || values.length !== keys.length) refuse(`rpc gave no answer per account`);
  return { slot: whole(j.result.context?.slot, 'slot'), values };
}

/** The account's bytes, once its answer is in shape and owned by `owner`. */
function account(v, name, address, owner) {
  if (!v) refuse(`${name} ${address} is absent on mainnet`);
  if (key(v.owner, `${name} owner`) !== owner) refuse(`${name} is owned by ${v.owner}, not ${owner}`);
  if (v.executable !== false) refuse(`${name} is executable`);
  whole(v.lamports, `${name} lamports`);
  const [b64, encoding] = Array.isArray(v.data) ? v.data : [];
  if (encoding !== 'base64' || typeof b64 !== 'string') refuse(`${name} data is not base64`);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.toString('base64') !== b64) refuse(`${name} data is not canonical base64`);
  return bytes;
}

function tagged(bytes, name, struct, size) {
  if (bytes.length !== size) refuse(`${name} holds ${bytes.length} bytes, not ${size}`);
  if (!bytes.subarray(0, 8).equals(tag(struct))) refuse(`${name} is not a ${struct}`);
}

// A coin's mint (82 bytes, or a Token-2022 mint with extensions: type 1 after byte 165) and a
// token account (165 bytes, or with extensions: type 2).
function sized(bytes, name, base, type) {
  if (bytes.length === base) return;
  if (bytes.length > 165 && bytes[165] === type) return;
  refuse(`${name} is not a ${type === 1 ? 'mint' : 'token account'} (${bytes.length} bytes)`);
}

const pool = key(row('venue-pool-bayla-sol'), 'venue-pool-bayla-sol');
const first = await read([pool]);
const p = account(first.values[0], 'pool', pool, CP_SWAP);
tagged(p, 'pool', 'PoolState', 637);
const at = (o) => encodeKey(p.subarray(o, o + 32));
const keys = {
  pool,
  amm_config: at(8),
  vault_0: at(72),
  vault_1: at(104),
  mint_0: at(168),
  mint_1: at(200),
  observation: at(296),
};
// Each coin's token program, as the pool names it: its mint and its vault must both be owned by it.
const program = { 0: key(at(232), 'token_0_program'), 1: key(at(264), 'token_1_program') };
for (const [name, k] of Object.entries(keys)) key(k, name);

const { slot, values } = await read(Object.values(keys));
const owners = {
  pool: CP_SWAP,
  amm_config: CP_SWAP,
  vault_0: program[0],
  vault_1: program[1],
  mint_0: program[0],
  mint_1: program[1],
  observation: CP_SWAP,
};
const accounts = {};
Object.entries(keys).forEach(([name, address], i) => {
  const v = values[i];
  const bytes = account(v, name, address, owners[name]);
  accounts[name] = { address, owner: v.owner, lamports: v.lamports, executable: false, data: bytes.toString('base64') };
  accounts[name].bytes = bytes;
});

if (!accounts.pool.bytes.equals(p)) refuse('the pool changed between the two reads: run it again');
tagged(accounts.amm_config.bytes, 'amm_config', 'AmmConfig', 236);
tagged(accounts.observation.bytes, 'observation', 'ObservationState', 4075);
if (encodeKey(accounts.observation.bytes.subarray(11, 43)) !== pool) refuse('the price record names another pool');
for (const side of [0, 1]) {
  sized(accounts[`mint_${side}`].bytes, `mint_${side}`, 82, 1);
  const vault = accounts[`vault_${side}`].bytes;
  sized(vault, `vault_${side}`, 165, 2);
  if (encodeKey(vault.subarray(0, 32)) !== keys[`mint_${side}`]) refuse(`vault_${side} holds another coin`);
}
for (const a of Object.values(accounts)) delete a.bytes;

console.log(JSON.stringify({ slot, rpc, read_at: new Date().toISOString(), accounts }, null, 1));
console.error(`slot ${slot}: ${Object.keys(accounts).length} accounts checked and printed`);
