#!/usr/bin/env node
// Records the mainnet answers keeper/test/ checks against. Read-only: it asks for
// accounts and two past transactions, nothing else, through a closed method list.
//
//   node keeper/scripts/record-fixtures.mjs
//
// Writes keeper/test/fixtures/mainnet.json. Do not edit that file by hand: run this again.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POOLS } from '../src/config.js';
import { decodePoolState } from '../src/pool.js';
import { decode } from '../src/base58.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = 'https://api.mainnet-beta.solana.com';
/** A Jupiter sale through pump.fun on 2026-10-16 (v0, with lookup tables). */
const TX_JUPITER = '5vcroAbAV3PzNGdrmLg4SGjRgrjgNBaCKz546GpuFZCCepPrEv3S6JRaWQnNyfFeAWyxQZpK1AdUT5gx5ah9riSn';
/** The only methods this script may call. All of them read. */
export const READ_METHODS = Object.freeze(['getMultipleAccounts', 'getAccountInfo', 'getTransaction', 'getSignaturesForAddress']);

let id = 0;
async function rpc(method, params) {
  if (!READ_METHODS.includes(method)) throw new Error(`the recorder does not call ${method}`);
  for (let a = 0; a < 4; a++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(`${method}: error ${j.error.code}`);
    return j.result;
  }
  throw new Error(`${method}: rate limited`);
}

/** The parts of a transaction its byte length depends on, and that length. */
async function txShape(signature) {
  const raw = await rpc('getTransaction', [signature, { encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
  const json = await rpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  const m = json.transaction.message;
  return {
    signature,
    version: json.version,
    bytes: Buffer.from(raw.transaction[0], 'base64').length,
    signatures: json.transaction.signatures.length,
    staticKeys: m.accountKeys.length,
    instructions: m.instructions.map((ix) => ({ accountCount: ix.accounts.length, dataLength: decode(ix.data).length })),
    lookups: (m.addressTableLookups ?? []).map((l) => ({ table: l.accountKey, writable: l.writableIndexes.length, readonly: l.readonlyIndexes.length, maxIndex: Math.max(...l.writableIndexes, ...l.readonlyIndexes) })),
  };
}

const out = { recordedAt: new Date().toISOString(), pools: {}, transactions: {} };
for (const pool of POOLS) {
  const first = await rpc('getMultipleAccounts', [[pool.address], { encoding: 'base64', commitment: 'confirmed' }]);
  const p = decodePoolState(Buffer.from(first.value[0].data[0], 'base64'));
  const four = [pool.address, p.ammConfig, p.token0Vault, p.token1Vault];
  const res = await rpc('getMultipleAccounts', [four, { encoding: 'base64', commitment: 'confirmed' }]);
  out.pools[pool.name] = { addresses: four, answer: { context: { slot: res.context.slot }, value: res.value } };
}
out.transactions.jupiterSale = await txShape(TX_JUPITER);
const sigs = await rpc('getSignaturesForAddress', [POOLS[0].address, { limit: 5 }]);
const ok = sigs.find((s) => !s.err);
out.transactions.ownPoolSwap = await txShape(ok.signature);
// One lookup table that the Jupiter sale used, as the chain holds it now.
const lut = out.transactions.jupiterSale.lookups[0];
const lutAcc = await rpc('getAccountInfo', [lut.table, { encoding: 'base64' }]);
out.lookupTable = { address: lut.table, maxIndexUsed: lut.maxIndex, account: lutAcc.value };

const file = join(HERE, '..', 'test', 'fixtures', 'mainnet.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${file}`);
