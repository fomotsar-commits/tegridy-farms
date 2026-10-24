// node --test scripts/ops/supabase-backup.test.mjs
// Needs gpg, tar and bash (ubuntu runners and Git for Windows have all three). A missing
// tool FAILS these tests rather than skipping them: a skipped format check proves nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { RESTORE_ORDER } from '../../frontend/scripts/supabase-restore.mjs';
import {
  backupName, buildBundle, CANARY_NAME, checkBackupFile, latestBackup, NAME_RE, readBundleTables, rotate, runBackup, sha256, writeCanary,
} from './lib/backup.mjs';
import { ENCRYPT_ARGS, findGpg, gpgDecrypt, gpgEncrypt } from './lib/gpg.mjs';
import { dumpAll, dumpTable, parseContentRange, TABLE_KEYS, TABLES } from './lib/supabase-dump.mjs';
import { createTar, readTar } from './lib/tar.mjs';
import { parseArgs as backupArgs } from './supabase-backup.mjs';
import { checkAndRecord, feedHidden, parseArgs as checkArgs } from './supabase-restore-check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'service-key-SHOULD-NEVER-BE-PRINTED-0123456789';
const PASS = "pass phrase with # and 'quotes' SHOULD-NEVER-BE-PRINTED";
const BASE = 'https://proj.supabase.co';
const tmp = (p) => mkdtempSync(join(tmpdir(), `ops-${p}-`));
// A GNUPGHOME in every form a gpg here might read: MSYS gpg (Git for Windows) reads a C:\
// home as a relative path, so it gets /c/... too.
const gnupgHomeForms = (home) => [home, ...(process.platform === 'win32' ? [`/${home[0].toLowerCase()}${home.slice(2).replace(/\\/g, '/')}`] : [])];

// A bash that receives our environment. WSL's bash.exe (often first on a Windows PATH) does
// not, so the passphrase would arrive empty; this probe rejects it wherever it sits.
function findBash() {
  const tries = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'] : ['bash'];
  for (const b of tries) {
    const r = spawnSync(b, ['-c', 'printf %s "$OPS_BASH_PROBE"'], { encoding: 'utf8', env: { ...process.env, OPS_BASH_PROBE: 'seen' } });
    if (r.status === 0 && r.stdout === 'seen') return b;
  }
  throw new Error('no bash that inherits the environment: these format checks need one (Git Bash on Windows)');
}
const bash = (script, opts) => {
  const r = spawnSync(findBash(), ['-c', script], { encoding: 'buffer', ...opts });
  assert.equal(r.status, 0, `bash failed: ${String(r.stderr)}`);
  return r;
};

/**
 * A fake PostgREST: `order=` sorting, Range pagination, Content-Range with an exact total,
 * and 416 only for a range that starts past the total (PostgREST's rule).
 * tables: { name: rows[] | { status } }. cap: the server's max rows per response.
 * between(table, callNumber, tables): runs before each request, to change rows mid-dump.
 */
