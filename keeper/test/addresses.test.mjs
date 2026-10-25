// Every address the keeper names, decoded rather than eyeballed: a mistyped
// address looks exactly like a right one, and only decoding tells them apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../src/config.js';
import { ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM } from '../src/sizecheck.js';
import { decode, encode, isAddress } from '../src/base58.js';

test('every address in config.js and sizecheck.js is 32 bytes that re-encode to the same text', () => {
  const named = {
    PROGRAM_ID: C.PROGRAM_ID,
    VENUE_VAULT: C.VENUE_VAULT,
    ISLAND_WORKSHOP: C.ISLAND_WORKSHOP,
    PROFIT_TO: C.PROFIT_TO,
    PROFIT_TO_USDC: C.PROFIT_TO_USDC,
    JITO_TIP_ACCOUNT: C.JITO_TIP_ACCOUNT,
    ...Object.fromEntries(Object.keys(C.AGREED_TIERS).map((a) => [`AGREED_TIERS ${a}`, a])),
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

test('the vault, the Workshop and the profit address are the site’s own, and profit goes to the treasury', () => {
  // Read as text: the site's modules import @solana/web3.js, and the keeper loads no package.
  const site = (path, name) => {
    const src = readFileSync(new URL(`../../frontend/src/${path}`, import.meta.url), 'utf8');
    const m = src.match(new RegExp(`export const ${name} = new PublicKey\\('([1-9A-HJ-NP-Za-km-z]{32,44})'\\)`));
    assert.ok(m, `${name} not found in ${path}`);
    return m[1];
  };
  assert.equal(C.VENUE_VAULT, site('lib/launcher/solana/curve/program.ts', 'PLATFORM_TREASURY_VAULT'));
  assert.equal(C.ISLAND_WORKSHOP, site('lib/launcher/solana/write/plant.ts', 'WORKSHOP_WALLET'));
  // Owner, 2026-10-25: a live correction's profit goes to the treasury, not to LPs or the keeper.
  assert.equal(C.PROFIT_TO, C.VENUE_VAULT);
  assert.notEqual(C.ISLAND_WORKSHOP, C.VENUE_VAULT);
  // The vault's USDC account and the pools' fee settings, as the site's address registry records them.
  const registry = JSON.parse(readFileSync(new URL('../../frontend/scripts/addresses.json', import.meta.url), 'utf8'));
  const entries = JSON.stringify(registry);
  const idOf = (address) => entries.match(new RegExp(`"id":"([^"]+)","address":"${address}"`))?.[1];
  assert.equal(idOf(C.PROFIT_TO_USDC), 'squads-vault-usdc-ata');
  assert.deepEqual(Object.keys(C.AGREED_TIERS).map(idOf), ['cp-swap-amm-config-public-restart']);
  // Every pool the keeper watches is on agreed fee settings at the agreed split (10.4% / 5.6% of the 1%).
  for (const t of Object.values(C.AGREED_TIERS)) assert.deepEqual(t, { tradeFeeRate: 10_000n, protocolFeeRate: 104_000n, fundFeeRate: 56_000n });
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
