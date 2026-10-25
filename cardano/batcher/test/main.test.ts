// The process's settings are checked before anything starts (every one required, in range, and
// the batcher's address its own key's), and no secret reaches a log line or an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { HEARTBEAT, logger, makeKeyIfAsked, readEnv, readSettings, type Settings } from '../src/main.ts';

const KEY = '55'.repeat(28);
const enterprise = (network: number, key: string) => CSL.EnterpriseAddress.new(network, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(key))).to_address().to_bech32(undefined);
const GOOD: Settings = {
  network: 1,
  deployment: {
    authenPolicy: '11'.repeat(28),
    poolScriptHash: '22'.repeat(28),
    orderScriptHash: '33'.repeat(28),
    poolBatchingScriptHash: '44'.repeat(28),
    scriptRefs: { pool: `${'aa'.repeat(32)}#0`, order: `${'aa'.repeat(32)}#1`, poolBatching: `${'aa'.repeat(32)}#2` },
  },
  batcherKeyHash: KEY,
  batcherAddress: enterprise(1, KEY),
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
  assert.equal(c.batcher.address, GOOD.batcherAddress);
});

test('the batcher’s change can only go to its own key’s enterprise address on mainnet', () => {
  const stranger = enterprise(1, '66'.repeat(28));
  const testnet = enterprise(0, KEY);
  const withStake = CSL.BaseAddress.new(1, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(KEY)), CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('77'.repeat(28)))).to_address().to_bech32(undefined);
  for (const batcherAddress of [stranger, testnet, withStake, 'addr1notanaddress', '']) assert.throws(() => read({ ...GOOD, batcherAddress }), /batcherAddress is not the batcher key's own/, batcherAddress);
});

test('settings that would make a wrong batch, or turn a safety off, are refused before anything starts', () => {
  assert.throws(() => read({ ...GOOD, batcherKeyHash: 'xyz' }), /batcherKeyHash is not a 28-byte hash/);
  assert.throws(() => read({ ...GOOD, deployment: { ...GOOD.deployment, orderScriptHash: '33'.repeat(27) } }), /orderScriptHash/);
  assert.throws(() => read({ ...GOOD, deployment: { ...GOOD.deployment, scriptRefs: { ...GOOD.deployment.scriptRefs, pool: 'aa#0' } } }), /scriptRefs.pool/);
  assert.throws(() => read({ ...GOOD, slotsBefore: 300, slotsAfter: 301 }), /at most 600 slots/);
  assert.throws(() => read({ ...GOOD, network: 0 }), /only mainnet/);
  const bad: [Partial<Record<keyof Settings, unknown>>, RegExp][] = [
    [{ maxRefusalsInARow: undefined }, /maxRefusalsInARow/],
    [{ maxRefusalsInARow: 0 }, /maxRefusalsInARow/],
    [{ idleRoundMs: undefined }, /idleRoundMs/],
    [{ idleRoundMs: 0 }, /idleRoundMs/],
    [{ slotsBefore: -100 }, /slotsBefore/],
    [{ slotsAfter: 0 }, /slotsAfter/],
    [{ quarantineSlots: 0 }, /quarantineSlots/],
    [{ maxOrdersPerBatch: 0 }, /maxOrdersPerBatch/],
    [{ maxOrdersPerBatch: 65 }, /maxOrdersPerBatch/],
    [{ maxOrdersPerBatch: 2.5 }, /maxOrdersPerBatch/],
    [{ batcherFee: '0' }, /batcherFee/],
    [{ batcherFee: '-1' }, /batcherFee/],
    [{ batcherFee: 2000000 }, /batcherFee/],
    [{ floatCap: undefined }, /floatCap/],
  ];
  for (const [change, why] of bad) assert.throws(() => read({ ...GOOD, ...change }), why, JSON.stringify(change));
});

test('no log line carries a host that holds a key, the chain-sync host, a malformed endpoint, or the Koios token', () => {
  const lines: string[] = [];
  const env = {
    OGMIOS_URL: 'https://dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run',
    OGMIOS_WS: 'wss://dmtr_ogmios1othersecret.mainnet-v6.ogmios-m1.demeter.run',
    KUPO_URL: '"https://dmtr_kupo1quotedsecret.mainnet-v2.kupo-m1.demeter.run"',
    KOIOS_TOKEN: 'eyJhbGciOiJIUzI1NiJ9.koios-token',
  };
  const log = logger(env, (l) => lines.push(l));
  // A value that is no URL at all (pasted without its scheme) is scrubbed whole.
  const bare: string[] = [];
  logger({ OGMIOS_URL: 'dmtr_ogmios1barevaluesecret' }, (l) => bare.push(l))({ kind: 'error', error: 'connect to dmtr_ogmios1barevaluesecret failed' });
  assert.ok(!bare[0]!.includes('barevaluesecret'), bare[0]);
  log({ kind: 'error', error: 'getaddrinfo ENOTFOUND dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run', ws: 'dmtr_ogmios1othersecret.mainnet-v6.ogmios-m1.demeter.run', more: env.KUPO_URL, token: 'Bearer eyJhbGciOiJIUzI1NiJ9.koios-token', amount: 9_223_372_036_854_775_807n });
  assert.equal(lines.length, 1);
  assert.ok(!/secretsecret|othersecret|quotedsecret|koios-token/.test(lines[0]!), lines[0]);
  assert.match(lines[0]!, /9223372036854775807/);
  assert.ok(lines[0]!.endsWith('\n'));
});