function fakePostgrest(tables, {
  cap = Infinity, total = (rows) => rows.length, noTotal = false, calls = [], honourOrder = true, ignoreRange = false, between,
} = {}) {
  const impl = async (url, init) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    calls.push({ table, headers: init.headers, url });
    const n = calls.filter((c) => c.table === table).length;
    between?.(table, n, tables);
    let t = tables[table];
    if (t === undefined) return new Response('{"code":"PGRST205"}', { status: 404 });
    if (!Array.isArray(t)) {
      if (t.throw) throw new TypeError('fetch failed');
      return new Response(t.body ?? '{"message":"boom"}', { status: t.status, headers: t.headers });
    }
    const order = u.searchParams.get('order');
    if (honourOrder && order) {
      const keys = order.split(',').map((s) => s.replace(/\.asc$/, ''));
      t = [...t].sort((a, b) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; });
    }
    const [from, to] = ignoreRange ? [0, 999] : init.headers.Range.split('-').map(Number);
    const tot = noTotal ? '*' : String(total(t, n));
    if (from > t.length) return new Response('{"code":"PGRST103"}', { status: 416, headers: { 'Content-Range': `*/${tot}` } });
    const slice = t.slice(from, Math.min(to + 1, from + cap));
    const range = slice.length ? `${from}-${from + slice.length - 1}/${tot}` : `*/${tot}`;
    return new Response(JSON.stringify(slice), { status: slice.length < t.length ? 206 : 200, headers: { 'Content-Range': range } });
  };
  return impl;
}
// Rows carrying every primary-key column any table pages by, unique per row, and sorting
// in `id` order whichever key a table uses.
const pad = (i) => String(i).padStart(6, '0');
const rows = (n, tag = 'r') => Array.from({ length: n }, (_, i) => ({
  id: i, order_hash: `0x${pad(i)}`, wallet: `0xw${pad(i)}`, token_id: '1', collection_slug: 'c', week: 1, jti: `j${pad(i)}`, tag,
}));
const allTables = (n = 3) => Object.fromEntries(TABLES.map((t, i) => [t, rows(n + i, t)]));
const jwt = (claims) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('the table set', () => {
  test('is the workflow TABLES line, in order, and the restore script set', () => {
    const wf = join(REPO_ROOT, '.github', 'workflows', 'supabase-backup.yml');
    assert.ok(existsSync(wf), 'supabase-backup.yml is gone: re-home this pin to wherever the table list now lives');
    const m = /TABLES="([^"]+)"/.exec(readFileSync(wf, 'utf8'));
    assert.ok(m, 'no TABLES="..." line in supabase-backup.yml');
    assert.deepEqual([...TABLES], m[1].trim().split(/\s+/));
    assert.deepEqual([...TABLES].sort(), [...RESTORE_ORDER].sort());
  });

  test("each table pages by its primary key, as the migrations create it", () => {
    const dir = join(REPO_ROOT, 'frontend', 'supabase', 'migrations');
    const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.deepEqual(Object.keys(TABLE_KEYS).sort(), [...TABLES].sort());
    for (const t of TABLES) {
      const creates = [...sql.matchAll(new RegExp(`CREATE TABLE IF NOT EXISTS (?:public\\.)?${t} \\(([\\s\\S]*?)\\n\\);`, 'g'))];
      assert.equal(creates.length, 1, `${t}: expected one CREATE TABLE, found ${creates.length}`);
      const body = creates[0][1].split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      const composite = /PRIMARY KEY\s*\(([^)]+)\)/.exec(body);
      const single = /^\s*(\w+)\s+[^\n]*\bPRIMARY KEY\b/m.exec(body);
      const pk = composite ? composite[1].split(',').map((s) => s.trim()) : single ? [single[1]] : [];
      assert.deepEqual(TABLE_KEYS[t], pk, `${t}: the dump pages by ${TABLE_KEYS[t]} but the primary key is ${pk}`);
    }
    assert.doesNotMatch(sql, /ADD\s+(CONSTRAINT\s+\w+\s+)?PRIMARY KEY/i, 'a migration changes a primary key: re-check TABLE_KEYS');
  });
});

