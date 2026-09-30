// node --test scripts/ops/pull-github-backups.test.mjs
// gh is always a fake here: these tests never reach GitHub. The ciphertext is real: made by
// supabase-backup.yml's own encrypt lines under bash and gpg, which this suite requires.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './lib/backup.mjs';
import {
  ageText, DOWNLOAD_TIMEOUT_MS, heldRuns, LIST_LIMIT, LIST_TIMEOUT_MS, MAX_DOWNLOADS, openPgpProblem, parseRunList, pullGithubBackups, REPO,
  STALE_DAYS, SUMS_NAME, WORKFLOW,
} from './lib/github-backups.mjs';
import { parseArgs } from './pull-github-backups.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-30T18:00:00Z');
const PASS = 'fixture-passphrase-not-a-secret';
const tmp = (p) => mkdtempSync(join(tmpdir(), `ops-pull-${p}-`));

function findBash() {
  const tries = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'] : ['bash'];
  for (const b of tries) {
    const r = spawnSync(b, ['-c', 'printf %s "$OPS_BASH_PROBE"'], { encoding: 'utf8', env: { ...process.env, OPS_BASH_PROBE: 'seen' } });
    if (r.status === 0 && r.stdout === 'seen') return b;
  }
  throw new Error('no bash that inherits the environment (Git Bash on Windows)');
}

/** The workflow's encrypt command, verbatim: the line that runs gpg and its continuations. */
function workflowEncryptLines() {
  const lines = readFileSync(join(REPO_ROOT, '.github', 'workflows', WORKFLOW), 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => /gpg --batch --yes --symmetric/.test(l));
  assert.ok(at > 0, `${WORKFLOW} no longer encrypts with gpg --symmetric: re-pin this fixture`);
  const out = [];
  for (let i = at; i < lines.length; i++) {
    out.push(lines[i].trim());
    if (!lines[i].trimEnd().endsWith('\\')) break;
  }
  return out.join('\n');
}

let fixtures;
/** small: one fixed-length packet; big: gpg's partial lengths; aes128 and armored: wrong kinds. */
function gpgFixtures() {
  if (fixtures) return fixtures;
  const dir = tmp('gpg');
  writeFileSync(join(dir, 'supabase-backup-small.tar.gz'), Buffer.from('{"native_orders":[]}\n'.repeat(40)));
  writeFileSync(join(dir, 'supabase-backup-big.tar.gz'), Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919 + (i >> 8)) % 251)));
  const script = [
    'set -e', 'export GNUPGHOME="$PWD/gnupg"', 'mkdir -p "$GNUPGHOME"', 'chmod 700 "$GNUPGHOME"',
    'for STAMP in small big; do', workflowEncryptLines(), 'done',
    'printf %s "$BACKUP_PASSPHRASE" | gpg --batch --yes --symmetric --cipher-algo AES128 --pinentry-mode loopback --passphrase-fd 0 -o aes128.gpg supabase-backup-small.tar.gz',
    'printf %s "$BACKUP_PASSPHRASE" | gpg --batch --yes --symmetric --armor --cipher-algo AES256 --pinentry-mode loopback --passphrase-fd 0 -o armored.asc supabase-backup-small.tar.gz',
    'gpgconf --kill gpg-agent',
  ].join('\n');
  const r = spawnSync(findBash(), ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, BACKUP_PASSPHRASE: PASS } });
  assert.equal(r.status, 0, `making gpg fixtures failed: ${r.stderr}`);
  const read = (f) => readFileSync(join(dir, f));
  fixtures = {
    small: read('supabase-backup-small.tar.gz.gpg'),
    big: read('supabase-backup-big.tar.gz.gpg'),
    aes128: read('aes128.gpg'),
    armored: read('armored.asc'),
    plain: read('supabase-backup-small.tar.gz'),
  };
  return fixtures;
}

const run = (id, daysAgo, conclusion = 'success') => ({
  databaseId: id, createdAt: new Date(NOW - daysAgo * DAY).toISOString(), conclusion, event: 'schedule', headBranch: 'mvp-launch',
});
const dateOf = (r) => r.createdAt.slice(0, 10);

