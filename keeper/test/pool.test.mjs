import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCOUNT_AMM_CONFIG, ACCOUNT_POOL_STATE, AMM_CONFIG_LEN, AMM_CONFIG_OFFSETS, POOL_STATE_LEN, POOL_STATE_OFFSETS,
  creatorFeeOnInput, decodePoolState, ownMid, ownSwap, readPool, snapshotFrom,
} from '../src/pool.js';
import { swapBaseInput } from '../../frontend/src/lib/solana/cpswap/math.ts';
import { BAYLA_MINT, POOLS, PROGRAM_ID, SOL_MINT, USDC_MINT, VENUE_VAULT } from '../src/config.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/mainnet.json', import.meta.url)));
const SITE = readFileSync(new URL('../../frontend/src/lib/solana/cpswap/program.ts', import.meta.url), 'utf8');

/** Pull `export const NAME = { a: 1, ... }` or `= Uint8Array.from([..])` or `= 637;` out of the site's source. */
function siteConst(name) {
  const m = SITE.match(new RegExp(`export const ${name} = ([^;]+);`));
  assert.ok(m, `program.ts no longer exports ${name}`);
  const body = m[1].replace(/ as const$/, '').replace(/Uint8Array\.from\((\[[^\]]*\])\)/, '$1');
  return Function(`return (${body});`)();
}

test('the layouts are the site’s own, field for field (program.ts)', () => {
  assert.deepEqual(POOL_STATE_OFFSETS, siteConst('POOL_STATE_OFFSETS'));
  assert.deepEqual(AMM_CONFIG_OFFSETS, siteConst('AMM_CONFIG_OFFSETS'));
  assert.equal(POOL_STATE_LEN, siteConst('POOL_STATE_LEN'));
  assert.equal(AMM_CONFIG_LEN, siteConst('AMM_CONFIG_LEN'));
  assert.deepEqual([...ACCOUNT_POOL_STATE], siteConst('ACCOUNT_POOL_STATE'));
  assert.deepEqual([...ACCOUNT_AMM_CONFIG], siteConst('ACCOUNT_AMM_CONFIG'));
});

const fixtureSnap = (name) => {
  const p = FIX.pools[name];
  return snapshotFrom({ address: p.addresses[0], slot: p.answer.context.slot, accounts: p.answer.value });
};

test('a recorded mainnet pool decodes to its own mints, fee tier and fee owners', () => {
  const s = fixtureSnap('BAYLA/SOL');
  assert.deepEqual([s.mint0, s.mint1].sort(), [BAYLA_MINT, SOL_MINT].sort());
  assert.equal(s.tradeFeeRate, 10_000n); // 1%
  assert.equal(s.protocolFeeRate, 160_000n); // 16% of the fee
  assert.equal(s.protocolOwner, VENUE_VAULT);
  assert.equal(s.fundOwner, VENUE_VAULT);
  const u = fixtureSnap('BAYLA/USDC');
  assert.deepEqual([u.mint0, u.mint1].sort(), [BAYLA_MINT, USDC_MINT].sort());
});

test('reserves leave out the fees the vaults owe the venue', () => {
  const p = FIX.pools['BAYLA/SOL'];
  const s = fixtureSnap('BAYLA/SOL');
  const pool = decodePoolState(Buffer.from(p.answer.value[0].data[0], 'base64'));
  const vault0 = Buffer.from(p.answer.value[2].data[0], 'base64').readBigUInt64LE(64);
  const owed0 = pool.protocolFeesToken0 + pool.fundFeesToken0 + pool.creatorFeesToken0;
  assert.ok(owed0 > 0n, 'the fixture must carry owed fees, or this test proves nothing');
  assert.equal(s.reserve0, vault0 - owed0);
});

