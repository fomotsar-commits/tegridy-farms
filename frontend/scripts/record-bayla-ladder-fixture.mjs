#!/usr/bin/env node
/**
 * Records what the BAYLA lock ladder card reads from mainnet with no wallet connected:
 * the pool account and both vault balances, as the RPC answered them. Writes
 * e2e/fixtures/baylaLadderPool.ts, which em-dash-zero.spec.ts serves at /api/solrpc so
 * the card renders its read branch in CI without a network.
 *
 * Read only: three JSON-RPC reads, no key. The addresses come from scripts/addresses.json
 * by id, never typed here. Run it again when the card starts reading something else.
 *
 *   node scripts/record-bayla-ladder-fixture.mjs [rpc-url]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(FRONTEND, 'e2e', 'fixtures', 'baylaLadderPool.ts');
const RPC = process.argv[2] || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const ledger = JSON.parse(readFileSync(resolve(FRONTEND, 'scripts', 'addresses.json'), 'utf8'));
const address = (id) => {
  const hit = (ledger.solana ?? []).find((e) => e.id === id);
  if (!hit?.address) throw new Error(`[record] scripts/addresses.json has no solana entry "${id}"`);
  return hit.address;
};
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
  if (body.error || !body.result?.value) throw new Error(`[record] ${method} did not answer a value: ${JSON.stringify(body.error ?? body.result)}`);
  return body.result;
}

// The same methods and params the card's Connection sends (src/lib/ladder/read.ts).
const answers = {};
answers[`getAccountInfo:${POOL}`] = await call('getAccountInfo', [POOL, { encoding: 'base64', commitment: 'confirmed' }]);
for (const v of VAULTS) answers[`getTokenAccountBalance:${v}`] = await call('getTokenAccountBalance', [v, { commitment: 'confirmed' }]);

const slot = Math.max(...Object.values(answers).map((r) => r.context?.slot ?? 0));
const text = `// Written by scripts/record-bayla-ladder-fixture.mjs. Do not edit by hand: run it again.
// The BAYLA lock ladder as mainnet answered on ${new Date().toISOString()}, at slot ${slot}.
// Keyed "<method>:<first param>"; each value is the JSON-RPC result exactly as received.
export const BAYLA_LADDER_RECORDING = {
  pool: ${JSON.stringify(POOL)},
  slot: ${slot},
  answers: ${JSON.stringify(answers, null, 2).replace(/\n/g, '\n  ')},
} as const;
`;
writeFileSync(OUT, text, 'utf8');
console.log(`[record] wrote ${OUT} (slot ${slot})`);