describe('dumpTable reads a table whole or fails it', () => {
  test('parseContentRange', () => {
    assert.deepEqual(parseContentRange('0-999/2500'), { start: 0, end: 999, total: 2500 });
    assert.deepEqual(parseContentRange('*/0'), { start: null, end: null, total: 0 });
    assert.deepEqual(parseContentRange('0-9/*'), { start: 0, end: 9, total: null });
    assert.equal(parseContentRange(null), null);
    assert.equal(parseContentRange('bytes 0-9/10'), null);
  });

  test('pages through 2500 rows in primary-key order, 1000 rows a request, each page starting on the last one', async () => {
    const calls = [];
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(2500) }, { calls }) });
    assert.equal(r.status, 'ok');
    assert.equal(r.rows.length, 2500);
    assert.deepEqual(r.rows.map((x) => x.id), [...Array(2500).keys()]);
    assert.deepEqual(calls.map((c) => c.headers.Range), ['0-999', '999-1998', '1998-2997']);
    for (const c of calls) {
      assert.equal(c.headers.apikey, KEY);
      assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
      assert.equal(c.headers['Range-Unit'], 'items');
      assert.equal(c.headers.Prefer, 'count=exact');
      assert.equal(c.url, `${BASE}/rest/v1/votes?select=*&order=wallet.asc,week.asc`);
    }
  });

  test('an exact multiple of the page size ends on a short page', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(2000) }) });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.rows.map((x) => x.id), [...Array(2000).keys()]);
  });

  test('a row that moves between pages fails the table, even from a server that ignores the order', async () => {
    // An UPDATE between page 1 and page 2 moves row 10 to the end of the heap: without a
    // check, row 1000 is skipped, row 10 is read twice, and the total still matches.
    const fetchImpl = fakePostgrest({ native_orders: rows(1500) }, {
      honourOrder: false,
      between: (t, n, tables) => { if (n === 2) { const [row] = tables.native_orders.splice(10, 1); tables.native_orders.push({ ...row, tag: 'filled' }); } },
    });
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'native_orders', fetchImpl });
    assert.equal(r.status, 'failed');
    assert.equal(r.rows, null);
    assert.match(r.reason, /rows moved during the dump/);
  });

  test('a delete and an insert between pages fail the table, though the total never moves', async () => {
    const fetchImpl = fakePostgrest({ messages: rows(1500) }, {
      between: (t, n, tables) => { if (n === 2) { tables.messages.splice(5, 1); tables.messages.push(rows(1501)[1500]); } },
    });
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'messages', fetchImpl });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /rows moved during the dump/);
  });

  test('an update that keeps its key is harmless when the server honours the order', async () => {
    const fetchImpl = fakePostgrest({ native_orders: rows(1500) }, {
      between: (t, n, tables) => { if (n === 2) tables.native_orders[10] = { ...tables.native_orders[10], tag: 'filled' }; },
    });
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'native_orders', fetchImpl });
    assert.equal(r.status, 'ok', r.reason);
    assert.deepEqual(r.rows.map((x) => x.id), [...Array(1500).keys()]);
  });

  test('a repeated or missing primary key fails the table', async () => {
    const dup = rows(3);
    dup[2] = { ...dup[2], id: 1 };
    const d = await dumpTable({ baseUrl: BASE, key: KEY, table: 'messages', fetchImpl: fakePostgrest({ messages: dup }) });
    assert.equal(d.status, 'failed');
    assert.match(d.reason, /two rows share the primary key \(id\)/);
    const nokey = rows(2).map(({ jti, ...rest }) => rest);
    const m = await dumpTable({ baseUrl: BASE, key: KEY, table: 'revoked_jwts', fetchImpl: fakePostgrest({ revoked_jwts: nokey }) });
    assert.equal(m.status, 'failed');
    assert.match(m.reason, /a row has no jti/);
  });

  test('a page that is not the range it was asked for fails (a proxy that drops Range)', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(1500) }, { ignoreRange: true }) });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /asked for rows 999-1998 and got 0-999/);
  });

  test('a table that shrinks under a later page fails', async () => {
    const fetchImpl = fakePostgrest({ votes: rows(1000) }, { between: (t, n, tables) => { if (n === 2) tables.votes.splice(0, 2); } });
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /the table shrank during the dump/);
  });

  test('an sb_secret_ key goes on apikey only; a legacy service_role JWT on both headers', async () => {
    for (const [key, bearer] of [['sb_secret_abc123', false], [jwt({ role: 'service_role' }), true]]) {
      const calls = [];
      const r = await dumpTable({ baseUrl: BASE, key, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(2) }, { calls }) });
      assert.equal(r.status, 'ok');
      assert.equal(calls[0].headers.apikey, key);
      assert.equal('Authorization' in calls[0].headers, bearer, key);
    }
  });

  test('a dump that runs past its deadline fails every table it had not finished', async () => {
    let clock = 0;
    const base = fakePostgrest(allTables());
    const fetchImpl = async (...a) => { clock += 60_000; return base(...a); };
    const all = await dumpAll({ baseUrl: BASE, key: KEY, fetchImpl, deadlineMs: 150_000, now: () => clock });
    assert.equal(all.ok, false);
    assert.deepEqual(all.bad.map((b) => b.table), TABLES.slice(3));
    for (const b of all.bad) assert.match(b.reason, /ran past its deadline/);
  });

  test('an empty table that answered is recorded as empty, not failed', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: [] }) });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.rows, []);
  });

  for (const [label, spec, want] of [
    ['HTTP 500', { status: 500 }, /HTTP 500/],
    ['HTTP 401', { status: 401 }, /HTTP 401/],
    ['a network error', { throw: true }, /request for rows 0-999 failed/],
    ['a non-JSON 200', { status: 200, body: '<html>', headers: { 'Content-Range': '0-0/1' } }, /non-JSON/],
    ['a JSON object instead of rows', { status: 200, body: '{"error":"x"}', headers: { 'Content-Range': '0-0/1' } }, /not a JSON array/],
  ]) {
    test(`${label} fails the table and returns no rows`, async () => {
      const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: spec }) });
      assert.equal(r.status, 'failed');
      assert.equal(r.rows, null);
      assert.match(r.reason, want);
    });
  }

  test('a 404 is "missing", and missing fails the run (no table is optional)', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({}) });
    assert.equal(r.status, 'missing');
    const t = allTables();
    delete t.votes;
    const all = await dumpAll({ baseUrl: BASE, key: KEY, fetchImpl: fakePostgrest(t) });
    assert.equal(all.ok, false);
    assert.deepEqual(all.bad.map((b) => b.table), ['votes']);
  });

  test('a server that caps a page below the page size fails the table (the workflow loop would stop and call it complete)', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(1200) }, { cap: 500 }) });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /read 500 rows but the server reports 1200/);
  });

  test('no row total in Content-Range fails: completeness cannot be proven', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(10) }, { noTotal: true }) });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /no row total/);
  });

  test('a row total that moves between pages fails', async () => {
    const fetchImpl = fakePostgrest({ votes: rows(1500) }, { total: (t, call) => (call === 1 ? t.length : t.length + 7) });
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /row total changed/);
  });

  test('hitting the page cap is TRUNCATED, never ok', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(30) }), pageSize: 10, maxPages: 2 });
    assert.equal(r.status, 'truncated');
    assert.equal(r.rows, null);
  });

  test('every table is attempted, so one report names every broken table', async () => {
    const calls = [];
    const t = allTables();
    t.native_orders = { status: 500 };
    t.revoked_jwts = { status: 503 };
    const all = await dumpAll({ baseUrl: BASE, key: KEY, fetchImpl: fakePostgrest(t, { calls }) });
    assert.equal(all.ok, false);
    assert.deepEqual(all.bad.map((b) => b.table), ['native_orders', 'revoked_jwts']);
    assert.deepEqual([...new Set(calls.map((c) => c.table))], [...TABLES]);
  });
});

