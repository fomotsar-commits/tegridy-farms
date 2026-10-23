#!/usr/bin/env node
/**
 * Records what the BAYLA lock ladder card reads from mainnet with no wallet connected:
 * the pool account and both vault balances, as the RPC answered them. Prints
 * e2e/fixtures/baylaLadderPool.ts, which em-dash-zero.spec.ts serves at /api/solrpc so
 * the card renders its read branch in CI without a network.
 *
 * Read only: three JSON-RPC reads, no key. The addresses come from scripts/addresses.json
 * by id, never typed here. Run it again when the card starts reading something else.
 *
 *   node scripts/record-bayla-ladder-fixture.mjs [rpc-url] > e2e/fixtures/baylaLadderPool.ts
 *
 * It PRINTS the fixture and never writes a file: what lands on disk is the operator's
 * redirect (from a POSIX shell: Windows PowerShell 5.1's `>` writes UTF-16). And it prints
 * only what it has checked: the pool must be owned by the ladder program, a Pool account of
 * its size in base64 that names both vaults; each balance is a whole number in the pool's
 * decimals; every other number is a bounded whole number. Anything else stops it before a
 * byte is printed, so a refused run leaves the redirect's file empty: `git checkout` it
 * back. Only the fields the card needs are kept: what its reads use, and what
 * @solana/web3.js requires to parse an answer.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.argv[2] || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const ledger = JSON.parse(readFileSync(resolve(FRONTEND, 'scripts', 'addresses.json'), 'utf8'));
const address = (id) => {
  const hit = (ledger.solana ?? []).find((e) => e.id === id);
  if (!hit?.address) throw new Error(`[record] scripts/addresses.json has no solana entry "${id}"`);
  return hit.address;
};
const PROGRAM = address('bayla-ladder-program');
const POOL = address('bayla-ladder-pool');
const VAULTS = [address('bayla-ladder-stake-vault'), address('bayla-ladder-reward-vault')];

async function call(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`[record] ${method} answered HTTP ${res.status}`);
  const body = await res.json();
  if (body.error || !body.result?.value) throw new Error(`[record] ${method} did not answer a value${Number.isInteger(body.error?.code) ? `: error ${body.error.code}` : ''}`);
  return body.result;
}

const fail = (what) => {
  throw new Error(`[record] refusing to record: ${what}`);
};
const int = (v, what, max = Number.MAX_SAFE_INTEGER) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : fail(`${what} is not a small whole number`));
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const withSlot = (r, what) => ({ context: { slot: int(r?.context?.slot, `${what} slot`) } });

/** Read, check and print. */
async function record() {
  // The same methods and params the card's Connection sends (src/lib/ladder/read.ts).
  const answers = {};

  // The pool: program.ts POOL_SIZE bytes, Anchor's sha256("account:Pool")[0..8] first, and
  // the two vaults at POOL_LAYOUT stakeVault and rewardVault. Rebuilt from the checked parts
  // in the order the RPC sends them; `space` is dropped, as no read uses it.
  const poolAnswer = await call('getAccountInfo', [POOL, { encoding: 'base64', commitment: 'confirmed' }]);
  const acc = poolAnswer.value;
  if (acc.owner !== PROGRAM) fail('the pool is not owned by the ladder program');
  if (acc.executable !== false) fail('the pool is executable');
  const [b64, enc] = Array.isArray(acc.data) ? acc.data : [];
  if (enc !== 'base64' || typeof b64 !== 'string' || !BASE64.test(b64)) fail('the pool is not base64 data');
  const pool = Buffer.from(b64, 'base64');
  if (pool.length !== 508) fail(`the pool is ${pool.length} bytes, not 508`);
  if (!pool.subarray(0, 8).equals(createHash('sha256').update('account:Pool').digest().subarray(0, 8))) fail('the pool is not a Pool account');
  if (new PublicKey(pool.subarray(139, 171)).toBase58() !== VAULTS[0] || new PublicKey(pool.subarray(171, 203)).toBase58() !== VAULTS[1]) fail('the pool does not name the registered vaults');
  const DECIMALS = pool[74];
  // u64::MAX for a rent-exempt account, which JSON carries as 2^64.
  const rentEpoch = Number.isInteger(acc.rentEpoch) && acc.rentEpoch >= 0 && acc.rentEpoch <= 2 ** 64 ? acc.rentEpoch : fail('the pool rentEpoch is not a whole number');
  answers[`getAccountInfo:${POOL}`] = {
    ...withSlot(poolAnswer, 'the pool'),
    value: { data: [pool.toString('base64'), 'base64'], executable: false, lamports: int(acc.lamports, 'the pool lamports'), owner: PROGRAM, rentEpoch },
  };

  // Each balance: a u64 in the pool's decimals, and the ui figure the RPC derives from it.
  for (const v of VAULTS) {
    const r = await call('getTokenAccountBalance', [v, { commitment: 'confirmed' }]);
    const { amount, decimals, uiAmount } = r.value;
    if (typeof amount !== 'string' || !/^\d{1,20}$/.test(amount) || BigInt(amount) >= 2n ** 64n) fail(`the balance of ${v} is not a u64`);
    if (decimals !== DECIMALS) fail(`the balance of ${v} is not in the pool's ${DECIMALS} decimals`);
    if (uiAmount !== Number(amount) / 10 ** decimals) fail(`the balance of ${v} does not match its ui figure`);
    answers[`getTokenAccountBalance:${v}`] = { ...withSlot(r, v), value: { amount, decimals, uiAmount } };
  }

  const slot = Math.max(...Object.values(answers).map((r) => r.context?.slot ?? 0));
  const text = `// Written by scripts/record-bayla-ladder-fixture.mjs. Do not edit by hand: run it again.
// The BAYLA lock ladder as mainnet answered on ${new Date().toISOString()}, at slot ${slot}.
// Keyed "<method>:<first param>"; each value is the JSON-RPC result, checked, with the fields the card needs.
export const BAYLA_LADDER_RECORDING = {
  pool: ${JSON.stringify(POOL)},
  slot: ${slot},
  answers: ${JSON.stringify(answers, null, 2).replace(/\n/g, '\n  ')},
} as const;
`;
  process.stdout.write(text);
  console.error(`[record] printed the ladder at slot ${slot}`);
}

record().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
