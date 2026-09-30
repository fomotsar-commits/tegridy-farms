// Copy the weekly Supabase backups GitHub Actions makes into a folder GitHub does not own.
// One `gh run list`, then one `gh run download` per new run, at most three, one at a time:
// a burst of gh calls preceded the 2026-09-24 suspension. Layout, as downloaded on 09-29:
//   <dest>\<date>-run<id>\supabase-backup-<id>\supabase-backup-<date>.tar.gz.gpg

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ANY_BACKUP_RE, sha256, withoutSecrets } from './backup.mjs';
import { gitWorkTreeAbove } from './env-file.mjs';

export const REPO = 'fomotsar-commits/tegridy-farms';
export const WORKFLOW = 'supabase-backup.yml';
export const LIST_LIMIT = 20;
export const MAX_DOWNLOADS = 3;
export const STALE_DAYS = 9;
export const LIST_TIMEOUT_MS = 2 * 60_000;
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const SUMS_NAME = 'SHA256SUMS';
export const RUN_DIR_RE = /^(\d{4}-\d{2}-\d{2})-run(\d+)$/;
const STAGING_RE = /^\.partial-run\d+$/;
const DAY = 86_400_000;
// No prompt, no spinner, and no update check (that would be one more GitHub request).
const GH_QUIET = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' };

export const artifactName = (id) => `supabase-backup-${id}`;
// Whole days and hours, counted from milliseconds: fractional days can print 9d 1h as 9d 0h.
export function ageText(ms) {
  const hours = Math.floor(ms / 3_600_000);
  return `${Math.floor(hours / 24)} days ${hours % 24} hours`;
}

export function defaultPullDir(env = process.env) {
  return env.BACKUP_PULL_DIR || join(homedir(), 'OneDrive', 'backups', 'supabase-github');
}

export function ghEnv(env) {
  const e = { ...withoutSecrets(env), ...GH_QUIET };
  delete e.GITHUB_OUTPUT;
  delete e.GITHUB_STEP_SUMMARY;
  return e;
}

export const listArgs = () => ['run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--status', 'success',
  '--limit', String(LIST_LIMIT), '--json', 'databaseId,createdAt,conclusion,event,headBranch'];
export const downloadArgs = (id, dir) => ['run', 'download', String(id), '--repo', REPO, '--name', artifactName(id), '--dir', dir];

/** Successful runs, newest id first. Throws on output that is not the JSON gh prints. */
export function parseRunList(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    throw new Error('gh run list did not print JSON');
  }
  if (!Array.isArray(rows)) throw new Error('gh run list did not print a list');
  const runs = [];
  for (const r of rows) {
    const at = Date.parse(r?.createdAt);
    if (!Number.isSafeInteger(r?.databaseId) || r.databaseId <= 0 || !Number.isFinite(at)) {
      throw new Error(`gh run list returned a run with no usable id or date: ${JSON.stringify(r).slice(0, 200)}`);
    }
    if (r.conclusion !== 'success') continue;
    const iso = new Date(at).toISOString();
    runs.push({ id: r.databaseId, createdAt: iso, date: iso.slice(0, 10) });
  }
  return runs.sort((a, b) => b.id - a.id);
}

// ---- OpenPGP framing (RFC 9580 section 4.2) -----------------------------------------------

function newFormatLength(buf, at) {
  const o1 = buf[at];
  if (o1 === undefined) return null;
  if (o1 < 192) return { hdr: 1, len: o1, partial: false };
  if (o1 < 224) return at + 1 < buf.length ? { hdr: 2, len: ((o1 - 192) << 8) + buf[at + 1] + 192, partial: false } : null;
  if (o1 === 255) return at + 4 < buf.length ? { hdr: 5, len: buf.readUInt32BE(at + 1), partial: false } : null;
  return { hdr: 1, len: 1 << (o1 & 0x1f), partial: true };
}

/** { tag, body, len, partial, toEof } for the packet at `at`, or null. */
export function packetHeader(buf, at) {
  const b = buf[at];
  if (b === undefined || !(b & 0x80)) return null;
  if (b & 0x40) {
    const l = newFormatLength(buf, at + 1);
    return l && { tag: b & 0x3f, body: at + 1 + l.hdr, len: l.len, partial: l.partial, toEof: false };
  }
  const type = b & 3;
  const tag = (b >> 2) & 0x0f;
  if (type === 3) return { tag, body: at + 1, len: buf.length - at - 1, partial: false, toEof: true };
  const n = [1, 2, 4][type];
  if (at + n >= buf.length) return null;
  return { tag, body: at + 1 + n, len: buf.readUIntBE(at + 1, n), partial: false, toEof: false };
}

function packetEnd(buf, p) {
  let pos = p.body + p.len;
  if (!p.partial) return pos;
  for (let chunks = 0; chunks < 1_000_000; chunks++) {
    const l = newFormatLength(buf, pos);
    if (!l) return Infinity;
    pos += l.hdr + l.len;
    if (!l.partial) return pos;
  }
  return Infinity;
}

