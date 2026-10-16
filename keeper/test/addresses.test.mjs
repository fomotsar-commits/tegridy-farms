// Every address the keeper names, decoded rather than eyeballed: a mistyped
// address looks exactly like a right one, and only decoding tells them apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM } from '../src/sizecheck.js';
import { decode, encode, isAddress } from '../src/base58.js';

test('every address in config.js and sizecheck.js is 32 bytes that re-encode to the same text', () => {
  const named = {
    PROGRAM_ID: C.PROGRAM_ID,
    VENUE_VAULT: C.VENUE_VAULT,
    SOL_MINT: C.SOL_MINT,
    USDC_MINT: C.USDC_MINT,
    BAYLA_MINT: C.BAYLA_MINT,
    PUMP_AMM_PROGRAM: C.PUMP_AMM_PROGRAM,
    PUMP_BAYLA_POOL: C.PUMP_BAYLA_POOL,
    ATA_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    SYSTEM_PROGRAM,
    ...Object.fromEntries(C.POOLS.map((p) => [p.name, p.address])),
  };
  for (const [name, a] of Object.entries(named)) assert.ok(isAddress(a), `${name} = ${a} is not a Solana address`);
  // Every exported string that looks like an address is in the list above.
  const exported = Object.entries(C).filter(([, v]) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v));
  for (const [k, v] of exported) assert.ok(Object.values(named).includes(v), `${k} is not checked here`);
});

test('the base58 codec round-trips and refuses what is not an address', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
  assert.deepEqual(decode(encode(bytes)), bytes);
  assert.equal(encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(isAddress('11111111111111111111111111111111'), true);
  assert.equal(isAddress('0OIl' + 'a'.repeat(40)), false);
  assert.equal(isAddress(C.PROGRAM_ID.slice(0, 40)), false, 'a cut-short address is not an address');
  assert.equal(isAddress(C.PROGRAM_ID + '1'), false);
});
