#!/usr/bin/env node
/**
 * Records what /pools reads from mainnet when it loads with no wallet and no token
 * typed: the pool program and its ProgramData, both fee tiers (AmmConfig index 0 and 1),
 * the fee account for openings, the network's genesis hash and the rents the fee-tier
 * card quotes. Prints src/lib/solana/cpswap/mainnetVenue.fixture.ts, which
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
 *   node scripts/record-pools-venue-fixture.mjs [rpc-url] > src/lib/solana/cpswap/mainnetVenue.fixture.ts
 *
 * It PRINTS the fixture and never writes a file: what lands on disk is the operator's
 * redirect (from a POSIX shell: Windows PowerShell 5.1's `>` writes UTF-16). And it prints
 * only what it has checked: every account must be owned by the program it should be, with
 * data of that account's size in base64; every number is a bounded whole number; every
 * address and hash decodes. Anything else stops it before a byte is printed, so a refused
 * run leaves the redirect's file empty: `git checkout` it back. Only the fields the page
 * needs are kept: what its reads use, and what @solana/web3.js requires to parse an answer.
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
const PROGRAM = new PublicKey(address('cp-swap-program-restart'));
const FEE_RECEIVER = address('cpswap-fee-receiver-wsol-ata');
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

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
  if (body.error || !('result' in body)) throw new Error(`[record] ${method} did not answer${Number.isInteger(body.error?.code) ? `: error ${body.error.code}` : ''}`);
  return body.result;
}

const fail = (what) => {
  throw new Error(`[record] refusing to record: ${what}`);
};
const int = (v, what, max = Number.MAX_SAFE_INTEGER) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : fail(`${what} is not a small whole number`));
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** 32 bytes in canonical base58, as an address or a hash is. */
const isHash = (s) => {
  try {
    return typeof s === 'string' && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
};
// sha256("account:<Name>")[0..8], Anchor's account discriminator (program.ts ACCOUNT_AMM_CONFIG).
const discriminator = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

/**
 * One account answer, kept only if its owner and executable flag are the ones given and
 * its data is base64 of bytes `bytesOk` accepts: the size, and the tag or discriminator
 * that says what the account is. Rebuilt from the checked parts, in
 * the order the RPC sends them; `space` is dropped, as no read uses it.
 */
function checkedAccount(acc, what, { owner, executable = false, bytesOk }) {
  if (!acc || typeof acc !== 'object') fail(`${what} is missing`);
  if (acc.owner !== owner) fail(`${what} is not owned by the program it should be`);
  if (acc.executable !== executable) fail(`${what} is ${executable ? 'not ' : ''}executable`);
  const [b64, enc] = Array.isArray(acc.data) ? acc.data : [];
  if (enc !== 'base64' || typeof b64 !== 'string' || !BASE64.test(b64)) fail(`${what} is not base64 data`);
  const bytes = Buffer.from(b64, 'base64');
  if (!bytesOk(bytes)) fail(`${what} is not the account it should be (${bytes.length} bytes)`);
  // u64::MAX for a rent-exempt account, which JSON carries as 2^64.
  const rentEpoch = Number.isInteger(acc.rentEpoch) && acc.rentEpoch >= 0 && acc.rentEpoch <= 2 ** 64 ? acc.rentEpoch : fail(`${what} rentEpoch is not a whole number`);
  return { data: [bytes.toString('base64'), 'base64'], executable, lamports: int(acc.lamports, `${what} lamports`), owner, rentEpoch };
}
const withSlot = (r, what) => ({ context: { slot: int(r?.context?.slot, `${what} slot`) } });
const account = async (key, what, expect, extra = {}) => {
  const r = await call('getAccountInfo', [key, { encoding: 'base64', commitment: 'confirmed', ...extra }]);
  if (!r?.value) fail(`there is no account at ${key}`);
  return { ...withSlot(r, what), value: checkedAccount(r.value, what, expect) };
};

const isTier = (b) => b.length === 236 && b.subarray(0, 8).equals(discriminator('AmmConfig'));
const TIER = { owner: PROGRAM.toBase58(), bytesOk: isTier };

/** Read, check and print. */
async function record() {
  // The same methods the page sends (PoolsPage readVenue, the fee-tier card's readFeeTiers,
  // the LP gate's readLpGate and the open-a-pool card's readCreateFacts), keyed the way the
  // spec keys a request: "<method>:<first param>".
  const answers = {};
  // The upgradeable loader's Program stub: a u32 tag (2), then the ProgramData address,
  // which must be the loader's PDA of the program.
  const PROGRAM_DATA = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey(LOADER))[0].toBase58();
  const isStub = (b) => b.length === 36 && b.readUInt32LE(0) === 2 && new PublicKey(b.subarray(4, 36)).toBase58() === PROGRAM_DATA;
  answers[`getAccountInfo:${PROGRAM.toBase58()}`] = await account(PROGRAM.toBase58(), 'the program', { owner: LOADER, executable: true, bytesOk: isStub });
  // ProgramData's header, a u32 tag (3) first, through the 45-byte slice.
  const isProgramData = (b) => b.length === 45 && b.readUInt32LE(0) === 3;
  answers[`getAccountInfo:${PROGRAM_DATA}`] = await account(PROGRAM_DATA, 'ProgramData', { owner: LOADER, bytesOk: isProgramData }, { dataSlice: { offset: 0, length: 45 } });
  answers[`getAccountInfo:${TIER0}`] = await account(TIER0, 'fee tier 0', TIER);
  answers[`getAccountInfo:${TIER1}`] = await account(TIER1, 'fee tier 1', TIER);
  // A classic token account of wrapped SOL: the mint is its first 32 bytes.
  const isWsolAccount = (b) => b.length === 165 && new PublicKey(b.subarray(0, 32)).toBase58() === 'So11111111111111111111111111111111111111112';
  answers[`getAccountInfo:${FEE_RECEIVER}`] = await account(FEE_RECEIVER, 'the fee account', { owner: TOKEN_PROGRAM, bytesOk: isWsolAccount });
  const both = await call('getMultipleAccounts', [[TIER0, TIER1], { encoding: 'base64', commitment: 'confirmed' }]);
  if (!Array.isArray(both?.value) || both.value.length !== 2) fail('getMultipleAccounts did not answer both fee tiers');
  answers[`getMultipleAccounts:${[TIER0, TIER1]}`] = { ...withSlot(both, 'both tiers'), value: both.value.map((a, i) => checkedAccount(a, `fee tier ${i}`, TIER)) };
  // poolFinder.ts NEVER_REFUNDED_ACCOUNT_SIZES, once each.
  for (const n of [637, 4075, 82, 165]) answers[`getMinimumBalanceForRentExemption:${n}`] = int(await call('getMinimumBalanceForRentExemption', [n]), `rent for ${n} bytes`);
  const genesis = await call('getGenesisHash', []);
  answers['getGenesisHash:undefined'] = isHash(genesis) ? genesis : fail('the genesis hash does not decode');

  const slot = Math.max(...Object.values(answers).map((r) => (typeof r === 'object' && r?.context?.slot) || 0));
  const text = `// Written by scripts/record-pools-venue-fixture.mjs. Do not edit by hand: run it again.
// What /pools reads on load, as mainnet answered on ${new Date().toISOString()}, at slot ${slot}.
// Keyed "<method>:<first param>"; each value is the JSON-RPC result, checked, with the fields
// the page needs (ProgramData through a 45-byte dataSlice: the probe reads only that it exists).
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
  process.stdout.write(text);
  console.error(`[record] printed the venue at slot ${slot}`);
}

record().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
