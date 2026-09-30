// OpenPGP symmetric encryption by shelling out to gpg: the same cipher and format the
// GitHub workflow used, so supabase/RESTORE.md step 1 decrypts either one. The passphrase
// is the first line of stdin and the data follows it, so neither touches argv or disk.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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

function run(gpg, args, passphrase, data, childEnv) {
  checkPassphrase(passphrase);
  const r = spawnSync(gpg, args, {
    input: Buffer.concat([Buffer.from(`${passphrase}\n`, 'utf8'), data]),
    maxBuffer: MAX_BUFFER,
    env: childEnv,
  });
  if (r.error) throw new Error(`gpg could not run: ${r.error.message}`);
  // Exit status is the verdict: gpg can write ciphertext and still exit 2.
  if (r.status !== 0) {
    throw new Error(`gpg exited ${r.status}: ${String(r.stderr || '').trim().slice(0, 400)}`);
  }
  if (!r.stdout || r.stdout.length === 0) throw new Error('gpg exited 0 but produced no output');
  return r.stdout;
}

export function gpgEncrypt(gpg, passphrase, plaintext, childEnv) {
  return run(gpg, ENCRYPT_ARGS, passphrase, plaintext, childEnv);
}

/** Decrypt ciphertext held in memory (read the file first). */
export function gpgDecrypt(gpg, passphrase, ciphertext, childEnv) {
  return run(gpg, DECRYPT_ARGS, passphrase, ciphertext, childEnv);
}
