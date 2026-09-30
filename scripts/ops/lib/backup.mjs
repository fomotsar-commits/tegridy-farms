// Take, verify, keep and read Supabase backups. The file format is the GitHub workflow's:
// gpg(AES256) of tar.gz holding backup/<table>.json, so supabase/RESTORE.md step 1 and
// frontend/scripts/supabase-restore.mjs work on either one without change.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isUsableRestore, planBundle, RESTORE_ORDER } from '../../../frontend/scripts/supabase-restore.mjs';
import { gitWorkTreeAbove } from './env-file.mjs';
import { findGpg, gpgDecrypt, gpgEncrypt } from './gpg.mjs';
import { describeResults, dumpAll, TABLES } from './supabase-dump.mjs';
import { createTar, readTar } from './tar.mjs';

/** Files this tool writes (and the only ones rotation may delete). */
export const NAME_RE = /^supabase-backup-(\d{4}-\d{2}-\d{2}T\d{6}Z)\.tar\.gz\.gpg$/;
/** Also the GitHub artifacts' names, for --latest. Never used to delete. */
export const ANY_BACKUP_RE = /^supabase-backup-\d{4}-\d{2}-\d{2}(T\d{6}Z)?\.tar\.gz\.gpg$/;
export const DEFAULT_KEEP = 26;
export const SECRET_NAMES = ['SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE'];

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function backupName(date) {
  const iso = date.toISOString();
  return `supabase-backup-${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z.tar.gz.gpg`;
}

export function defaultBackupDir(env = process.env) {
  return env.BACKUP_DIR || join(homedir(), 'OneDrive', 'backups', 'supabase');
}

/** The environment a child process gets: no secrets, no ping URLs. */
export function withoutSecrets(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (SECRET_NAMES.includes(k) || k.startsWith('HC_PING_URL_')) delete out[k];
  }
  return out;
}

export function buildBundle(results, { mtime } = {}) {
  const entries = [{ name: 'backup/', dir: true }];
  for (const r of results) {
    entries.push({ name: `backup/${r.table}.json`, data: Buffer.from(`${JSON.stringify(r.rows, null, 2)}\n`, 'utf8') });
  }
  return gzipSync(createTar(entries, { mtime }), { level: 9 });
}

