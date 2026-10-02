// OpenPGP symmetric encryption by shelling out to gpg: the same cipher and format the
// GitHub workflow used, so supabase/RESTORE.md step 1 decrypts either one. The passphrase
// is the first line of stdin and the data follows it, so neither touches argv or disk.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:\\Program Files\\Git\\usr\\bin\\gpg.exe',
  'C:\\Program Files\\GnuPG\\bin\\gpg.exe',
  'C:\\Program Files (x86)\\GnuPG\\bin\\gpg.exe',
];

// --no-options ignores the user's gpg.conf (an `armor` or cipher line there would change
// the output); --no-symkey-cache keeps gpg-agent from remembering the passphrase.
const COMMON = ['--batch', '--no-options', '--no-symkey-cache', '--pinentry-mode', 'loopback', '--passphrase-fd', '0'];
export const ENCRYPT_ARGS = [...COMMON, '--yes', '--symmetric', '--cipher-algo', 'AES256', '--output', '-'];
export const DECRYPT_ARGS = [...COMMON, '--decrypt'];

const MAX_BUFFER = 1024 * 1024 * 1024;
// One gpg call's limit; the jobs' time budget counts on it (run-job.test.mjs).
export const GPG_TIMEOUT_MS = 2 * 60_000;

/** GPG_BIN, then `gpg` on PATH, then the usual Windows install paths. Throws if none runs. */
export function findGpg(env = process.env) {
  const tries = [env.GPG_BIN, 'gpg', ...(process.platform === 'win32' ? CANDIDATES : [])].filter(Boolean);
  for (const bin of tries) {
    if (bin !== 'gpg' && !existsSync(bin)) continue;
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /GnuPG/.test(r.stdout)) return bin;
  }
  throw new Error(`gpg not found (tried: ${tries.join(', ')}). Install Git for Windows or GnuPG, or set GPG_BIN.`);
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('empty passphrase');
  if (/[\r\n]/.test(passphrase)) throw new Error('passphrase contains a line break; gpg would read only part of it');
}

// Whether a gpg reads paths as /c/..., by binary. Asked once, below.
const readsPosixPaths = new Map();

/**
 * `dir` as this gpg reads it. MSYS gpg (Git for Windows) reads C:\... as a path relative to
 * its working directory, so it needs /c/...; it shows which it is by printing the home it was
 * handed as /c/<cwd>/C:\... . The probe spends from the call's own time limit.
 */
function homedirFor(gpg, dir, timeout) {
  if (!/^[A-Za-z]:\\/.test(dir)) return dir;
  if (!readsPosixPaths.has(gpg)) {
    const home = /^Home: (.*)$/m.exec(spawnSync(gpg, ['--homedir', dir, '--version'], { encoding: 'utf8', timeout }).stdout || '');
    if (!home) return dir; // unanswered: the real call reports whatever is wrong
    readsPosixPaths.set(gpg, home[1].startsWith('/'));
  }
  return readsPosixPaths.get(gpg) ? `/${dir[0].toLowerCase()}${dir.slice(2).replace(/\\/g, '/')}` : dir;
}

// Every call runs in a gpg home of its own, made fresh (mkdtemp: mode 0700) and removed after.
// In the user's home, --no-options stops gpg creating it, so wherever it had never been made
// (a new runner, PC or Windows user) every call exited 2: "keyblock resource
// .../pubring.kbx: No such file or directory". Its own home also keeps the user's keyrings and
// agent out of it. gpg starts an agent there, which exits by itself once the home is gone.
function run(gpg, args, passphrase, data, childEnv, timeoutMs = GPG_TIMEOUT_MS) {
  checkPassphrase(passphrase);
  const deadline = Date.now() + timeoutMs;
  const home = mkdtempSync(join(tmpdir(), 'ops-gpg-'));
  let r;
  try {
    r = spawnSync(gpg, ['--homedir', homedirFor(gpg, home, timeoutMs), ...args], {
      input: Buffer.concat([Buffer.from(`${passphrase}\n`, 'utf8'), data]),
      maxBuffer: MAX_BUFFER,
      env: childEnv,
      timeout: Math.max(1, deadline - Date.now()),
    });
  } finally {
    // Best effort: a home that will not delete holds no secret (an empty keyring, a random seed).
    try { rmSync(home, { recursive: true, force: true }); } catch { /* left in the temp folder */ }
  }
  if (r.error?.code === 'ETIMEDOUT') throw new Error(`gpg did not finish within its ${timeoutMs} ms limit`);
  if (r.error) throw new Error(`gpg could not run: ${r.error.message}`);
  // Exit status is the verdict: gpg can write ciphertext and still exit 2.
  if (r.status !== 0) {
    throw new Error(`gpg exited ${r.status}: ${String(r.stderr || '').trim().slice(0, 400)}`);
  }
  if (!r.stdout || r.stdout.length === 0) throw new Error('gpg exited 0 but produced no output');
  return r.stdout;
}

export function gpgEncrypt(gpg, passphrase, plaintext, childEnv, timeoutMs) {
  return run(gpg, ENCRYPT_ARGS, passphrase, plaintext, childEnv, timeoutMs);
}

/** Decrypt ciphertext held in memory (read the file first). */
export function gpgDecrypt(gpg, passphrase, ciphertext, childEnv) {
  return run(gpg, DECRYPT_ARGS, passphrase, ciphertext, childEnv);
}