/**
 * Why `buf` is not gpg --symmetric AES256 output, or null. It must open with a symmetric-key
 * session key packet (tag 3) for AES256, then one encrypted data packet (tag 18, or 20 for
 * AEAD) that ends exactly at the end of the file, so a truncated copy fails too.
 */
export function openPgpProblem(buf) {
  if (!buf || buf.length === 0) return 'the file is empty';
  const skesk = packetHeader(buf, 0);
  if (!skesk) return 'the file does not start with an OpenPGP packet';
  if (skesk.tag !== 3) return `the first packet is tag ${skesk.tag}, not a symmetric-key session key (tag 3)`;
  if (skesk.partial || skesk.toEof) return 'the session key packet has no fixed length';
  const version = buf[skesk.body];
  if (![4, 5, 6].includes(version)) return `the session key packet is version ${version}, not 4, 5 or 6`;
  const cipher = buf[skesk.body + (version === 6 ? 2 : 1)];
  if (cipher !== 9) return `the cipher is ${cipher}, not AES256 (9)`;
  const data = packetHeader(buf, skesk.body + skesk.len);
  if (!data || ![18, 20].includes(data.tag)) return 'no encrypted data packet follows the session key';
  const end = packetEnd(buf, data);
  if (end > buf.length) return 'the file is truncated: the encrypted data runs past its end';
  if (end < buf.length) return `${buf.length - end} unexpected bytes follow the encrypted data`;
  return null;
}

// ---- The folder ---------------------------------------------------------------------------

/** Every file under `dir`. statSync follows links: OneDrive shows cloud-only files as reparse points. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Run id -> folder name, for every <date>-run<id> folder in `dest`. */
export function heldRuns(dest) {
  const held = new Map();
  if (!existsSync(dest)) return held;
  for (const name of readdirSync(dest)) {
    const m = RUN_DIR_RE.exec(name);
    if (m && statSync(join(dest, name)).isDirectory()) held.set(Number(m[2]), name);
  }
  return held;
}

export function parseSums(text) {
  const sums = new Map();
  const bad = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (m) sums.set(m[2], m[1]);
    else bad.push(i + 1);
  });
  return { sums, bad };
}