/** A fake gh: records every call, notices overlapping calls, and writes artifacts like gh does. */
function fakeGh({ runs = [], listFails = null, downloadFails = [], artifact = {}, nest = false } = {}) {
  const calls = [];
  let active = 0;
  let overlapped = false;
  const impl = async (cmd, args, opts) => {
    active++;
    if (active > 1) overlapped = true;
    calls.push({ cmd, args, opts });
    try {
      await new Promise((r) => setTimeout(r, 5));
      if (args[0] === 'run' && args[1] === 'list') {
        if (listFails) return { code: 1, signal: null, stdout: '', stderr: listFails, timedOut: false, error: null };
        return { code: 0, signal: null, stdout: JSON.stringify(runs), stderr: '', timedOut: false, error: null };
      }
      if (args[0] === 'run' && args[1] === 'download') {
        const id = Number(args[2]);
        if (downloadFails.includes(id)) return { code: 1, signal: null, stdout: '', stderr: 'no valid artifacts found to download', timedOut: false, error: null };
        const r = runs.find((x) => x.databaseId === id);
        const files = artifact[id] || [{ name: `supabase-backup-${dateOf(r)}.tar.gz.gpg`, data: gpgFixtures().small }];
        const dir = args[args.indexOf('--dir') + 1];
        const into = nest ? join(dir, `supabase-backup-${id}`) : dir;
        mkdirSync(into, { recursive: true });
        for (const f of files) writeFileSync(join(into, f.name), f.data);
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    } finally {
      active--;
    }
  };
  return { impl, calls, downloads: () => calls.filter((c) => c.args[1] === 'download').map((c) => Number(c.args[2])), overlapped: () => overlapped };
}

/** Put a run in `dest` the way the 09-29 download did. */
function hold(dest, r, data = gpgFixtures().small) {
  const dir = join(dest, `${dateOf(r)}-run${r.databaseId}`, `supabase-backup-${r.databaseId}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `supabase-backup-${dateOf(r)}.tar.gz.gpg`);
  writeFileSync(file, data);
  return file;
}
const pull = (gh, dest, extra = {}) => pullGithubBackups({ env: {}, run: gh.impl, dest, now: NOW, ...extra });
const text = (r) => `${r.summary}\n${r.lines.join('\n')}`;

describe('the OpenPGP check', () => {
  test('passes what the workflow writes, in both packet framings gpg uses', () => {
    const f = gpgFixtures();
    assert.equal(openPgpProblem(f.small), null);
    assert.equal(openPgpProblem(f.big), null);
    // Controls: the two fixtures really exercise the two framings.
    assert.equal(f.small[0], 0x8c, 'small: an old-format session key packet');
    const dataAt = 2 + f.small[1];
    assert.ok(f.small[dataAt + 1] < 224, 'small: a fixed-length data packet');
    assert.ok(f.big[dataAt + 1] >= 224 && f.big[dataAt + 1] < 255, 'big: a partial-length data packet');
  });

  test('rejects an empty file, plaintext, armour, the wrong cipher, and a wrong first packet', () => {
    const f = gpgFixtures();
    assert.match(openPgpProblem(Buffer.alloc(0)), /empty/);
    assert.match(openPgpProblem(f.plain), /does not start with an OpenPGP packet/);
    assert.match(openPgpProblem(f.armored), /does not start with an OpenPGP packet/);
    assert.match(openPgpProblem(f.aes128), /cipher is 7, not AES256/);
    const literal = Buffer.from(f.small);
    literal[0] = 0xac; // old format, tag 11 (literal data)
    assert.match(openPgpProblem(literal), /tag 11, not a symmetric-key session key/);
    const v3 = Buffer.from(f.small);
    v3[2] = 3;
    assert.match(openPgpProblem(v3), /version 3/);
    const notData = Buffer.from(f.small);
    notData[2 + f.small[1]] = 0xcb; // new format, tag 11 (literal data) where tag 18 belongs
    assert.match(openPgpProblem(notData), /no encrypted data packet follows/);
  });

  test('rejects a truncated or padded file, whichever framing it uses', () => {
    const f = gpgFixtures();
    for (const [name, buf] of [['small', f.small], ['big', f.big]]) {
      assert.match(openPgpProblem(buf.subarray(0, buf.length - 1)), /truncated/, name);
      assert.match(openPgpProblem(buf.subarray(0, 40)), /truncated|no encrypted data packet/, name);
      assert.match(openPgpProblem(Buffer.concat([buf, Buffer.from([0])])), /1 unexpected bytes/, name);
    }
    assert.match(openPgpProblem(f.small.subarray(0, 15)), /no encrypted data packet/);
  });
});

describe('listing', () => {
  test('one gh run list call: the backup workflow, successful runs only, a bounded page', async () => {
    const dest = tmp('args');
    const gh = fakeGh({ runs: [run(10, 1)] });
    await pull(gh, dest, { gh: 'gh-fake' });
    const list = gh.calls.filter((c) => c.args[1] === 'list');
    assert.equal(list.length, 1);
    const a = list[0].args;
    assert.equal(list[0].cmd, 'gh-fake');
    for (const [flag, want] of [['--repo', REPO], ['--workflow', WORKFLOW], ['--status', 'success'], ['--limit', String(LIST_LIMIT)]]) {
      assert.equal(a[a.indexOf(flag) + 1], want, flag);
    }
    assert.match(a[a.indexOf('--json') + 1], /databaseId/);
    assert.equal(list[0].opts.timeoutMs, LIST_TIMEOUT_MS);
  });

  test('parseRunList keeps only successes, newest id first, and refuses rows it cannot read', () => {
    const runs = parseRunList(JSON.stringify([run(5, 3), run(9, 1), run(7, 2, 'failure')]));
    assert.deepEqual(runs.map((r) => r.id), [9, 5]);
    assert.equal(runs[0].date, dateOf(run(9, 1)));
    assert.throws(() => parseRunList('not json'), /did not print JSON/);
    assert.throws(() => parseRunList('{}'), /not print a list/);
    assert.throws(() => parseRunList(JSON.stringify([{ databaseId: 'x', createdAt: 'y' }])), /no usable id or date/);
  });
});

describe('pulling', () => {
  test('pulls every new run into the 09-29 layout, one call at a time, oldest first, and records SHA256SUMS', async () => {
    const dest = tmp('fresh');
    const runs = [run(30, 1), run(20, 8), run(10, 15)];
    const gh = fakeGh({ runs });
    const r = await pull(gh, dest);
    assert.equal(r.ok, true, text(r));
    assert.deepEqual(gh.downloads(), [10, 20, 30]);
    assert.equal(gh.overlapped(), false, 'two gh calls ran at once');
    assert.equal(gh.calls[0].args[1], 'list', 'the list call comes first');
    for (const c of gh.calls.slice(1)) {
      assert.equal(c.args[c.args.indexOf('--name') + 1], `supabase-backup-${c.args[2]}`);
      assert.equal(c.opts.timeoutMs, DOWNLOAD_TIMEOUT_MS);
    }
    const sums = readFileSync(join(dest, SUMS_NAME), 'utf8').trim().split('\n');
    assert.equal(sums.length, 3);
    for (const x of runs) {
      const rel = `${dateOf(x)}-run${x.databaseId}/supabase-backup-${x.databaseId}/supabase-backup-${dateOf(x)}.tar.gz.gpg`;
      assert.ok(existsSync(join(dest, ...rel.split('/'))), rel);
      assert.ok(sums.includes(`${sha256(gpgFixtures().small)}  ${rel}`), `${rel} not in SHA256SUMS`);
    }
    assert.deepEqual(readdirSync(dest).filter((n) => n.startsWith('.')), [], 'a staging folder was left behind');
  });

  test('never more than three downloads; older new runs are reported as left on GitHub, and SUMS is still written', async () => {
    const dest = tmp('many');
    const gh = fakeGh({ runs: [run(60, 1), run(50, 8), run(40, 15), run(30, 22), run(20, 29)] });
    const r = await pull(gh, dest);
    assert.equal(MAX_DOWNLOADS, 3);
    assert.deepEqual(gh.downloads(), [40, 50, 60]);
    assert.equal(r.ok, false);
    assert.match(text(r), /run 30 .* is left on GitHub only/);
    assert.match(text(r), /run 20 .* is left on GitHub only/);
    assert.equal(readFileSync(join(dest, SUMS_NAME), 'utf8').trim().split('\n').length, 3);
    // The next run does not fail on them again: they are older than what is held.
    const again = await pull(fakeGh({ runs: [run(60, 1), run(50, 8), run(40, 15), run(30, 22), run(20, 29)] }), dest);
    assert.equal(again.ok, true, text(again));
  });

  test('downloads only runs newer than the newest one held: older gaps are expired or never had a backup', async () => {
    const dest = tmp('held');
    hold(dest, run(20, 8));
    hold(dest, run(10, 15));
    const gh = fakeGh({ runs: [run(30, 1), run(20, 8), run(15, 12), run(10, 15), run(5, 60)] });
    const r = await pull(gh, dest);
    assert.equal(r.ok, true, text(r));
    assert.deepEqual(gh.downloads(), [30]);
    assert.deepEqual([...heldRuns(dest).keys()].sort((a, b) => a - b), [10, 20, 30]);
  });

  test('with nothing new: one list call, no download, and every held file still checked', async () => {
    const dest = tmp('none');
    hold(dest, run(20, 1));
    const gh = fakeGh({ runs: [run(20, 1)] });
    const r = await pull(gh, dest);
    assert.equal(r.ok, true, text(r));
    assert.equal(gh.calls.length, 1);
    assert.match(r.summary, /nothing new to pull; 1 held/);
  });

  test('a failed download stops the run, leaves nothing half-written, and is retried next time', async () => {
    const dest = tmp('dlfail');
    const runs = [run(30, 1), run(20, 8), run(10, 15)];
    const r = await pull(fakeGh({ runs, downloadFails: [20] }), dest);
    assert.equal(r.ok, false);
    assert.match(text(r), /run 20 .* gh run download failed \(exit 1\)\. no valid artifacts/);
    assert.deepEqual([...heldRuns(dest).keys()], [10], 'run 30 was pulled past a failure, which would strand run 20');
    assert.deepEqual(readdirSync(dest).filter((n) => n.startsWith('.')), []);
    const gh = fakeGh({ runs });
    const again = await pull(gh, dest);
    assert.equal(again.ok, true, text(again));
    assert.deepEqual(gh.downloads(), [20, 30]);
  });

  test('refuses an artifact that is not one gpg backup, and never moves it into place', async () => {
    const f = gpgFixtures();
    for (const [label, files, want] of [
      ['plaintext', [{ name: 'supabase-backup-2026-09-29.tar.gz.gpg', data: f.plain }], /is not a gpg backup: the file does not start/],
      ['truncated', [{ name: 'supabase-backup-2026-09-29.tar.gz.gpg', data: f.big.subarray(0, 5000) }], /is not a gpg backup: the file is truncated/],
      ['empty', [{ name: 'supabase-backup-2026-09-29.tar.gz.gpg', data: Buffer.alloc(0) }], /is not a gpg backup: the file is empty/],
      ['two files', [{ name: 'supabase-backup-2026-09-29.tar.gz.gpg', data: f.small }, { name: 'extra.txt', data: 'x' }], /held 2 file\(s\)/],
      ['wrong name', [{ name: 'backup.bin', data: f.small }], /held 1 file\(s\), not one supabase-backup/],
    ]) {
      const dest = tmp('bad');
      const r = await pull(fakeGh({ runs: [run(30, 1)], artifact: { 30: files } }), dest);
      assert.equal(r.ok, false, label);
      assert.match(text(r), want, label);
      assert.equal(heldRuns(dest).size, 0, `${label}: moved into place`);
      assert.deepEqual(readdirSync(dest).filter((n) => n !== SUMS_NAME), [], `${label}: left files behind`);
    }
  });

  test('lands in the same layout whether gh extracts into --dir or a folder named after the artifact', async () => {
    const dest = tmp('nest');
    const r = await pull(fakeGh({ runs: [run(30, 1)], nest: true }), dest);
    assert.equal(r.ok, true, text(r));
    const inner = join(dest, `${dateOf(run(30, 1))}-run30`, 'supabase-backup-30');
    assert.deepEqual(readdirSync(inner), [`supabase-backup-${dateOf(run(30, 1))}.tar.gz.gpg`]);
  });

  test('clears staging folders a crashed run left, even for runs it does not pull now, and never counts them as held', async () => {
    const dest = tmp('crash');
    for (const id of [25, 30]) {
      mkdirSync(join(dest, `.partial-run${id}`, 'dl'), { recursive: true });
      writeFileSync(join(dest, `.partial-run${id}`, 'dl', 'half'), 'x');
    }
    hold(dest, run(20, 2));
    const gh = fakeGh({ runs: [run(30, 1), run(25, 1.5), run(20, 2)], downloadFails: [25] });
    const r = await pull(gh, dest);
    assert.deepEqual(gh.downloads(), [25], 'run 25 is tried first and fails, so run 30 waits');
    assert.equal(r.ok, false);
    assert.deepEqual(readdirSync(dest).filter((n) => n.startsWith('.')), [], 'a crashed staging folder was left behind');
    assert.deepEqual([...heldRuns(dest).keys()], [20]);
  });

  test('gh gets no backup secret or ping URL, and is told not to prompt or check for updates', async () => {
    const dest = tmp('env');
    const gh = fakeGh({ runs: [run(30, 1)] });
    await pullGithubBackups({
      env: { PATH: 'p', SUPABASE_SERVICE_KEY: 'k', BACKUP_PASSPHRASE: 'pp', HC_PING_URL_BACKUP_PULL: 'https://hc-ping.com/x', GITHUB_OUTPUT: 'o' },
      run: gh.impl, dest, now: NOW,
    });
    for (const c of gh.calls) {
      assert.deepEqual(Object.keys(c.opts.env).filter((k) => /SERVICE_KEY|PASSPHRASE|HC_PING|GITHUB_OUTPUT/.test(k)), []);
      assert.equal(c.opts.env.PATH, 'p');
      assert.equal(c.opts.env.GH_PROMPT_DISABLED, '1');
      assert.equal(c.opts.env.GH_NO_UPDATE_NOTIFIER, '1');
    }
  });

  test('refuses a folder inside a git work tree before calling gh at all', async () => {
    const root = tmp('git');
    mkdirSync(join(root, '.git'));
    const gh = fakeGh({ runs: [run(30, 1)] });
    const r = await pull(gh, join(root, 'backups'));
    assert.equal(r.ok, false);
    assert.match(text(r), /inside a git work tree/);
    assert.equal(gh.calls.length, 0);
  });
});

describe('staleness', () => {
  test(`fails when GitHub's newest successful backup is older than ${STALE_DAYS} days, after still pulling`, async () => {
    const dest = tmp('stale');
    const gh = fakeGh({ runs: [run(30, STALE_DAYS + 0.5)] });
    const r = await pull(gh, dest);
    assert.equal(r.ok, false);
    assert.match(r.summary, /STALE: the weekly GitHub backup has stopped \(its newest successful run is 9 days 12 hours old, past the 9-day limit\)/);
    // Just past the limit must not read as the limit itself.
    const edge = await pull(fakeGh({ runs: [run(31, STALE_DAYS + 1 / 24)] }), tmp('edge'));
    assert.match(edge.summary, /is 9 days 1 hours old, past the 9-day limit/);
    assert.deepEqual(gh.downloads(), [30], 'a stale backup is still worth holding');
    const fresh = await pull(fakeGh({ runs: [run(30, STALE_DAYS - 0.1)] }), tmp('fresh9'));
    assert.equal(fresh.ok, true, text(fresh));
  });

  test('ages print in whole days and hours, exactly', () => {
    assert.equal(ageText(9 * DAY + 3_600_000), '9 days 1 hours');
    assert.equal(ageText(4 * DAY - 1), '3 days 23 hours');
    assert.equal(ageText(0), '0 days 0 hours');
  });

  test('no successful run at all is stale, and so is none listed', async () => {
    const r = await pull(fakeGh({ runs: [run(30, 1, 'failure')] }), tmp('nosuccess'));
    assert.equal(r.ok, false);
    assert.match(r.summary, /STALE: .*does not exist/);
  });

  test('a list that fails is a failure with gh\'s reason, and the held files are still checked', async () => {
    const dest = tmp('listfail');
    hold(dest, run(20, 1));
    const gh = fakeGh({ listFails: 'HTTP 403: account suspended' });
    const r = await pull(gh, dest);
    assert.equal(r.ok, false);
    assert.match(text(r), /could not list GitHub's backup runs \(gh exit 1\)\. HTTP 403: account suspended/);
    assert.equal(gh.calls.length, 1);
    assert.ok(existsSync(join(dest, SUMS_NAME)), 'held files were not checked and recorded');
  });
});

