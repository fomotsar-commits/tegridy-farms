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
  backupName, buildBundle, checkBackupFile, latestBackup, NAME_RE, readBundleTables, rotate, runBackup, sha256,
} from './lib/backup.mjs';
import { findGpg, gpgDecrypt, gpgEncrypt } from './lib/gpg.mjs';
import { dumpAll, dumpTable, parseContentRange, TABLES } from './lib/supabase-dump.mjs';
import { createTar, readTar } from './lib/tar.mjs';
import { parseArgs as backupArgs } from './supabase-backup.mjs';
import { feedHidden, parseArgs as checkArgs } from './supabase-restore-check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'service-key-SHOULD-NEVER-BE-PRINTED-0123456789';
const PASS = "pass phrase with # and 'quotes' SHOULD-NEVER-BE-PRINTED";
const BASE = 'https://proj.supabase.co';
const tmp = (p) => mkdtempSync(join(tmpdir(), `ops-${p}-`));

function findBash() {
  for (const b of ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe']) {
    const r = spawnSync(b, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return b;
  }
  throw new Error('bash not found: these format checks need it (Git Bash on Windows)');
}
const bash = (script, opts) => {
  const r = spawnSync(findBash(), ['-c', script], { encoding: 'buffer', ...opts });
  assert.equal(r.status, 0, `bash failed: ${String(r.stderr)}`);
  return r;
};

/**
 * A fake PostgREST: Range pagination, Content-Range with an exact total, 416 past the end.
 * tables: { name: rows[] | { status } }. cap: the server's max rows per response.
 */
function fakePostgrest(tables, { cap = Infinity, total = (rows) => rows.length, noTotal = false, calls = [] } = {}) {
  const impl = async (url, init) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    calls.push({ table, headers: init.headers, url });
    const t = tables[table];
    if (t === undefined) return new Response('{"code":"PGRST205"}', { status: 404 });
    if (!Array.isArray(t)) {
      if (t.throw) throw new TypeError('fetch failed');
      return new Response(t.body ?? '{"message":"boom"}', { status: t.status, headers: t.headers });
    }
    const [from, to] = init.headers.Range.split('-').map(Number);
    const n = total(t, calls.filter((c) => c.table === table).length);
    const tot = noTotal ? '*' : String(n);
    if (from >= t.length && t.length > 0) {
      return new Response('{"code":"PGRST103"}', { status: 416, headers: { 'Content-Range': `*/${tot}` } });
    }
    const slice = t.slice(from, Math.min(to + 1, from + cap));
    const range = slice.length ? `${from}-${from + slice.length - 1}/${tot}` : `*/${tot}`;
    return new Response(JSON.stringify(slice), { status: slice.length < n ? 206 : 200, headers: { 'Content-Range': range } });
  };
  return impl;
}
const rows = (n, tag = 'r') => Array.from({ length: n }, (_, i) => ({ id: i, tag }));
const allTables = (n = 3) => Object.fromEntries(TABLES.map((t, i) => [t, rows(n + i, t)]));

describe('the table set', () => {
  test('is the workflow TABLES line, in order, and the restore script set', () => {
    const wf = join(REPO_ROOT, '.github', 'workflows', 'supabase-backup.yml');
    assert.ok(existsSync(wf), 'supabase-backup.yml is gone: re-home this pin to wherever the table list now lives');
    const m = /TABLES="([^"]+)"/.exec(readFileSync(wf, 'utf8'));
    assert.ok(m, 'no TABLES="..." line in supabase-backup.yml');
    assert.deepEqual([...TABLES], m[1].trim().split(/\s+/));
    assert.deepEqual([...TABLES].sort(), [...RESTORE_ORDER].sort());
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

  test('pages through 2500 rows in 1000-row Range requests with the service key', async () => {
    const calls = [];
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(2500) }, { calls }) });
    assert.equal(r.status, 'ok');
    assert.equal(r.rows.length, 2500);
    assert.deepEqual(r.rows.map((x) => x.id), [...Array(2500).keys()]);
    assert.deepEqual(calls.map((c) => c.headers.Range), ['0-999', '1000-1999', '2000-2999']);
    for (const c of calls) {
      assert.equal(c.headers.apikey, KEY);
      assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
      assert.equal(c.headers['Range-Unit'], 'items');
      assert.equal(c.headers.Prefer, 'count=exact');
      assert.equal(c.url, `${BASE}/rest/v1/votes?select=*`);
    }
  });

  test('an exact multiple of the page size ends on the 416 past the end', async () => {
    const r = await dumpTable({ baseUrl: BASE, key: KEY, table: 'votes', fetchImpl: fakePostgrest({ votes: rows(2000) }) });
    assert.equal(r.status, 'ok');
    assert.equal(r.rows.length, 2000);
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