/** Download one run into a staging folder, check it, then move it into place. Returns a problem or null. */
async function pullOne({ run, gh, env, dest, item }) {
  const staging = join(dest, `.partial-run${item.id}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    const dl = join(staging, 'dl');
    mkdirSync(dl, { recursive: true });
    const r = await run(gh, downloadArgs(item.id, dl), { env, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (r.error || r.timedOut || r.code !== 0) {
      const how = r.error ? `could not start: ${r.error}` : r.timedOut ? 'timed out' : `exit ${r.code}`;
      return `run ${item.id} (${item.date}): gh run download failed (${how}). ${String(r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ')}`.trim();
    }
    const files = walk(dl);
    const backups = files.filter((f) => ANY_BACKUP_RE.test(basename(f)));
    if (files.length !== 1 || backups.length !== 1) {
      return `run ${item.id} (${item.date}): the artifact held ${files.length} file(s), not one supabase-backup-<date>.tar.gz.gpg (${files.map((f) => basename(f)).join(', ') || 'none'})`;
    }
    const bad = openPgpProblem(readFileSync(backups[0]));
    if (bad) return `run ${item.id} (${item.date}): ${basename(backups[0])} is not a gpg backup: ${bad}`;
    const out = join(staging, 'out', artifactName(item.id));
    mkdirSync(out, { recursive: true });
    renameSync(backups[0], join(out, basename(backups[0])));
    renameSync(join(staging, 'out'), join(dest, `${item.date}-run${item.id}`));
    return null;
  } catch (e) {
    return `run ${item.id} (${item.date}): ${e.message}`;
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Pull the newest successful backups GitHub holds that `dest` does not, then check every
 * file there and write SHA256SUMS. Fails when anything is wrong, and when GitHub's newest
 * successful backup is older than STALE_DAYS (the weekly backup stopped).
 * Returns { ok, summary, lines, pulled }.
 */
export async function pullGithubBackups({ env = process.env, run, dest, gh, now = Date.now() } = {}) {
  dest = resolve(dest || defaultPullDir(env));
  gh = gh || env.GH_BIN || 'gh';
  const lines = [`Folder: ${dest}`];
  const problems = [];
  const repoAbove = gitWorkTreeAbove(dest);
  if (repoAbove) {
    return { ok: false, summary: 'refusing a folder inside a git work tree', lines: [...lines, `- ${dest} is inside ${repoAbove}. Backups must not be committable.`], pulled: [] };
  }
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(dest)) if (STAGING_RE.test(name)) rmSync(join(dest, name), { recursive: true, force: true });

  const childEnv = ghEnv(env);
  let runs = null;
  const listed = await run(gh, listArgs(), { env: childEnv, timeoutMs: LIST_TIMEOUT_MS });
  if (listed.error || listed.timedOut || listed.code !== 0) {
    const how = listed.error ? `could not start: ${listed.error}` : listed.timedOut ? 'timed out' : `exit ${listed.code}`;
    problems.push(`could not list GitHub's backup runs (gh ${how}). ${String(listed.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ')}`.trim());
  } else {
    try {
      runs = parseRunList(listed.stdout);
    } catch (e) {
      problems.push(e.message);
    }
  }

  let stale = null;
  const pulled = [];
  if (runs) {
    const newest = runs.reduce((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
    const ageMs = newest ? now - Date.parse(newest.createdAt) : Infinity;
    const age = ageMs / DAY;
    lines.push(newest
      ? `GitHub: ${runs.length} successful ${WORKFLOW} run(s) listed; the newest is run ${newest.id} from ${newest.date}, ${ageText(ageMs)} ago.`
      : `GitHub: no successful ${WORKFLOW} run is listed at all.`);
    if (age > STALE_DAYS) stale = newest ? `is ${ageText(ageMs)} old, past the ${STALE_DAYS}-day limit` : 'does not exist';

    // Only runs newer than the newest one held: older gaps are runs whose artifacts never
    // existed or have expired. Newest three first, downloaded oldest first, stopping at the
    // first failure, so a failed run is retried next time instead of left behind.
    const before = heldRuns(dest);
    const mark = Math.max(0, ...before.keys());
    const fresh = runs.filter((r) => r.id > mark && !before.has(r.id));
    const pick = fresh.slice(0, MAX_DOWNLOADS).reverse();
    for (const r of fresh.slice(MAX_DOWNLOADS)) {
      problems.push(`run ${r.id} (${r.date}) is left on GitHub only: at most ${MAX_DOWNLOADS} runs are pulled at a time, newest first. Download it by hand if you want it.`);
    }
    for (const item of pick) {
      const bad = await pullOne({ run, gh, env: childEnv, dest, item });
      if (bad) {
        problems.push(bad);
        break;
      }
      pulled.push(item);
      lines.push(`- pulled run ${item.id} (${item.date})`);
    }
  }

  // Every file held, new or old: the right framing, and unchanged since SHA256SUMS saw it.
  const fileProblems = [];
  const current = new Map();
  const held = heldRuns(dest);
  for (const folder of [...held.values()].sort()) {
    const files = walk(join(dest, folder)).filter((f) => ANY_BACKUP_RE.test(basename(f)));
    if (!files.length) fileProblems.push(`${folder} holds no supabase-backup-*.tar.gz.gpg file`);
    for (const f of files) {
      const buf = readFileSync(f);
      const rel = relative(dest, f).split(sep).join('/');
      const bad = openPgpProblem(buf);
      if (bad) fileProblems.push(`${rel}: ${bad}`);
      current.set(rel, sha256(buf));
    }
  }
  const sumsPath = join(dest, SUMS_NAME);
  const { sums, bad } = existsSync(sumsPath) ? parseSums(readFileSync(sumsPath, 'utf8')) : { sums: new Map(), bad: [] };
  if (bad.length) fileProblems.push(`${SUMS_NAME} has unreadable line(s): ${bad.join(', ')}`);
  for (const [rel, hex] of sums) {
    if (!current.has(rel)) fileProblems.push(`${rel} is in ${SUMS_NAME} but is gone. If you removed it on purpose, delete its line there.`);
    else if (current.get(rel) !== hex) fileProblems.push(`${rel} changed since ${SUMS_NAME} recorded it. Restore it from another copy; do not re-record it.`);
  }
  problems.push(...fileProblems);
  if (fileProblems.length) {
    lines.push(`${SUMS_NAME} was not rewritten, so it still holds the last good record.`);
  } else {
    const text = [...current].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, hex]) => `${hex}  ${rel}\n`).join('');
    writeFileSync(`${sumsPath}.tmp`, text);
    renameSync(`${sumsPath}.tmp`, sumsPath);
    lines.push(`Held: ${held.size} run(s), ${current.size} file(s), each an AES256 gpg file of the right length. ${SUMS_NAME} lists them.`);
  }

  if (stale) {
    lines.push(`STALE: GitHub's newest successful backup ${stale}. Look at ${WORKFLOW} in GitHub's Actions tab.`,
      'If GitHub is gone, switch to the failover runner and take a backup by hand (docs/OPS_SCHEDULER.md).');
  }
  lines.push(...problems.map((p) => `- ${p}`));
  const ok = !stale && problems.length === 0;
  const summary = stale
    ? `STALE: the weekly GitHub backup has stopped (its newest successful run ${stale})`
    : problems.length
      ? `${problems.length} problem(s)${pulled.length ? `; pulled ${pulled.length}` : ''}`
      : `${pulled.length ? `pulled ${pulled.length} new backup(s)` : 'nothing new to pull'}; ${held.size} held`;
  return { ok, summary, lines, pulled };
}
