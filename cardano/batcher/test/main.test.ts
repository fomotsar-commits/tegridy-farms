// The process's settings are checked before anything starts (every one required, in range, and
// the batcher's address its own key's), no secret reaches a log line or an error, and the
// process does what Railway needs of it: its key made once and found after, a dry run unless told
// otherwise, nothing signed before its alarm answers, a stop for a person kept up and failing, a
// broken library restarted with the order it broke on set aside, and a clean exit on a signal.
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { MAINNET_TIME } from '../src/chain.ts';
import { ALERTS_PING_ENV, PING_ENV } from '../src/heartbeat.ts';
import { HEARTBEAT, SET_ASIDE_FILE, logger, main, makeKeyIfAsked, readEnv, readSettings, type Settings } from '../src/main.ts';
import type { SocketFactory, SocketLike } from '../src/follow.ts';
import { parseExact, stringifyExact } from '../src/json.ts';
import type { Evaluator } from '../src/prepare.ts';
import type { ChainView } from '../src/view.ts';
import { ADA, DEP, FakeView, swapOn } from './fake-view.ts';
import { BATCHER_ADDRESS, BATCHER_KEY, BATCHER_SKEY, S, utxo, value, world } from './world.ts';

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
    // More than half the alarm's quiet time: with chain-sync down, it would read as quiet.
    [{ idleRoundMs: 300_001 }, /idleRoundMs must be a whole number from 5000 to 300000/],
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

