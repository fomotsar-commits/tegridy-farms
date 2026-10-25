// The process's settings are checked before anything starts, and no secret reaches a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger, readSettings, type Settings } from '../src/main.ts';

const GOOD: Settings = {
  network: 1,
  deployment: {
    authenPolicy: '11'.repeat(28),
    poolScriptHash: '22'.repeat(28),
    orderScriptHash: '33'.repeat(28),
    poolBatchingScriptHash: '44'.repeat(28),
    scriptRefs: { pool: `${'aa'.repeat(32)}#0`, order: `${'aa'.repeat(32)}#1`, poolBatching: `${'aa'.repeat(32)}#2` },
  },
  batcherKeyHash: '55'.repeat(28),
  batcherAddress: 'addr1v9dhugez3ka82k2kgh7r2lg0j7aztr8uell46kydfwu3vkc8dnqfk',
  batcherFee: '2000000',
  floatCap: '100000000',
  maxOrdersPerBatch: 25,
  slotsBefore: 60,
  slotsAfter: 240,
  quarantineSlots: 3600,
  maxRefusalsInARow: 5,
  idleRoundMs: 60000,
};

function read(s: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-settings-'));
  try {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify(s));
    return readSettings(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('good settings are read into exact amounts', () => {
  const c = read(GOOD);
  assert.equal(c.policy.batcherFee, 2_000_000n);
  assert.equal(c.floatCap, 100_000_000n);
  assert.equal(c.deployment.dex.poolScriptHash, '22'.repeat(28));
});

test('settings that would make a wrong batch are refused before anything starts', () => {
  assert.throws(() => read({ ...GOOD, batcherKeyHash: 'xyz' }), /batcherKeyHash is not a 28-byte hash/);
  assert.throws(() => read({ ...GOOD, deployment: { ...GOOD.deployment, orderScriptHash: '33'.repeat(27) } }), /orderScriptHash/);
  assert.throws(() => read({ ...GOOD, deployment: { ...GOOD.deployment, scriptRefs: { ...GOOD.deployment.scriptRefs, pool: 'aa#0' } } }), /scriptRefs.pool/);
  assert.throws(() => read({ ...GOOD, slotsBefore: 300, slotsAfter: 301 }), /at most 600 slots/);
  assert.throws(() => read({ ...GOOD, network: 0 }), /only mainnet/);
});

test('no log line carries a host that holds a key, or the Koios token', () => {
  const lines: string[] = [];
  const env = {
    OGMIOS_URL: 'https://dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run',
    OGMIOS_WS: 'wss://dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run',
    KUPO_URL: 'https://dmtr_kupo1secretsecret.mainnet-v2.kupo-m1.demeter.run',
    KOIOS_TOKEN: 'eyJhbGciOiJIUzI1NiJ9.koios-token',
  };
  const log = logger(env, (l) => lines.push(l));
  log({ kind: 'error', error: 'getaddrinfo ENOTFOUND dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run', more: 'dmtr_kupo1secretsecret.mainnet-v2.kupo-m1.demeter.run', token: 'Bearer eyJhbGciOiJIUzI1NiJ9.koios-token', amount: 9_223_372_036_854_775_807n });
  assert.equal(lines.length, 1);
  assert.ok(!/secretsecret|koios-token/.test(lines[0]!), lines[0]);
  assert.match(lines[0]!, /9223372036854775807/);
  assert.ok(lines[0]!.endsWith('\n'));
});
