#!/usr/bin/env node
/**
 * Records what /pools reads from mainnet when it loads with no wallet and no token
 * typed: the pool program and its ProgramData, both fee tiers (AmmConfig index 0 and 1),
 * the fee account for openings, the network's genesis hash and the rents the fee-tier
 * card quotes. Writes src/lib/solana/cpswap/mainnetVenue.fixture.ts, which
 *   - the unit tests decode through the repo's own read path (readVenue, readFeeTiers),
 *     so every fee figure a test checks is one mainnet returned, and
 *   - em-dash-zero.spec.ts serves at /api/solrpc, so /pools renders its live branch in
 *     CI with no network.
 *
 * Read only: plain JSON-RPC reads, no key. The program id comes from
 * scripts/addresses.json by id, never typed here; every other address is derived from
 * it the way src/lib/solana/cpswap/program.ts derives it.
 *
 * ProgramData is read with a 45-byte dataSlice: the deployment probe reads only that the
 * account exists and holds lamports, and the full account is the 690 KB program.
 *
 *   node scripts/record-pools-venue-fixture.mjs [rpc-url]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(FRONTEND, 'src', 'lib', 'solana', 'cpswap', 'mainnetVenue.fixture.ts');
const RPC = process.argv[2] || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const ledger = JSON.parse(readFileSync(resolve(FRONTEND, 'scripts', 'addresses.json'), 'utf8'));
const address = (id) => {
  const hit = (ledger.solana ?? []).find((e) => e.id === id);
  if (!hit?.address) throw new Error(`[record] scripts/addresses.json has no solana entry "${id}"`);
  return hit.address;
};
const PROGRAM = new PublicKey(address('cp-swap-program-restart'));
const FEE_RECEIVER = address('cpswap-fee-receiver-wsol-ata');

// program.ts deriveAmmConfig: ["amm_config", index as a BIG-endian u16].
const ammConfig = (index) => {
  const be = Buffer.alloc(2);
  be.writeUInt16BE(index, 0);
  return PublicKey.findProgramAddressSync([Buffer.from('amm_config'), be], PROGRAM)[0].toBase58();
};
const TIER0 = ammConfig(0);
const TIER1 = ammConfig(1);

let id = 0;
async function call(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (!res.ok) throw new Error(`[record] ${method} answered HTTP ${res.status}`);
  const body = await res.json();
  if (body.error || !('result' in body)) throw new Error(`[record] ${method} did not answer: ${JSON.stringify(body.error ?? body)}`);
  return body.result;
}
const account = async (key, extra = {}) => {
  const r = await call('getAccountInfo', [key, { encoding: 'base64', commitment: 'confirmed', ...extra }]);
  if (!r?.value) throw new Error(`[record] there is no account at ${key}`);
  return r;
};

// The same methods the page sends (PoolsPage readVenue, the fee-tier card's readFeeTiers,
// the LP gate's readLpGate and the open-a-pool card's readCreateFacts), keyed the way the
// spec keys a request: "<method>:<first param>".
const answers = {};
const program = await account(PROGRAM.toBase58());
answers[`getAccountInfo:${PROGRAM.toBase58()}`] = program;
// The upgradeable loader's Program stub: a u32 tag (2), then the ProgramData address.
const stub = Buffer.from(program.value.data[0], 'base64');
if (stub.length < 36 || stub.readUInt32LE(0) !== 2) throw new Error('[record] the program account is not an upgradeable Program stub');
const PROGRAM_DATA = new PublicKey(stub.subarray(4, 36)).toBase58();
answers[`getAccountInfo:${PROGRAM_DATA}`] = await account(PROGRAM_DATA, { dataSlice: { offset: 0, length: 45 } });
answers[`getAccountInfo:${TIER0}`] = await account(TIER0);
answers[`getAccountInfo:${TIER1}`] = await account(TIER1);
answers[`getAccountInfo:${FEE_RECEIVER}`] = await account(FEE_RECEIVER);
answers[`getMultipleAccounts:${[TIER0, TIER1]}`] = await call('getMultipleAccounts', [[TIER0, TIER1], { encoding: 'base64', commitment: 'confirmed' }]);
// poolFinder.ts NEVER_REFUNDED_ACCOUNT_SIZES, once each.
for (const n of [637, 4075, 82, 165]) answers[`getMinimumBalanceForRentExemption:${n}`] = await call('getMinimumBalanceForRentExemption', [n]);
answers['getGenesisHash:undefined'] = await call('getGenesisHash', []);

const slot = Math.max(...Object.values(answers).map((r) => (typeof r === 'object' && r?.context?.slot) || 0));
const text = `// Written by scripts/record-pools-venue-fixture.mjs. Do not edit by hand: run it again.
// What /pools reads on load, as mainnet answered on ${new Date().toISOString()}, at slot ${slot}.
// Keyed "<method>:<first param>"; each value is the JSON-RPC result exactly as received
// (ProgramData through a 45-byte dataSlice: the probe reads only that it exists).
export const MAINNET_VENUE_RECORDING = {
  slot: ${slot},
  program: ${JSON.stringify(PROGRAM.toBase58())},
  programData: ${JSON.stringify(PROGRAM_DATA)},
  tier0: ${JSON.stringify(TIER0)},
  tier1: ${JSON.stringify(TIER1)},
  feeReceiver: ${JSON.stringify(FEE_RECEIVER)},
  answers: ${JSON.stringify(answers, null, 2).replace(/\n/g, '\n  ')},
} as const;
`;
writeFileSync(OUT, text, 'utf8');
console.log(`[record] wrote ${OUT} (slot ${slot})`);