test('a swap quote is the program’s own maths (math.ts), with the fee tier read from the chain', () => {
  const s = fixtureSnap('BAYLA/SOL');
  const solIs0 = s.mint0 === SOL_MINT;
  const r = ownSwap(s, SOL_MINT, 100_000_000n);
  const direct = swapBaseInput({
    inputAmount: 100_000_000n,
    inputVaultAmount: solIs0 ? s.reserve0 : s.reserve1,
    outputVaultAmount: solIs0 ? s.reserve1 : s.reserve0,
    tradeFeeRate: 10_000n, creatorFeeRate: 0n, protocolFeeRate: 160_000n, fundFeeRate: 0n, isCreatorFeeOnInput: true,
  });
  assert.equal(r.outputAmount, direct.outputAmount);
  assert.equal(r.protocolFee, 160_000n); // 0.16% of 0.1 SOL
  assert.equal(ownSwap(s, 'not-a-mint-of-this-pool', 1n), null);
});

test('the pool price is coin per token in whole units', () => {
  const s = { mint0: SOL_MINT, mint1: BAYLA_MINT, decimals0: 9, decimals1: 6, reserve0: 33_000_000_000n, reserve1: 5_500_000_000_000n };
  assert.ok(Math.abs(ownMid(s, BAYLA_MINT) - 33 / 5_500_000) < 1e-15);
});

test('creator-fee side follows pool.rs is_creator_fee_on_input', () => {
  assert.equal(creatorFeeOnInput(0, true), true);
  assert.equal(creatorFeeOnInput(0, false), true);
  assert.equal(creatorFeeOnInput(1, true), true);
  assert.equal(creatorFeeOnInput(1, false), false);
  assert.equal(creatorFeeOnInput(2, true), false);
  assert.equal(creatorFeeOnInput(2, false), true);
  assert.equal(creatorFeeOnInput(3, true), null);
});

test('a pool read refuses anything that is not exactly our pool', () => {
  const p = FIX.pools['BAYLA/SOL'];
  const good = p.answer.value;
  const read = (accounts) => snapshotFrom({ address: p.addresses[0], slot: 1, accounts });
  assert.ok(read(good));
  assert.throws(() => read([{ ...good[0], owner: SOL_MINT }, ...good.slice(1)]), /not owned by our pool program/);
  assert.throws(() => read([good[0], { ...good[1], owner: SOL_MINT }, good[2], good[3]]), /fee tier is not owned/);
  assert.throws(() => read([good[0], good[1], good[3], good[2]]), /vault/); // vaults swapped
  // A vault of the right token program that holds some other coin.
  const otherCoin = Buffer.from(good[2].data[0], 'base64');
  otherCoin[0] ^= 1;
  assert.throws(() => read([good[0], good[1], { ...good[2], data: [otherCoin.toString('base64'), 'base64'] }, good[3]]), /wrong coin/);
  const shortPool ={ ...good[0], data: [Buffer.from(good[0].data[0], 'base64').subarray(0, 600).toString('base64'), 'base64'] };
  assert.throws(() => read([shortPool, ...good.slice(1)]), /too short/);
  const notAPool = Buffer.from(good[0].data[0], 'base64');
  notAPool[0] ^= 1;
  assert.throws(() => read([{ ...good[0], data: [notAPool.toString('base64'), 'base64'] }, ...good.slice(1)]), /not a pool account/);
  const swapOff = Buffer.from(good[0].data[0], 'base64');
  swapOff[POOL_STATE_OFFSETS.status] |= 4;
  assert.throws(() => read([{ ...good[0], data: [swapOff.toString('base64'), 'base64'] }, ...good.slice(1)]), /switched off/);
});

test('readPool reads all four accounts in one request, at one slot', async () => {
  const p = FIX.pools['BAYLA/SOL'];
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(params[0]);
    if (params[0].length === 1) return { context: p.answer.context, value: [p.answer.value[0]] };
    return p.answer;
  };
  const cache = new Map();
  const s = await readPool(rpc, POOLS[0].address, cache);
  assert.equal(s.slot, p.answer.context.slot);
  assert.deepEqual(calls[1], p.addresses);
  await readPool(rpc, POOLS[0].address, cache);
  assert.equal(calls.length, 3, 'the second read is one request: the links are remembered');
  assert.equal(s.accounts.vault0, p.addresses[2]);
  assert.equal(PROGRAM_ID, p.answer.value[0].owner);
});
