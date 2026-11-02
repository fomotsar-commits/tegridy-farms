#!/usr/bin/env node
// Records the mainnet answers keeper/test/ checks against. Read-only: it asks for
// accounts and two past transactions, nothing else, through a closed method list.
//
//   node keeper/scripts/record-fixtures.mjs > keeper/test/fixtures/mainnet.json
//
// It PRINTS the fixture and never writes a file itself: what lands on disk is the
// operator's choice, made in the command above. And it prints only what it has
// checked: every account must be owned by the program it should be, with data of
// the size that program's account has, in base64; every number is a bounded
// integer; every address and signature decodes. Anything else stops it before a
// byte is printed. Only the fields the tests read are kept.

import { pathToFileURL } from 'node:url';
import { POOLS, PROGRAM_ID } from '../src/config.js';
import { decodePoolState, POOL_STATE_LEN, AMM_CONFIG_LEN } from '../src/pool.js';
import { ALT_PROGRAM } from '../src/sizecheck.js';
import { decode, isAddress } from '../src/base58.js';

const RPC = 'https://api.mainnet-beta.solana.com';
/** A Jupiter sale through pump.fun on 2026-10-16 (v0, with lookup tables). */
const TX_JUPITER = '5vcroAbAV3PzNGdrmLg4SGjRgrjgNBaCKz546GpuFZCCepPrEv3S6JRaWQnNyfFeAWyxQZpK1AdUT5gx5ah9riSn';
/** The only methods this script may call. All of them read. */
export const READ_METHODS = Object.freeze(['getMultipleAccounts', 'getAccountInfo', 'getTransaction', 'getSignaturesForAddress']);
/** Token and Token-2022, as the pools' own vault accounts name them on mainnet (read 2026-10-16). */
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

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
    if (j.error) throw new Error(`${method}: error ${Number.isInteger(j.error.code) ? j.error.code : ''}`);
    return j.result;
  }
  throw new Error(`${method}: rate limited`);
}

const fail = (what) => {
  throw new Error(`refusing to record: ${what}`);
};
const int = (v, what, max = Number.MAX_SAFE_INTEGER) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : fail(`${what} is not a small whole number`));
const address = (v, what) => (isAddress(v) ? v : fail(`${what} is not an address`));
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * An account, kept only if `owner` is one of `owners` and its data is base64 of a
 * length `sizeOk` accepts. Rebuilt from the checked parts: owner, data, lamports.
 */
function account(acc, what, owners, sizeOk) {
  if (!acc || typeof acc !== 'object') fail(`${what} is missing`);
  if (!owners.includes(acc.owner)) fail(`${what} is not owned by the program it should be`);
  const [b64, enc] = Array.isArray(acc.data) ? acc.data : [];
  if (enc !== 'base64' || typeof b64 !== 'string' || !BASE64.test(b64)) fail(`${what} is not base64 data`);
  const bytes = Buffer.from(b64, 'base64');
  if (!sizeOk(bytes.length)) fail(`${what} is ${bytes.length} bytes, not the size it should be`);
  return { owner: acc.owner, lamports: int(acc.lamports, `${what} lamports`), data: [bytes.toString('base64'), 'base64'] };
}

/** The parts of a transaction its byte length depends on, and that length: numbers and addresses only. */
async function txShape(signature) {
  const raw = await rpc('getTransaction', [signature, { encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
  const json = await rpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  const [b64] = raw?.transaction ?? [];
  if (typeof b64 !== 'string' || !BASE64.test(b64)) fail('the raw transaction is not base64');
  const m = json?.transaction?.message;
  if (!m || !Array.isArray(m.accountKeys) || !Array.isArray(m.instructions)) fail('the transaction has no message');
  const version = json.version === 'legacy' ? 'legacy' : int(json.version, 'version', 0);
  return {
    signature: decode(signature)?.length === 64 ? signature : fail('the signature does not decode'),
    version,
    bytes: int(Buffer.from(b64, 'base64').length, 'size', 1232),
    signatures: int(json.transaction.signatures?.length, 'signature count', 12),
    staticKeys: int(m.accountKeys.length, 'key count', 256),
    instructions: m.instructions.map((ix, i) => ({
      accountCount: int(ix.accounts?.length, `instruction ${i} accounts`, 256),
      dataLength: int(decode(String(ix.data))?.length, `instruction ${i} data`, 1232),
    })),
    lookups: (m.addressTableLookups ?? []).map((l, i) => {
      const w = (l.writableIndexes ?? []).map((n) => int(n, `table ${i} index`, 255));
      const r = (l.readonlyIndexes ?? []).map((n) => int(n, `table ${i} index`, 255));
      return { table: address(l.accountKey, `table ${i}`), writable: w.length, readonly: r.length, maxIndex: Math.max(...w, ...r) };
    }),
  };
}

/** Read, check and print. Runs only when this file is started, never when it is imported. */
async function record() {
  const out = { recordedAt: new Date().toISOString(), pools: {}, transactions: {} };
  for (const pool of POOLS) {
    const first = await rpc('getMultipleAccounts', [[pool.address], { encoding: 'base64', commitment: 'confirmed' }]);
    const poolAcc = account(first?.value?.[0], `${pool.name} pool`, [PROGRAM_ID], (n) => n === POOL_STATE_LEN);
    const p = decodePoolState(Buffer.from(poolAcc.data[0], 'base64'));
    const four = [pool.address, p.ammConfig, p.token0Vault, p.token1Vault].map((a, i) => address(a, `${pool.name} link ${i}`));
    const res = await rpc('getMultipleAccounts', [four, { encoding: 'base64', commitment: 'confirmed' }]);
    const v = res?.value ?? [];
    const value = [
      account(v[0], `${pool.name} pool`, [PROGRAM_ID], (n) => n === POOL_STATE_LEN),
      account(v[1], `${pool.name} fee tier`, [PROGRAM_ID], (n) => n === AMM_CONFIG_LEN),
      account(v[2], `${pool.name} vault 0`, TOKEN_PROGRAMS, (n) => n >= 165 && n <= 400),
      account(v[3], `${pool.name} vault 1`, TOKEN_PROGRAMS, (n) => n >= 165 && n <= 400),
    ];
    out.pools[pool.name] = { addresses: four, answer: { context: { slot: int(res?.context?.slot, 'slot') }, value } };
  }
  out.transactions.jupiterSale = await txShape(TX_JUPITER);
  const sigs = await rpc('getSignaturesForAddress', [POOLS[0].address, { limit: 5 }]);
  const ok = (Array.isArray(sigs) ? sigs : []).find((s) => s && !s.err && typeof s.signature === 'string');
  if (!ok) fail('no recent successful swap on BAYLA/SOL');
  out.transactions.ownPoolSwap = await txShape(ok.signature);
  // One lookup table that the Jupiter sale used, as the chain holds it now.
  const lut = out.transactions.jupiterSale.lookups[0] ?? fail('the Jupiter sale used no lookup table');
  const lutAcc = await rpc('getAccountInfo', [lut.table, { encoding: 'base64' }]);
  out.lookupTable = {
    address: lut.table,
    maxIndexUsed: lut.maxIndex,
    account: account(lutAcc?.value, 'the lookup table', [ALT_PROGRAM], (n) => n >= 56 && n <= 56 + 32 * 256 && (n - 56) % 32 === 0),
  };

  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  record().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
