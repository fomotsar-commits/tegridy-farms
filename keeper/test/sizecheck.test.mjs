import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atasNamedBy, decodeLookupTable, sizeCheck, ATA_PROGRAM, ALT_PROGRAM } from '../src/sizecheck.js';
import { snapshotFrom } from '../src/pool.js';
import { venueNames } from '../src/jupiter.js';
import { decode, encode } from '../src/base58.js';
import { BAYLA_MINT, JITO_TIP_ACCOUNT, POOLS, PUMP_AMM_PROGRAM, PUMP_BAYLA_POOL, SOL_MINT } from '../src/config.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/mainnet.json', import.meta.url)));
const NAMES = venueNames({ [PUMP_AMM_PROGRAM]: 'Pump.fun Amm', CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM' });
const TAKER = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'; // any valid address standing in for a wallet
const addr = (i) => encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7 + 1) % 256));

test('a real mainnet lookup table decodes to its addresses', () => {
  const t = FIX.lookupTable;
  const list = decodeLookupTable(t.account);
  assert.ok(list, 'the recorded table must decode');
  assert.ok(list.length > t.maxIndexUsed, `holds ${list.length}, a real transaction used index ${t.maxIndexUsed}`);
  assert.equal(decodeLookupTable({ ...t.account, owner: SOL_MINT }), null, 'an account the lookup-table program does not own is no table');
  const retired = Buffer.from(t.account.data[0], 'base64');
  retired.writeBigUInt64LE(123n, 4);
  assert.equal(decodeLookupTable({ ...t.account, data: [retired.toString('base64'), 'base64'] }), null, 'a table being retired cannot be used');
});

test('a token account Jupiter names is used only if it is created for the taker, by the taker, and is not ours', () => {
  const ix = (payer, account, owner, mint) => ({ programId: ATA_PROGRAM, accounts: [payer, account, owner, mint, addr(90), addr(91)].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), dataLength: 1 });
  const ours = new Set([POOLS[0].address]);
  const m = atasNamedBy([
    ix(TAKER, addr(1), TAKER, SOL_MINT),
    ix(addr(9), addr(2), TAKER, BAYLA_MINT), // someone else pays
    ix(TAKER, POOLS[0].address, TAKER, 'mint-x'), // claims one of our accounts
  ], TAKER, ours);
  assert.deepEqual([...m], [[SOL_MINT, addr(1)]]);
});

test('the size is measured with the tables the chain holds, not the ones Jupiter claims', async () => {
  const p = FIX.pools['BAYLA/SOL'];
  const snap = snapshotFrom({ address: p.addresses[0], slot: 1, accounts: p.answer.value });
  snap.accounts.vault0 = p.addresses[2];
  snap.accounts.vault1 = p.addresses[3];
  const ourAccounts = [snap.address, snap.accounts.ammConfig, snap.accounts.authority, snap.accounts.vault0, snap.accounts.vault1, snap.accounts.observation];
  const routeAccounts = Array.from({ length: 20 }, (_, i) => addr(10 + i));
  const TABLE = addr(200);
  const jupiter = {
    build: async () => ({
      out: 1n,
      steps: [{ ammKey: PUMP_BAYLA_POOL, label: 'Pump.fun Amm' }],
      instructions: [{ programId: PUMP_AMM_PROGRAM, accounts: routeAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), dataLength: 24 }],
      // Jupiter claims its table also holds our pool's accounts.
      lookupTables: { [TABLE]: [...routeAccounts, ...ourAccounts] },
    }),
  };
  const tableOnChain = (addresses) => {
    const d = Buffer.alloc(56 + 32 * addresses.length);
    d.writeUInt32LE(1, 0);
    d.writeBigUInt64LE(0xffffffffffffffffn, 4);
    addresses.forEach((a, i) => Buffer.from(decode(a)).copy(d, 56 + 32 * i));
    return { owner: ALT_PROGRAM, data: [d.toString('base64'), 'base64'] };
  };
  const record = { direction: 'buy-here-sell-outside', legs: [{ where: 'our pool', in: 1, out: 10 }, { where: 'pump.fun', in: 10, out: 1 }] };
  const run = (chainList) => sizeCheck({
    jupiter, names: NAMES, pool: POOLS[0], snap, record, taker: TAKER, ownPools: [],
    rpc: async () => ({ value: [tableOnChain(chainList)] }),
  });
  const honest = await run(routeAccounts); // the chain's table holds only the route's accounts
  const trusting = await run([...routeAccounts, ...ourAccounts]); // what Jupiter claimed
  assert.ok(honest.bytes > trusting.bytes, `measured ${honest.bytes} with the chain's table, ${trusting.bytes} if Jupiter were believed`);
  assert.equal(honest.tablesNamed, 1);
  assert.equal(honest.tablesOnChain, 1);
  const missing = await sizeCheck({ jupiter, names: NAMES, pool: POOLS[0], snap, record, taker: TAKER, ownPools: [], rpc: async () => ({ value: [null] }) });
  assert.equal(missing.tablesOnChain, 0, 'a table the chain does not have counts as none');
  assert.ok(missing.bytes > honest.bytes);
});

test('Jupiter is asked for no tip; the keeper’s own Jito tip transfer is in what is measured', async () => {
  const p = FIX.pools['BAYLA/SOL'];
  const snap = snapshotFrom({ address: p.addresses[0], slot: 1, accounts: p.answer.value });
  snap.accounts.vault0 = p.addresses[2];
  snap.accounts.vault1 = p.addresses[3];
  const routeAccounts = Array.from({ length: 20 }, (_, i) => addr(10 + i));
  const TABLE = addr(200);
  const asked = [];
  const jupiter = {
    build: async (a) => {
      asked.push(a);
      return {
        out: 1n,
        steps: [{ ammKey: PUMP_BAYLA_POOL, label: 'Pump.fun Amm' }],
        instructions: [{ programId: PUMP_AMM_PROGRAM, accounts: routeAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), dataLength: 24 }],
        lookupTables: { [TABLE]: [...routeAccounts, JITO_TIP_ACCOUNT] },
      };
    },
  };
  const table = (addresses) => {
    const d = Buffer.alloc(56 + 32 * addresses.length);
    d.writeUInt32LE(1, 0);
    d.writeBigUInt64LE(0xffffffffffffffffn, 4);
    addresses.forEach((a, i) => Buffer.from(decode(a)).copy(d, 56 + 32 * i));
    return { owner: ALT_PROGRAM, data: [d.toString('base64'), 'base64'] };
  };
  const record = { direction: 'buy-here-sell-outside', legs: [{ where: 'our pool', in: 1, out: 10 }, { where: 'pump.fun', in: 10, out: 1 }] };
  const run = (chainList) => sizeCheck({ jupiter, names: NAMES, pool: POOLS[0], snap, record, taker: TAKER, ownPools: [], rpc: async () => ({ value: [table(chainList)] }) });
  const tipStatic = await run(routeAccounts);
  const tipInTable = await run([...routeAccounts, JITO_TIP_ACCOUNT]);
  // The tip account costs a full key unless a table holds it: so the tip transfer is measured.
  assert.equal(tipStatic.bytes - tipInTable.bytes, 31);
  assert.ok(asked.length > 0 && asked.every((a) => !a.tipLamports), 'no tip is ever asked of Jupiter');
});