describe('what is already held', () => {
  test('a held file that changed after SHA256SUMS recorded it fails, and SUMS keeps the old record', async () => {
    const dest = tmp('changed');
    const file = hold(dest, run(20, 1));
    assert.equal((await pull(fakeGh({ runs: [run(20, 1)] }), dest)).ok, true);
    const before = readFileSync(join(dest, SUMS_NAME), 'utf8');
    writeFileSync(file, gpgFixtures().big);
    const r = await pull(fakeGh({ runs: [run(20, 1)] }), dest);
    assert.equal(r.ok, false);
    assert.match(text(r), /changed since SHA256SUMS recorded it/);
    assert.equal(readFileSync(join(dest, SUMS_NAME), 'utf8'), before);
  });

  test('a recorded file that is gone fails, and so does an unreadable SUMS line', async () => {
    const dest = tmp('gone');
    hold(dest, run(20, 1));
    writeFileSync(join(dest, SUMS_NAME), `${'0'.repeat(64)}  2026-01-01-run1/supabase-backup-1/supabase-backup-2026-01-01.tar.gz.gpg\nnot a sums line\n`);
    const r = await pull(fakeGh({ runs: [run(20, 1)] }), dest);
    assert.equal(r.ok, false);
    assert.match(text(r), /2026-01-01-run1\/.* is in SHA256SUMS but is gone/);
    assert.match(text(r), /unreadable line\(s\): 2/);
  });

  test('a held folder with no backup in it, or a held file that is truncated, fails', async () => {
    const dest = tmp('damaged');
    mkdirSync(join(dest, '2026-09-01-run7', 'supabase-backup-7'), { recursive: true });
    hold(dest, run(20, 1), gpgFixtures().small.subarray(0, 100));
    const r = await pull(fakeGh({ runs: [run(20, 1)] }), dest);
    assert.equal(r.ok, false);
    assert.match(text(r), /2026-09-01-run7 holds no supabase-backup/);
    assert.match(text(r), /supabase-backup-.*\.tar\.gz\.gpg: the file is truncated/);
    assert.ok(!existsSync(join(dest, SUMS_NAME)), 'SUMS recorded a damaged file');
  });

  test('follows a link to a folder, as OneDrive presents a cloud-only file', async () => {
    const dest = tmp('link');
    const real = join(tmp('real'), 'supabase-backup-20');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, `supabase-backup-${dateOf(run(20, 1))}.tar.gz.gpg`), gpgFixtures().small);
    mkdirSync(join(dest, `${dateOf(run(20, 1))}-run20`));
    symlinkSync(real, join(dest, `${dateOf(run(20, 1))}-run20`, 'supabase-backup-20'), 'junction');
    const r = await pull(fakeGh({ runs: [run(20, 1)] }), dest);
    assert.equal(r.ok, true, text(r));
    assert.match(readFileSync(join(dest, SUMS_NAME), 'utf8'), /-run20\/supabase-backup-20\/supabase-backup-/);
  });
});

describe('the command line', () => {
  test('takes --dest and --help, and refuses anything else', () => {
    assert.deepEqual(parseArgs(['--dest', 'x']), { dest: 'x', help: false });
    assert.equal(parseArgs(['--help']).help, true);
    assert.throws(() => parseArgs(['--token', 'x']), /unknown argument/);
    assert.throws(() => parseArgs(['--dest']), /unknown argument/);
  });

  test('end to end with a gh that cannot start: exit 1, the reason printed, the held files still checked', () => {
    const dest = tmp('cli');
    hold(dest, run(20, 1));
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'ops', 'pull-github-backups.mjs'), '--dest', dest], {
      encoding: 'utf8', env: { ...process.env, GH_BIN: join(dest, 'no-such-gh.exe') },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL: .*could not list|could not list GitHub's backup runs \(gh could not start/);
    assert.ok(existsSync(join(dest, SUMS_NAME)));
  });
});
