#!/usr/bin/env node
// Reads, never writes: the venue's BAYLA/SOL pool and every account a slice touches, as mainnet
// holds them now, into one JSON file for the rehearsal test (`cargo test -- --ignored`). The pool
// comes from frontend/scripts/addresses.json by role; the rest from the pool's own bytes.
//
// node fetch-mainnet.mjs <out.json> [rpc url]

import { readFileSync, writeFileSync } from 'node:fs';
import { decodeKey, encodeKey } from '../../guards/key-guard.mjs';

const [out, rpc = 'https://api.mainnet-beta.solana.com'] = process.argv.slice(2);
if (!out) throw new Error('usage: node fetch-mainnet.mjs <out.json> [rpc url]');

const registry = JSON.parse(readFileSync(new URL('../../../frontend/scripts/addresses.json', import.meta.url)));
const row = (role) => {
  const r = registry.solana.find((x) => x.id === role || x.role === role);
  if (!r) throw new Error(`no registry row ${role}`);
  return r.address;
};

async function read(keys) {
  const body = { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed' }] };
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!j.result) throw new Error(`rpc: ${JSON.stringify(j.error ?? j)}`);
  return { slot: j.result.context.slot, values: j.result.value };
}

const pool = row('venue-pool-bayla-sol');
const first = await read([pool]);
const p = Buffer.from(first.values[0].data[0], 'base64');
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
for (const k of Object.values(keys)) if (!decodeKey(k)) throw new Error(`bad key ${k}`);
const { slot, values } = await read(Object.values(keys));
const accounts = {};
Object.entries(keys).forEach(([name, address], i) => {
  const v = values[i];
  if (!v) throw new Error(`${name} ${address} is absent on mainnet`);
  accounts[name] = { address, owner: v.owner, lamports: v.lamports, executable: v.executable, data: v.data[0] };
});
writeFileSync(out, JSON.stringify({ slot, rpc, read_at: new Date().toISOString(), accounts }, null, 1));
console.log(`slot ${slot}: ${Object.keys(accounts).length} accounts -> ${out}`);