describe('the bundle format', () => {
  test('our tar reads back through our reader', () => {
    const t = createTar([{ name: 'backup/', dir: true }, { name: 'backup/a.json', data: Buffer.from('[1,2]') }, { name: 'backup/b.json', data: Buffer.alloc(513, 65) }]);
    const e = readTar(t);
    assert.deepEqual(e.map((x) => [x.name, x.type, x.data.length]), [['backup/', 'dir', 0], ['backup/a.json', 'file', 5], ['backup/b.json', 'file', 513]]);
    assert.throws(() => readTar(t.subarray(0, 1024)), /runs past the end/);
    // Cut on an entry boundary: every header is whole, only the end blocks are missing.
    assert.throws(() => readTar(t.subarray(0, 1536)), /without its end-of-archive blocks/);
  });

  test('system tar extracts our bundle byte for byte', () => {
    const results = [{ table: 'votes', rows: rows(3) }, { table: 'messages', rows: [] }];
    const dir = tmp('tarx');
    writeFileSync(join(dir, 'b.tar.gz'), buildBundle(results));
    bash('tar -xzf b.tar.gz', { cwd: dir });
    assert.deepEqual(readdirSync(join(dir, 'backup')).sort(), ['messages.json', 'votes.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'backup', 'votes.json'), 'utf8')), rows(3));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'backup', 'messages.json'), 'utf8')), []);
  });

  test('our reader reads what system tar -czf writes', () => {
    const dir = tmp('tarc');
    mkdirSync(join(dir, 'backup'));
    writeFileSync(join(dir, 'backup', 'votes.json'), JSON.stringify(rows(2)));
    bash('tar -czf b.tar.gz backup/', { cwd: dir });
    const { byTable, stray } = readBundleTables(readFileSync(join(dir, 'b.tar.gz')));
    assert.deepEqual(JSON.parse(byTable.get('votes').toString()), rows(2));
    assert.deepEqual(stray, []);
  });
});

describe('encryption is the workflow format', () => {
  const gpg = findGpg();

  test('round-trips 2 MB of binary, keeps #, quotes and spaces in the passphrase, and refuses a wrong one', () => {
    const data = Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 7919) % 256));
    const enc = gpgEncrypt(gpg, PASS, data);
    assert.ok(!enc.includes(data.subarray(0, 64)), 'ciphertext contains plaintext');
    assert.ok(gpgDecrypt(gpg, PASS, enc).equals(data));
    assert.throws(() => gpgDecrypt(gpg, `${PASS}x`, enc), /gpg exited [1-9]/);
    assert.throws(() => gpgEncrypt(gpg, 'a\nb', data), /line break/);
  });

  test('a tampered file is an error even though gpg streams data before it notices', () => {
    const data = Buffer.alloc(256 * 1024, 7);
    const enc = Buffer.from(gpgEncrypt(gpg, PASS, data));
    enc[Math.floor(enc.length * 0.6)] ^= 0xff;
    const r = spawnSync(gpg, ['--batch', '--no-options', '--no-symkey-cache', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt'], {
      input: Buffer.concat([Buffer.from(`${PASS}\n`), enc]), maxBuffer: 64 * 1024 * 1024,
    });
    assert.notEqual(r.status, 0, 'gpg accepted a tampered file');
    assert.throws(() => gpgDecrypt(gpg, PASS, enc), /gpg exited [1-9]/);
  });

  test('a gpg call that overruns its limit is stopped and reported, never waited on', () => {
    assert.throws(() => gpgEncrypt(gpg, PASS, Buffer.alloc(1024), undefined, 1), /did not finish within its 1 ms limit/);
  });

  test("a gpg.conf in gpg's home cannot change the file format", () => {
    const home = tmp('gnupg');
    writeFileSync(join(home, 'gpg.conf'), 'armor\n');
    const homes = gnupgHomeForms(home);
    const gpgconf = gpg === 'gpg' ? 'gpgconf' : join(dirname(gpg), `gpgconf${process.platform === 'win32' ? '.exe' : ''}`);
    const input = Buffer.from(`${PASS}\nplain`);
    try {
      // Control: without --no-options, the armor line must show, or this test proves nothing.
      const env = homes.map((h) => ({ ...process.env, GNUPGHOME: h }))
        .find((e) => String(spawnSync(gpg, ENCRYPT_ARGS.filter((a) => a !== '--no-options'), { input, env: e }).stdout).startsWith('-----BEGIN PGP'));
      assert.ok(env, 'control: this gpg ignored GNUPGHOME in every form tried');
      const ours = gpgEncrypt(gpg, PASS, Buffer.from('plain'), env);
      assert.ok(!ours.subarray(0, 15).toString('latin1').startsWith('-----BEGIN PGP'), "gpg.conf's armor line changed our output");
    } finally {
      for (const h of homes) spawnSync(gpgconf, ['--kill', 'gpg-agent'], { env: { ...process.env, GNUPGHOME: h } });
    }
  });

  // A new runner, PC or Windows user has no gpg home, and --no-options stops gpg making one:
  // it exited 2 ("keyblock resource .../pubring.kbx: No such file or directory") on every call.
  test('needs no gpg home of the user, and writes nothing into one', () => {
    const data = Buffer.from('a backup taken where gpg has never run');
    const missing = join(tmp('gnupg-missing'), 'never-made');
    const existing = tmp('gnupg-existing');
    for (const home of [missing, ...gnupgHomeForms(existing)]) {
      const env = { ...process.env, GNUPGHOME: home };
      assert.ok(gpgDecrypt(gpg, PASS, gpgEncrypt(gpg, PASS, data, env), env).equals(data), `GNUPGHOME=${home}`);
    }
    assert.equal(existsSync(missing), false, 'a gpg home was created');
    assert.deepEqual(readdirSync(existing), [], "something was written into the user's gpg home");
  });

  test("each call's own gpg home is removed after it, whether gpg succeeds or fails", () => {
    const parent = tmp('gpgtmp');
    const saved = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map((k) => [k, process.env[k]]));
    Object.assign(process.env, { TMPDIR: parent, TEMP: parent, TMP: parent });
    try {
      const enc = gpgEncrypt(gpg, PASS, Buffer.from('x'));
      assert.ok(gpgDecrypt(gpg, PASS, enc).equals(Buffer.from('x')));
      assert.throws(() => gpgDecrypt(gpg, `${PASS}x`, enc), /gpg exited [1-9]/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    assert.deepEqual(readdirSync(parent), [], 'a gpg home was left behind');
  });

  test('a backup we write decrypts with the exact command in supabase/RESTORE.md step 1', () => {
    const restoreMd = readFileSync(join(REPO_ROOT, 'frontend', 'supabase', 'RESTORE.md'), 'utf8');
    assert.ok(restoreMd.includes('gpg --decrypt --batch --passphrase "$BACKUP_PASSPHRASE" \\'), 'RESTORE.md step 1 changed; update this pin');
    const results = TABLES.map((t, i) => ({ table: t, rows: rows(i, t) }));
    const dir = tmp('restoremd');
    writeFileSync(join(dir, 'x.tar.gz.gpg'), gpgEncrypt(gpg, PASS, buildBundle(results)));
    bash('gpg --decrypt --batch --passphrase "$BACKUP_PASSPHRASE" \\\n  x.tar.gz.gpg | tar -xz', {
      cwd: dir, env: { ...process.env, BACKUP_PASSPHRASE: PASS },
    });
    for (const [i, t] of TABLES.entries()) {
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'backup', `${t}.json`), 'utf8')), rows(i, t));
    }
  });

  test('a backup made by the workflow commands passes our restore check with the right counts', () => {
    const dir = tmp('wfmade');
    mkdirSync(join(dir, 'backup'));
    TABLES.forEach((t, i) => writeFileSync(join(dir, 'backup', `${t}.json`), JSON.stringify(rows(i + 1))));
    // supabase-backup.yml lines 241-245, verbatim apart from the stamp.
    bash('tar -czf "supabase-backup-2026-09-21.tar.gz" backup/ && printf \'%s\' "$BACKUP_PASSPHRASE" | gpg --batch --yes --symmetric \\\n'
      + '  --cipher-algo AES256 --pinentry-mode loopback --passphrase-fd 0 \\\n'
      + '  -o "supabase-backup-2026-09-21.tar.gz.gpg" "supabase-backup-2026-09-21.tar.gz"', {
      cwd: dir, env: { ...process.env, BACKUP_PASSPHRASE: PASS },
    });
    const r = checkBackupFile({ file: join(dir, 'supabase-backup-2026-09-21.tar.gz.gpg'), passphrase: PASS });
    assert.equal(r.ok, true, r.lines.join('\n'));
    for (const [i, t] of TABLES.entries()) {
      assert.ok(r.lines.some((l) => new RegExp(`ready\\s+${t}\\s+${i + 1} rows`).test(l)), `${t} count missing:\n${r.lines.join('\n')}`);
    }
    assert.ok(r.lines.some((l) => /integrity was not checked/.test(l)));
  });
});