test('no log line carries a host that holds a key, the chain-sync host, a malformed endpoint, the Koios token, or a ping URL', () => {
  const lines: string[] = [];
  const env = {
    OGMIOS_URL: 'https://dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run',
    OGMIOS_WS: 'wss://dmtr_ogmios1othersecret.mainnet-v6.ogmios-m1.demeter.run',
    KUPO_URL: '"https://dmtr_kupo1quotedsecret.mainnet-v2.kupo-m1.demeter.run"',
    KOIOS_TOKEN: 'eyJhbGciOiJIUzI1NiJ9.koios-token',
    [PING_ENV]: 'https://hc-ping.invalid/0b1c2d3e-alivesecret',
    [ALERTS_PING_ENV]: 'https://hc-ping.invalid/0b1c2d3e-alertssecret',
  };
  const log = logger(env, (l) => lines.push(l));
  // A value that is no URL at all (pasted without its scheme) is scrubbed whole.
  const bare: string[] = [];
  logger({ OGMIOS_URL: 'dmtr_ogmios1barevaluesecret' }, (l) => bare.push(l))({ kind: 'error', error: 'connect to dmtr_ogmios1barevaluesecret failed' });
  assert.ok(!bare[0]!.includes('barevaluesecret'), bare[0]);
  log({ kind: 'error', error: 'getaddrinfo ENOTFOUND dmtr_ogmios1secretsecret.mainnet-v6.ogmios-m1.demeter.run', ws: 'dmtr_ogmios1othersecret.mainnet-v6.ogmios-m1.demeter.run', more: env.KUPO_URL, token: 'Bearer eyJhbGciOiJIUzI1NiJ9.koios-token', amount: 9_223_372_036_854_775_807n, ping: 'cannot be constructed from https://hc-ping.invalid/0b1c2d3e-alivesecret/fail', path: '/0b1c2d3e-alertssecret' });
  assert.equal(lines.length, 1);
  assert.ok(!/secretsecret|othersecret|quotedsecret|koios-token|alivesecret|alertssecret/.test(lines[0]!), lines[0]);
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
const fatalOf = (b: { lines: Record<string, unknown>[] }) => String(b.lines.find((l) => l.kind === 'fatal')?.error);

test('the key: made once, shown only by its hash and address, found by every later boot; never made again, nor with settings given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-boot-'));
  try {
    const key = join(dir, 'batcher.skey');
    const first = boot({ BATCHER_MAKE_KEY: '1', BATCHER_KEY_FILE: key });
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const made = first.lines.find((l) => l.kind === 'key-made')!;
    assert.match(String(made.keyHash), /^[0-9a-f]{56}$/);
    assert.equal(made.address, enterprise(1, String(made.keyHash)));
    assert.match(String(made.next), /^remove BATCHER_MAKE_KEY and redeploy: that boot must show this same hash/);
    const secret = (JSON.parse(readFileSync(key, 'utf8')) as { cborHex: string }).cborHex.slice(4);
    assert.ok(!first.stdout.includes(secret) && !first.stderr.includes(secret), 'the key itself was printed');
    assert.deepEqual(readdirSync(dir), ['batcher.skey'], 'more than the key was left');
    // Still asked to make one, with no settings yet: the same key found, none made, waiting (exit 0).
    const again = boot({ BATCHER_MAKE_KEY: '1', BATCHER_KEY_FILE: key });
    assert.equal(again.code, 0);
    assert.ok(!again.lines.some((l) => l.kind === 'key-made'));
    assert.deepEqual(again.lines.find((l) => l.kind === 'key-found'), { at: again.lines.find((l) => l.kind === 'key-found')!.at, kind: 'key-found', keyHash: made.keyHash, address: made.address });
    assert.ok(again.lines.some((l) => l.kind === 'waiting'));
    assert.equal((JSON.parse(readFileSync(key, 'utf8')) as { cborHex: string }).cborHex.slice(4), secret, 'the key was replaced');
    const mineSettings = JSON.stringify({ ...GOOD, batcherKeyHash: made.keyHash, batcherAddress: made.address });
    // Asked to make one with settings given: refused.
    const left = boot({ BATCHER_MAKE_KEY: '1', BATCHER_KEY_FILE: key, BATCHER_SETTINGS: mineSettings });
    assert.equal(left.code, 1);
    assert.equal(fatalOf(left), 'BATCHER_MAKE_KEY=1 is for the first boot only, before there are settings: remove it');
    // Settings from BATCHER_SETTINGS that name another key: refused, naming both (hashes are public).
    const other = boot({ BATCHER_KEY_FILE: key, BATCHER_SETTINGS: JSON.stringify(GOOD) });
    assert.equal(other.code, 1);
    assert.equal(fatalOf(other), `the key at BATCHER_KEY_FILE is ${made.keyHash}; the settings name ${KEY}`);
    // Settings naming this key, and no source: past the key, stopped at "no source".
    const mine = boot({ BATCHER_KEY_FILE: key, BATCHER_SETTINGS: mineSettings });
    assert.equal(mine.code, 1);
    assert.match(fatalOf(mine), /^no source/);
    assert.equal(mine.lines[0]!.kind, 'boot');
    // Live, with no alarm, or one check given twice: refused before any source is asked.
    const quiet = boot({ BATCHER_KEY_FILE: key, BATCHER_SETTINGS: mineSettings, BATCHER_LIVE: '1', KOIOS_URL: 'https://koios.invalid/api/v1' });
    assert.equal(quiet.code, 1);
    assert.equal(fatalOf(quiet), 'a live batcher needs its alarm: HC_PING_URL_CARDANO_BATCHER is unset');
    const twice = boot({ BATCHER_KEY_FILE: key, BATCHER_SETTINGS: mineSettings, BATCHER_LIVE: '1', KOIOS_URL: 'https://koios.invalid/api/v1', [PING_ENV]: 'https://hc-ping.invalid/same-uuid-1234', [ALERTS_PING_ENV]: 'https://hc-ping.invalid/same-uuid-1234' });
    assert.equal(fatalOf(twice), `a live batcher needs its alarm: ${PING_ENV} and ${ALERTS_PING_ENV} are the same check`);
    assert.ok(!twice.stdout.includes('same-uuid-1234'), 'a ping URL was logged');
    // A dry run with a ping URL refused: it goes on, and says which and why (never the value).
    const http = boot({ BATCHER_KEY_FILE: key, BATCHER_SETTINGS: mineSettings, [PING_ENV]: 'http://hc-ping.invalid/plain-uuid-5678' });
    assert.deepEqual(http.lines.find((l) => l.kind === 'alarm-url-refused'), { at: http.lines.find((l) => l.kind === 'alarm-url-refused')!.at, kind: 'alarm-url-refused', variable: PING_ENV, problem: 'not https' });
    assert.ok(!http.stdout.includes('plain-uuid-5678'));
    // No key, and no settings: wrong.
    assert.equal(boot({}).code, 1);
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

test('the heartbeat’s rhythm fits the checks it pings: a ping every 5 minutes, 10 quiet minutes a fail, one alert email an hour', () => {
  assert.deepEqual(HEARTBEAT, { everyMs: 300_000, quietMs: 600_000, alertGapMs: 3_600_000 });
  assert.ok(HEARTBEAT.quietMs > HEARTBEAT.everyMs);
});

// The loop itself, on the stand-in chain, with the alarm's pings caught and a fast rhythm.

const ALIVE_URL = 'https://hc-ping.invalid/0b1c2d3e-aaaa-bbbb-cccc-SECRET-ALIVE';
const ALERTS_URL = 'https://hc-ping.invalid/0b1c2d3e-aaaa-bbbb-cccc-SECRET-ALERTS';
/** The slot at this moment, so the stand-in tip is current. */
const slotNow = () => MAINNET_TIME.zeroSlot + BigInt(Math.floor((Date.now() - Number(MAINNET_TIME.zeroTimeMs)) / 1000));
const WORLD_SETTINGS = JSON.stringify({
  ...GOOD,
  deployment: { authenPolicy: S.authen.hash, poolScriptHash: S.pool.hash, orderScriptHash: S.order.hash, poolBatchingScriptHash: S.poolBatching.hash, scriptRefs: DEP.scriptRefs },
  batcherKeyHash: BATCHER_KEY,
  batcherAddress: BATCHER_ADDRESS.to_bech32(undefined),
  maxRefusalsInARow: 3,
  idleRoundMs: 5000,
});

function chain(opts: { orders?: number; rich?: boolean; evaluate?: Evaluator } = {}) {
  const w = world();
  const orders = Array.from({ length: opts.orders ?? 1 }, (_, j) => swapOn(`${(0xd0 + j).toString(16).repeat(32)}#0`, 1 + j));
  const wallet = [w.batcher.feeUtxos[0]!, w.batcher.collateral, ...(opts.rich ? [utxo(`${'b2'.repeat(32)}#0`, BATCHER_ADDRESS, value(95n * ADA))] : [])];
  const view = new FakeView('primary', [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, ...wallet, ...orders.map((o) => o.utxo)], opts.evaluate);
  view.slot = slotNow();
  return { view, orders };
}

/** The batcher's key (the test world's), in a key file in a folder of its own. */
function keyDir(): { dir: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-run-'));
  const key = join(dir, 'batcher.skey');
  writeFileSync(key, JSON.stringify({ type: 'PaymentSigningKeyShelley_ed25519', cborHex: `5820${Buffer.from(BATCHER_SKEY.as_bytes()).toString('hex')}` }));
  return { dir, key };
}

async function until(what: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !what(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every batcher a test started is stopped after it, passed or failed: a failed one left running would hold the whole run open. */
const running: (() => void)[] = [];
afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

function start(env: Record<string, string>, views: ChainView[], opts: { argv?: string[]; answering?: () => boolean; socket?: SocketFactory } = {}) {
  const lines: Record<string, unknown>[] = [];
  const pings: { check: 'alive' | 'alerts'; kind: string; body: string }[] = [];
  let stop: () => void = () => {};
  let code: number | null = null;
  const done = main({
    env: { BATCHER_SETTINGS: WORLD_SETTINGS, [PING_ENV]: ALIVE_URL, [ALERTS_PING_ENV]: ALERTS_URL, ...env },
    argv: opts.argv ?? [],
    write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    onStop: (s) => (stop = s),
    rhythm: { everyMs: 25, quietMs: 600_000, alertGapMs: 3_600_000 },
    send: async (p) => {
      pings.push({ check: p.url === ALIVE_URL ? 'alive' : 'alerts', kind: p.kind, body: p.body });
      return (opts.answering?.() ?? true) ? { ok: true, status: 200 } : { ok: false, error: 'HTTP 404' };
    },
    views,
    socket: opts.socket,
    pollMs: 10,
    alarmRetryMs: 20,
  }).then((c) => (code = c));
  const of = (check: 'alive' | 'alerts', kind?: string) => pings.filter((p) => p.check === check && (!kind || p.kind === kind));
  running.push(() => stop());
  return { lines, pings, of, stop: () => stop(), done, code: () => code, has: (kind: string) => lines.some((l) => l.kind === kind) };
}

test('a dry run (the default): it prepares and judges and signs nothing; both checks start, then report it as a dry run; a stop signal ends it cleanly', async () => {
  const { view } = chain();
  const { dir, key } = keyDir();
  try {
    const r = start({ BATCHER_KEY_FILE: key }, [view]);
    await until(() => r.of('alerts', 'ok').length >= 2);
    assert.equal(r.code(), null, 'it exited by itself');
    r.stop();
    await r.done;
    assert.equal(r.code(), 0);
    assert.equal(view.calls.get('submit') ?? 0, 0);
    assert.ok(r.lines.some((l) => l.kind === 'prepared' && l.dryRun === true));
    assert.deepEqual(r.of('alive').slice(0, 1).map((p) => [p.kind, p.body]), [['start', 'the batcher started: a dry run, it signs nothing']]);
    assert.match(r.of('alive', 'ok')[0]!.body, /^DRY RUN, signing nothing\. working\n.*last round: prepared 1 orders via primary \(dry run\)/s);
    assert.deepEqual(r.lines.at(-1), { at: r.lines.at(-1)!.at, kind: 'exit', code: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live: nothing is signed until both checks have answered; then it batches', async () => {
  const { view } = chain();
  const { dir, key } = keyDir();
  try {
    let answering = false;
    const r = start({ BATCHER_KEY_FILE: key, BATCHER_LIVE: '1' }, [view], { answering: () => answering });
    await until(() => r.lines.filter((l) => l.kind === 'alarm-unreachable').length >= 2);
    assert.equal(view.calls.get('tip') ?? 0, 0, 'a source was asked before the alarm answered');
    answering = true;
    await until(() => r.has('sent'));
    assert.equal(view.submitted.length, 1);
    assert.equal(r.of('alive', 'start').at(-1)!.body, 'the batcher started, signing');
    r.stop();
    await r.done;
    assert.equal(r.code(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopped for a person (above the float cap): it stays up, the alerts check failing with the reason, the dead-man ok, until a stop signal', async () => {
  const { view } = chain({ rich: true });
  const { dir, key } = keyDir();
  try {
    const r = start({ BATCHER_KEY_FILE: key, BATCHER_LIVE: '1' }, [view]);
    await until(() => r.of('alerts', 'fail').length >= 3);
    assert.equal(r.code(), null, 'a stop for a person ended the process (Railway would restart it, and it would read as recovered)');
    assert.match(r.of('alerts', 'fail')[0]!.body, /^STOPPED: the batcher holds 125000000 lovelace, above its cap of 100000000/);
    assert.ok(r.of('alive', 'ok').length >= 2);
    assert.match(r.of('alive', 'ok').at(-1)!.body, /^STOPPED: the batcher holds/);
    assert.equal(view.submitted.length, 0);
    r.stop();
    await r.done;
    assert.equal(r.code(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EMURGO’s library broken on an order: exit 3 to restart, the order kept on the volume, and the next process sets it aside', async () => {
  class RuntimeError extends Error {}
  const broken = chain({ evaluate: () => {
    throw new RuntimeError('memory access out of bounds');
  } });
  const { dir, key } = keyDir();
  try {
    const r = start({ BATCHER_KEY_FILE: key }, [broken.view]);
    await r.done;
    assert.equal(r.code(), 3);
    const ref = broken.orders[0]!.utxo.ref;
    const kept = JSON.parse(readFileSync(join(dir, SET_ASIDE_FILE), 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(kept), [ref]);
    assert.equal(BigInt(kept[ref]!), broken.view.slot + 3_600n);
    assert.match(r.of('alerts', 'fail')[0]!.body, /^STOPPED \(fatal: the process restarts\): EMURGO's library failed preparing/);
    // The next process: the same order, now set aside; nothing prepared.
    const next = chain();
    const again = start({ BATCHER_KEY_FILE: key }, [next.view]);
    await until(() => again.has('idle'));
    again.stop();
    await again.done;
    assert.deepEqual(again.lines.find((l) => l.kind === 'set-aside-restored')?.orders, { [ref]: Number(kept[ref]) });
    assert.ok(!again.has('prepared'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--once: one round, no alarm; 0 when it ran, 2 when it stopped itself, 3 when it must restart', async () => {
  const { dir, key } = keyDir();
  try {
    const once = async (views: ChainView[]) => {
      const r = start({ BATCHER_KEY_FILE: key }, views, { argv: ['--once'] });
      await r.done;
      assert.equal(r.pings.length, 0, 'an alarm in --once');
      return r.code();
    };
    assert.equal(await once([chain().view]), 0);
    assert.equal(await once([chain({ rich: true }).view]), 2);
    const trapped = chain();
    trapped.view.tip = async () => {
      throw new (class RuntimeError extends Error {})('unreachable');
    };
    assert.equal(await once([trapped.view]), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a process that cannot start fails the alerts check, saying why, and exits 1', async () => {
  const r = start({ BATCHER_SETTINGS: '{' }, []);
  await r.done;
  assert.equal(r.code(), 1);
  assert.deepEqual(r.of('alerts').map((p) => [p.kind, p.body]), [['fail', 'could not start: settings: not JSON']]);
  assert.equal(r.of('alive').length, 0);
});

test('with chain-sync down, an idle round every idleRoundMs, counted from the last one, not one every 5 s once the first is due', async () => {
  const { view } = chain({ orders: 0 });
  view.slot = slotNow();
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  try {
    const settings = JSON.stringify({ ...JSON.parse(WORLD_SETTINGS), idleRoundMs: 20_000 });
    let stop: () => void = () => {};
    const done = main({ env: { BATCHER_SETTINGS: settings }, argv: [], write: () => {}, onStop: (s) => (stop = s), views: [view] });
    const settle = () => new Promise((r) => setImmediate(r));
    for (let i = 0; i < 5; i++) await settle();
    for (let s = 0; s < 60; s += 5) {
      mock.timers.tick(5_000);
      for (let i = 0; i < 5; i++) await settle();
    }
    stop();
    assert.equal(await done, 0);
    assert.equal(view.calls.get('tip'), 4, 'rounds at 0, 20, 40 and 60 s');
  } finally {
    mock.timers.reset();
  }
});

/** A stand-in Ogmios for chain-sync: each nextBlock is answered by the next step, when it asks ('close': the connection drops). */
class ScriptedOgmios implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly #next: () => Promise<unknown>;
  readonly #tip: unknown;
  constructor(next: () => Promise<unknown>, tip: unknown) {
    this.#next = next;
    this.#tip = tip;
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string): void {
    const m = parseExact(data) as { method: string; id: bigint; params?: { points: unknown[] } };
    const reply = (result: unknown) => void setTimeout(() => this.onmessage?.({ data: stringifyExact({ jsonrpc: '2.0', method: m.method, result, id: m.id }) }), 0);
    if (m.method === 'findIntersection') return reply({ intersection: m.params!.points[0], tip: this.#tip });
    if (m.method === 'nextBlock') void this.#next().then((r) => (r === 'close' ? void setTimeout(() => this.onclose?.({}), 0) : reply(r)));
  }
  close(): void {}
}

test('chain-sync wired in: a batch seen in a block and then rolled back never landed; after a lost connection, nothing awaiting is judged', async () => {
  const { view, orders } = chain({ orders: 2 });
  const S = view.slot;
  const tip = { slot: S, id: 'aa'.repeat(32), height: 1n };
  const held = orders.map((o) => view.chain.find((u) => u.ref === o.utxo.ref)!);
  view.chain = view.chain.filter((u) => !held.includes(u));
  const fwd = (slot: bigint, txs: string[]) => ({ direction: 'forward', block: { type: 'praos', era: 'conway', id: slot.toString(16).padStart(64, '0'), slot, height: slot, transactions: txs.map((id) => ({ id, spends: 'inputs' })) }, tip });
  const atIntersection = { direction: 'backward', point: { slot: S, id: tip.id }, tip };
  const { dir, key } = keyDir();
  try {
    let r!: ReturnType<typeof start>;
    const sent = () => r.lines.filter((l) => l.kind === 'sent').map((l) => String(l.txId));
    const steps: (() => Promise<unknown>)[] = [
      async () => atIntersection,
      // The first block: chain-sync is up. An order arrives, and its batch is sent.
      async () => (view.chain.push(held[0]!), fwd(S, [])),
      async () => (await until(() => sent().length === 1), fwd(S + 1n, [sent()[0]!])),
      async () => ({ direction: 'backward', point: { slot: S, id: fwd(S, []).block.id }, tip }),
      // Past its window, never seen again: never landed. The next order's batch is sent.
      async () => {
        view.slot = S + 241n;
        view.chain = view.chain.filter((u) => u !== held[0]).concat(held[1]!);
        return fwd(S + 241n, []);
      },
      async () => (await until(() => sent().length === 2), 'close'),
      // Followed again from the new tip, the blocks meanwhile unseen: the second batch is not judged.
      async () => atIntersection,
      async () => fwd(S + 600n, []),
    ];
    const next = () => steps.shift()?.() ?? new Promise(() => {});
    r = start({ BATCHER_KEY_FILE: key, BATCHER_LIVE: '1', OGMIOS_WS: 'wss://ogmios.invalid' }, [view], { socket: () => new ScriptedOgmios(next, tip) });
    await until(() => r.lines.some((l) => l.kind === 'block' && l.slot === Number(S + 600n)));
    await new Promise((res) => setTimeout(res, 50));
    r.stop();
    await r.done;
    assert.ok(r.has('chain-sync-down'));
    assert.deepEqual(r.lines.filter((l) => l.kind === 'unlanded').map((l) => [l.txId, l.inARow]), [[sent()[0], 1]]);
    assert.ok(!r.has('landed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