test('a malformed endpoint is refused by name, never by repeating it (it holds the key)', () => {
  const value = '"https://dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run"';
  assert.throws(
    () => readEnv({ OGMIOS_URL: value }),
    (e: unknown) => e instanceof Error && e.message === 'OGMIOS_URL is not a URL' && !e.message.includes('secret'),
  );
  assert.throws(() => readEnv({ OGMIOS_WS: 'https://not-a-socket.invalid' }), /OGMIOS_WS must start with wss: or ws:/);
  assert.throws(() => readEnv({ KOIOS_URL: 'http://koios.invalid' }), /KOIOS_URL must start with https:/);
  assert.deepEqual(readEnv({ KOIOS_URL: 'https://api.koios.rest/api/v1' }), { ogmios: undefined, ws: undefined, kupo: undefined, koios: 'https://api.koios.rest/api/v1' });
});

// ---- The process, as Railway runs it ----

const MAIN = new URL('../src/main.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
function boot(env: Record<string, string>, args: string[] = []) {
  const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'USERNAME', 'TEMP', 'TMP'].includes(k)));
  const r = spawnSync(process.execPath, [MAIN, ...args], { env: { ...keep, ...env } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
  const lines = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code: r.status, lines, stdout: r.stdout, stderr: r.stderr };
}

test('first boot with BATCHER_MAKE_KEY=1 makes the key, shows only its hash and address, and exits 0; it never makes a second', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-boot-'));
  try {
    const key = join(dir, 'batcher.skey');
    const first = boot({ BATCHER_MAKE_KEY: '1', BATCHER_KEY_FILE: key });
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const made = first.lines.find((l) => l.kind === 'key-made')!;
    assert.match(String(made.keyHash), /^[0-9a-f]{56}$/);
    assert.equal(made.address, enterprise(1, String(made.keyHash)));
    const secret = (JSON.parse(readFileSync(key, 'utf8')) as { cborHex: string }).cborHex.slice(4);
    assert.ok(!first.stdout.includes(secret) && !first.stderr.includes(secret), 'the key itself was printed');
    // The next boot finds it: no new key, and on to the settings.
    const second = boot({ BATCHER_MAKE_KEY: '1', BATCHER_KEY_FILE: key });
    assert.equal(second.code, 1);
    assert.ok(!second.lines.some((l) => l.kind === 'key-made'));
    assert.match(String(second.lines.find((l) => l.kind === 'fatal')?.error), /no settings/);
    assert.equal((JSON.parse(readFileSync(key, 'utf8')) as { cborHex: string }).cborHex.slice(4), secret, 'the key was replaced');
    // Settings from BATCHER_SETTINGS that name another key: refused, naming both (hashes are public).
    const other = boot({ BATCHER_KEY_FILE: key, BATCHER_SETTINGS: JSON.stringify(GOOD) });
    assert.equal(other.code, 1);
    assert.equal(other.lines.find((l) => l.kind === 'fatal')?.error, `the key at BATCHER_KEY_FILE is ${made.keyHash}; the settings name ${KEY}`);
    // Settings naming this key, and no source: past the key, stopped at "no source".
    const mine = boot({ BATCHER_KEY_FILE: key, BATCHER_SETTINGS: JSON.stringify({ ...GOOD, batcherKeyHash: made.keyHash, batcherAddress: made.address }) });
    assert.equal(mine.code, 1);
    assert.match(String(mine.lines.find((l) => l.kind === 'fatal')?.error), /^no source/);
    assert.equal(mine.lines[0]!.kind, 'boot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeKeyIfAsked: only when asked, only where told, never over a key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-key-'));
  try {
    const key = join(dir, 'k.skey');
    assert.equal(makeKeyIfAsked({ BATCHER_KEY_FILE: key }), null);
    assert.ok(!existsSync(key));
    assert.throws(() => makeKeyIfAsked({ BATCHER_MAKE_KEY: '1' }), /needs BATCHER_KEY_FILE/);
    const made = makeKeyIfAsked({ BATCHER_MAKE_KEY: '1', BATCHER_KEY_FILE: key })!;
    assert.match(made.keyHash, /^[0-9a-f]{56}$/);
    assert.equal(makeKeyIfAsked({ BATCHER_MAKE_KEY: '1', BATCHER_KEY_FILE: key }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the heartbeat’s rhythm fits the check it pings: a ping every 5 minutes, 10 quiet minutes a fail, one alert email an hour', () => {
  assert.deepEqual(HEARTBEAT, { everyMs: 300_000, quietMs: 600_000, alertGapMs: 3_600_000 });
  assert.ok(HEARTBEAT.quietMs > HEARTBEAT.everyMs);
});