describe('runBackup end to end', () => {
  const gpg = findGpg();
  const env = { SUPABASE_URL: `${BASE}/`, SUPABASE_SERVICE_KEY: KEY, BACKUP_PASSPHRASE: PASS };
  const now = new Date('2026-09-29T20:15:30.456Z');

  test('writes a verified .gpg and .sha256 that the restore check reads, and prints no secret', async () => {
    const dest = join(tmp('dest'), 'backups');
    const r = await runBackup({ env, fetchImpl: fakePostgrest(allTables()), dest, now, gpgBin: gpg });
    assert.equal(r.ok, true, r.lines.join('\n'));
    const name = 'supabase-backup-2026-09-29T201530Z.tar.gz.gpg';
    assert.deepEqual(readdirSync(dest).sort(), [name, `${name}.sha256`]);
    const bytes = readFileSync(join(dest, name));
    assert.equal(readFileSync(join(dest, `${name}.sha256`), 'utf8'), `${sha256(bytes)}  ${name}\n`);
    const check = checkBackupFile({ file: join(dest, name), passphrase: PASS });
    assert.equal(check.ok, true, check.lines.join('\n'));
    assert.ok(check.lines.some((l) => /sha256 matches/.test(l)));
    const printed = [...r.lines, ...check.lines].join('\n');
    assert.ok(!printed.includes(KEY) && !printed.includes(PASS), 'a secret reached the output');
    assert.ok(!printed.includes('proj.supabase.co'), 'the project URL reached the output');
  });

  test('a failed table writes nothing at all to the destination', async () => {
    const dest = join(tmp('destfail'), 'backups');
    const t = allTables();
    t.trade_offers = { status: 500 };
    const r = await runBackup({ env, fetchImpl: fakePostgrest(t), dest, now, gpgBin: gpg });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /INCOMPLETE: trade_offers \(failed\)/);
    assert.equal(existsSync(dest), false, 'the destination was created for a failed run');
  });

  test('missing settings fail by name, and the dump is never attempted', async () => {
    let called = false;
    const r = await runBackup({ env: { SUPABASE_URL: BASE }, fetchImpl: async () => { called = true; }, dest: tmp('x') });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /missing SUPABASE_SERVICE_KEY BACKUP_PASSPHRASE/);
    assert.equal(called, false);
  });

  test('refuses plain http, and refuses a destination inside a git work tree', async () => {
    const http = await runBackup({ env: { ...env, SUPABASE_URL: 'http://proj.supabase.co' }, fetchImpl: fakePostgrest(allTables()), dest: tmp('h'), gpgBin: gpg });
    assert.equal(http.ok, false);
    assert.match(http.lines.join('\n'), /must be https/);
    const repo = tmp('repo');
    mkdirSync(join(repo, '.git'));
    const r = await runBackup({ env, fetchImpl: fakePostgrest(allTables()), dest: join(repo, 'b'), gpgBin: gpg });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /inside the git work tree/);
  });

  test('a file that does not decrypt back to the same bundle is deleted, not kept', async () => {
    const dest = tmp('verify');
    const cipher = { encrypt: gpgEncrypt, decrypt: (g, p, c) => Buffer.concat([gpgDecrypt(g, p, c), Buffer.from('x')]) };
    const r = await runBackup({ env, fetchImpl: fakePostgrest(allTables()), dest, now, gpgBin: gpg, cipher });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /did not decrypt back/);
    assert.deepEqual(readdirSync(dest), []);
  });

  test('never overwrites an existing backup of the same second', async () => {
    const dest = tmp('dup');
    writeFileSync(join(dest, backupName(now)), 'existing');
    const r = await runBackup({ env, fetchImpl: fakePostgrest(allTables()), dest, now, gpgBin: gpg });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(join(dest, backupName(now)), 'utf8'), 'existing');
  });

  test('refuses an anon or publishable key, which would copy only the rows the public can see', async () => {
    for (const key of [jwt({ role: 'anon' }), 'sb_publishable_abc123']) {
      let called = false;
      const r = await runBackup({ env: { ...env, SUPABASE_SERVICE_KEY: key }, fetchImpl: async () => { called = true; }, dest: tmp('anon'), gpgBin: gpg });
      assert.equal(r.ok, false);
      assert.match(r.lines.join('\n'), /is not a service key/);
      assert.equal(called, false, 'the dump ran with a public key');
      assert.ok(!r.lines.join('\n').includes(key), 'the key reached the output');
    }
  });

  test('with no --dest, BACKUP_DIR is the folder and BACKUP_KEEP the number kept', async () => {
    // A throwaway home, so a regression that ignores BACKUP_DIR writes nowhere real.
    const home = tmp('home');
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      const dir = join(tmp('bdir'), 'backups');
      mkdirSync(dir);
      const older = ['2026-01-01', '2026-02-01', '2026-03-01'].map((d) => backupName(new Date(`${d}T00:00:00Z`)));
      for (const n of older) writeFileSync(join(dir, n), 'x');
      const r = await runBackup({ env: { ...env, BACKUP_DIR: dir, BACKUP_KEEP: '2' }, fetchImpl: fakePostgrest(allTables()), now, gpgBin: gpg });
      assert.equal(r.ok, true, r.lines.join('\n'));
      assert.deepEqual(readdirSync(dir).filter((f) => NAME_RE.test(f)).sort(), [older[2], backupName(now)].sort());
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test('the passphrase canary: a backup refuses an env passphrase that does not open it', async () => {
    const dest = tmp('canary');
    writeCanary({ dir: dest, passphrase: PASS, gpgBin: gpg });
    const good = await runBackup({ env, fetchImpl: fakePostgrest(allTables()), dest, now, gpgBin: gpg });
    assert.equal(good.ok, true, good.lines.join('\n'));
    assert.match(good.lines.join('\n'), /the one you proved by hand/);
    let called = false;
    const bad = await runBackup({
      env: { ...env, BACKUP_PASSPHRASE: `${PASS} ` }, fetchImpl: async () => { called = true; }, dest, now: new Date(now.getTime() + 1000), gpgBin: gpg,
    });
    assert.equal(bad.ok, false);
    assert.match(bad.lines.join('\n'), /does not open .*passphrase-canary\.gpg/);
    assert.equal(called, false, 'the dump ran before the passphrase was proven');
    assert.ok(!bad.lines.join('\n').includes(PASS), 'the passphrase reached the output');
  });

  test('with no canary yet, the backup runs and says how to make one', async () => {
    const r = await runBackup({ env, fetchImpl: fakePostgrest(allTables()), dest: tmp('nocanary'), now, gpgBin: gpg });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), new RegExp(`no ${CANARY_NAME.replace('.', '\\.')} in .* Run supabase-restore-check\\.mjs --latest --prompt`));
  });
});