/** Keep the newest `keep` files this tool wrote; never touch `protect` or any other file. */
export function rotate(dir, keep, protect) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a whole number of at least 1 (got ${keep})`);
  const ours = readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse();
  const doomed = ours.slice(keep).filter((f) => f !== protect);
  for (const f of doomed) {
    unlinkSync(join(dir, f));
    if (existsSync(join(dir, `${f}.sha256`))) unlinkSync(join(dir, `${f}.sha256`));
  }
  return doomed;
}

function parseKeep(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_KEEP;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`BACKUP_KEEP / --keep must be a whole number of at least 1 (got ${value})`);
  return n;
}

/**
 * One backup, end to end. Returns { ok, lines, file? }. Nothing is written unless every
 * table was read whole, and the file is decrypted back and compared byte for byte before
 * it takes its final name. Rotation runs only after that.
 */
export async function runBackup({
  env = process.env, fetchImpl = fetch, dest, keep, now = new Date(), gpgBin,
  cipher = { encrypt: gpgEncrypt, decrypt: gpgDecrypt },
} = {}) {
  const lines = [];
  const failWith = (...msg) => ({ ok: false, lines: [...lines, ...msg] });

  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'BACKUP_PASSPHRASE'].filter((k) => !env[k]);
  if (missing.length) {
    return failWith(`Supabase backup not configured: missing ${missing.join(' ')}. No backup has been taken.`);
  }
  let base;
  try {
    base = new URL(env.SUPABASE_URL);
  } catch {
    return failWith('SUPABASE_URL is not a URL. No backup has been taken.');
  }
  if (base.protocol !== 'https:') return failWith('SUPABASE_URL must be https (the service key rides on every request). No backup has been taken.');
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const passphrase = env.BACKUP_PASSPHRASE;
  if (/[\r\n]/.test(passphrase)) return failWith('BACKUP_PASSPHRASE contains a line break. No backup has been taken.');

  let keepN;
  try {
    keepN = parseKeep(keep ?? env.BACKUP_KEEP);
  } catch (e) {
    return failWith(e.message);
  }
  const dir = resolve(dest || defaultBackupDir(env));
  const repo = gitWorkTreeAbove(dir);
  if (repo) return failWith(`refusing to write backups to ${dir}: it is inside the git work tree ${repo}.`);

  let gpg;
  try {
    gpg = gpgBin || findGpg(env);
  } catch (e) {
    return failWith(e.message);
  }

  const dump = await dumpAll({ baseUrl, key: env.SUPABASE_SERVICE_KEY, fetchImpl });
  lines.push(`Tables (${TABLES.length}):`, ...describeResults(dump.results));
  if (!dump.ok) {
    return failWith(
      '',
      `INCOMPLETE: ${dump.bad.map((r) => `${r.table} (${r.status})`).join(', ')}.`,
      'Nothing was written: a partial backup must never look like a backup.',
    );
  }

  const childEnv = withoutSecrets(env);
  const bundle = buildBundle(dump.results, { mtime: Math.floor(now.getTime() / 1000) });
  const name = backupName(now);
  const file = join(dir, name);
  const partial = `${file}.partial`;
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(file)) return failWith(`${file} already exists; refusing to overwrite it.`);
    writeFileSync(partial, cipher.encrypt(gpg, passphrase, bundle, childEnv), { flag: 'wx' });
    const onDisk = readFileSync(partial);
    if (!cipher.decrypt(gpg, passphrase, onDisk, childEnv).equals(bundle)) {
      unlinkSync(partial);
      return failWith('The encrypted file did not decrypt back to the same bundle. Nothing was kept.');
    }
    renameSync(partial, file);
    const digest = sha256(onDisk);
    writeFileSync(`${file}.sha256`, `${digest}  ${name}\n`);
    lines.push('', `Wrote ${file}`, `  ${onDisk.length} bytes, sha256 ${digest}`, '  decrypted back and matched before it was kept');
  } catch (e) {
    try { if (existsSync(partial)) unlinkSync(partial); } catch { /* reported below */ }
    return failWith('', `Writing the backup failed: ${e.message}`);
  }

  if (passphrase.length < 16) {
    lines.push('', 'WARNING: BACKUP_PASSPHRASE is under 16 characters. If your offline copy is longer, the env file cut it: check its quoting and run supabase-restore-check.mjs --prompt.');
  }
  try {
    const gone = rotate(dir, keepN, name);
    lines.push(`Kept the newest ${keepN}; removed ${gone.length}${gone.length ? `: ${gone.join(', ')}` : ''}.`);
  } catch (e) {
    lines.push(`WARNING: the backup is written, but rotation failed: ${e.message}`);
  }
  return { ok: true, lines, file };
}

/** backup/<table>.json entries of a decrypted bundle, plus anything else it holds. */
export function readBundleTables(tarGz) {
  const byTable = new Map();
  const stray = [];
  for (const e of readTar(gunzipSync(tarGz))) {
    if (e.type !== 'file') continue;
    const m = /^(?:\.\/)?backup\/([^/]+)\.json$/.exec(e.name);
    if (m) byTable.set(m[1], e.data);
    else stray.push(e.name);
  }
  return { byTable, stray };
}

/** Decrypt a backup and count its rows. Returns { ok, lines }; never prints row contents. */
export function checkBackupFile({ file, passphrase, gpgBin, env = process.env }) {
  const lines = [`Backup: ${file}`];
  const bytes = readFileSync(file);
  let ok = true;
  const sidecar = `${file}.sha256`;
  if (existsSync(sidecar)) {
    const want = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    if (want !== sha256(bytes)) {
      return { ok: false, lines: [...lines, `CHECKSUM MISMATCH: ${sidecar} says ${want}, the file hashes to ${sha256(bytes)}.`] };
    }
    lines.push('  sha256 matches its .sha256 file');
  } else {
    lines.push('  no .sha256 beside it, so integrity was not checked (GitHub-made backups have none)');
  }
  let tarGz;
  try {
    tarGz = gpgDecrypt(gpgBin || findGpg(env), passphrase, bytes, withoutSecrets(env));
  } catch (e) {
    return { ok: false, lines: [...lines, `DOES NOT DECRYPT with this passphrase: ${e.message}`] };
  }
  const { byTable, stray } = readBundleTables(tarGz);
  const plan = planBundle(RESTORE_ORDER, (t) => {
    if (!byTable.has(t)) return { present: false };
    try {
      return { present: true, rows: JSON.parse(byTable.get(t).toString('utf8')) };
    } catch (e) {
      return { present: true, parseError: e.message };
    }
  });
  for (const r of plan) {
    const n = Array.isArray(r.rows) ? `${r.rows.length} rows` : '-';
    lines.push(`  ${r.status.padEnd(10)} ${r.table.padEnd(20)} ${n}${r.status === 'absent' || r.status === 'unreadable' ? `  (${r.detail})` : ''}`);
  }
  if (stray.length) lines.push(`  other files in the bundle: ${stray.join(', ')}`);
  if (!isUsableRestore(plan)) {
    ok = false;
    lines.push('NOT A USABLE RESTORE POINT: a table is absent or unreadable.');
  } else {
    lines.push(`Readable: all ${plan.length} tables present.`);
  }
  return { ok, lines };
}

/** Newest backup file in `dir` by the timestamp in its name (ours or GitHub's), or null. */
export function latestBackup(dir) {
  if (!existsSync(dir)) return null;
  const all = readdirSync(dir).filter((f) => ANY_BACKUP_RE.test(f)).sort();
  return all.length ? join(dir, all[all.length - 1]) : null;
}