describe('rotation and lookup', () => {
  test('keeps the newest N of our own files, with their .sha256, and touches nothing else', () => {
    const dir = tmp('rot');
    const names = Array.from({ length: 30 }, (_, i) => backupName(new Date(Date.UTC(2026, 0, 1 + i, 4, 23, 0))));
    for (const n of names) { writeFileSync(join(dir, n), 'x'); writeFileSync(join(dir, `${n}.sha256`), 'y'); }
    const others = ['supabase-backup-2026-07-30.tar.gz.gpg', 'notes.txt', 'supabase-backup-2026-01-01T000000Z.tar.gz.gpg.partial'];
    for (const o of others) writeFileSync(join(dir, o), 'z');
    const gone = rotate(dir, 26, names[29]);
    assert.deepEqual(gone, names.slice(0, 4).reverse());
    const left = readdirSync(dir);
    for (const n of names.slice(4)) assert.ok(left.includes(n) && left.includes(`${n}.sha256`));
    for (const n of names.slice(0, 4)) assert.ok(!left.includes(n) && !left.includes(`${n}.sha256`));
    for (const o of others) assert.ok(left.includes(o), `${o} was deleted`);
  });

  test('never deletes the file just written, even when the clock says it is the oldest', () => {
    const dir = tmp('rot2');
    const names = ['2026-01-01', '2026-02-01', '2026-03-01'].map((d) => backupName(new Date(`${d}T00:00:00Z`)));
    for (const n of names) writeFileSync(join(dir, n), 'x');
    rotate(dir, 1, names[0]);
    assert.deepEqual(readdirSync(dir).sort(), [names[0], names[2]].sort());
    assert.throws(() => rotate(dir, 0, names[0]), /at least 1/);
  });

  test('names are UTC, sortable and colon-free; --latest also sees GitHub-era names', () => {
    assert.equal(backupName(new Date('2026-09-29T20:15:30Z')), 'supabase-backup-2026-09-29T201530Z.tar.gz.gpg');
    assert.ok(NAME_RE.test(backupName(new Date())));
    const dir = tmp('latest');
    for (const n of ['supabase-backup-2026-09-21.tar.gz.gpg', 'supabase-backup-2026-09-20T000000Z.tar.gz.gpg', 'other.gpg']) writeFileSync(join(dir, n), 'x');
    assert.equal(latestBackup(dir), join(dir, 'supabase-backup-2026-09-21.tar.gz.gpg'));
  });
});

describe('the restore check', () => {
  const gpg = findGpg();

  test('fails on a checksum mismatch, a wrong passphrase, and a bundle missing a table', () => {
    const dir = tmp('chk');
    const full = TABLES.map((t) => ({ table: t, rows: rows(1) }));
    const f = join(dir, 'a.tar.gz.gpg');
    writeFileSync(f, gpgEncrypt(gpg, PASS, buildBundle(full)));
    writeFileSync(`${f}.sha256`, `${'0'.repeat(64)}  a.tar.gz.gpg\n`);
    assert.match(checkBackupFile({ file: f, passphrase: PASS }).lines.join('\n'), /CHECKSUM MISMATCH/);
    writeFileSync(`${f}.sha256`, `${sha256(readFileSync(f))}  a.tar.gz.gpg\n`);
    assert.equal(checkBackupFile({ file: f, passphrase: PASS }).ok, true);
    const wrong = checkBackupFile({ file: f, passphrase: 'nope' });
    assert.equal(wrong.ok, false);
    assert.match(wrong.lines.join('\n'), /DOES NOT DECRYPT/);
    const g = join(dir, 'b.tar.gz.gpg');
    writeFileSync(g, gpgEncrypt(gpg, PASS, buildBundle(full.filter((r) => r.table !== 'dm_messages'))));
    const partial = checkBackupFile({ file: g, passphrase: PASS });
    assert.equal(partial.ok, false);
    assert.match(partial.lines.join('\n'), /absent\s+dm_messages/);
    assert.ok(gunzipSync(gpgDecrypt(gpg, PASS, readFileSync(g))).length > 0);
  });

  test('a typed passphrase that opens a backup this tool wrote saves the canary, and nothing else does', () => {
    const dir = tmp('record');
    const ours = join(dir, backupName(new Date('2026-09-30T00:00:00Z')));
    const github = join(dir, 'supabase-backup-2026-09-21.tar.gz.gpg');
    const bundle = buildBundle(TABLES.map((t) => ({ table: t, rows: rows(1) })));
    for (const f of [ours, github]) writeFileSync(f, gpgEncrypt(gpg, PASS, bundle));
    const canary = join(dir, CANARY_NAME);

    assert.equal(checkAndRecord({ file: ours, passphrase: PASS, typed: false, gpgBin: gpg }).ok, true);
    assert.equal(existsSync(canary), false, 'saved from the env passphrase, which is the thing it must check');
    assert.equal(checkAndRecord({ file: ours, passphrase: 'wrong', typed: true, gpgBin: gpg }).ok, false);
    assert.equal(existsSync(canary), false, 'saved after a failed check');
    const gh = checkAndRecord({ file: github, passphrase: PASS, typed: true, gpgBin: gpg });
    assert.match(gh.lines.join('\n'), /not written by this tool/);
    assert.equal(existsSync(canary), false, 'saved beside a GitHub-era file, whose passphrase may be the old one');
    const saved = checkAndRecord({ file: ours, passphrase: PASS, typed: true, gpgBin: gpg });
    assert.equal(saved.ok, true);
    assert.match(saved.lines.join('\n'), /Saved .*passphrase-canary\.gpg/);
    assert.ok(gpgDecrypt(gpg, PASS, readFileSync(canary)).length > 0);
  });

  test('the CLIs take no secret as an argument', () => {
    assert.throws(() => backupArgs(['--passphrase', 'x']), /never from arguments/);
    assert.throws(() => checkArgs(['f', '--passphrase=x']), /never an argument/);
    assert.deepEqual(backupArgs(['--dest', 'd', '--keep', '3']), { dest: 'd', keep: '3', help: false });
    assert.deepEqual(checkArgs(['--latest', 'dir', '--prompt']), { file: null, latest: true, dir: 'dir', prompt: true, help: false });
  });

  test('hidden input handles backspace, enter and ctrl-c', () => {
    assert.deepEqual(feedHidden('', 'abcd'), { done: false, value: 'abcd' });
    assert.deepEqual(feedHidden('abcd', '\u007f\u007fX\r'), { done: true, value: 'abX' });
    assert.deepEqual(feedHidden('ab', '\u0003'), { done: true, cancelled: true, value: '' });
    assert.deepEqual(feedHidden('', 'pasted # secret\n'), { done: true, value: 'pasted # secret' });
  });
});
