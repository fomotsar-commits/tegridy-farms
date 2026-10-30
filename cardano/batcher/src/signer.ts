// The batcher's signing key: made on the server (the owner's ruling: never copied), into a
// cardano-cli style key file only its owner can read. Only its key hash and address are ever
// printed or logged.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { Signer } from './watcher.ts';

/** A cardano-cli payment signing key file: {"type": "PaymentSigningKeyShelley_ed25519", "cborHex": "5820<32 bytes>"}. */
export function keyFromFile(path: string): CSL.PrivateKey {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`the key file ${path} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}): is the volume mounted, and the file the batcher's own?`);
  }
  let file: { type?: unknown; cborHex?: unknown };
  try {
    file = JSON.parse(text) as typeof file;
  } catch {
    throw new Error(`the key file ${path} is not readable JSON`);
  }
  if (file.type !== 'PaymentSigningKeyShelley_ed25519' || typeof file.cborHex !== 'string' || !/^5820[0-9a-f]{64}$/.test(file.cborHex)) throw new Error(`the key file ${path} is not a payment signing key`);
  return CSL.PrivateKey.from_normal_bytes(Buffer.from(file.cborHex.slice(4), 'hex'));
}

/**
 * Makes a new signing key at `path`, which must not exist (a key is never overwritten), readable
 * by its owner only. It is written whole to `<path>.new` and forced to disk, then linked to `path`
 * (a link, unlike a rename, never replaces a file) and the folder forced to disk: a process killed
 * at any point leaves either no key at `path` or the whole key, and the hash is returned only after.
 * A `.new` left by such a kill was never shown, so nothing was funded: it is replaced. On Windows,
 * Node ignores the file mode: the file's access list is cut down to the current user (icacls)
 * before the key is written into it, and if that fails the file is deleted. Returns what may be
 * shown: the key hash and the enterprise address to fund.
 */
export function makeKeyFile(path: string, network: number): { keyHash: string; address: string } {
  if (existsSync(path)) throw new Error(`${path} exists: a batcher key is never overwritten`);
  const key = CSL.PrivateKey.generate_ed25519();
  const cborHex = `5820${Buffer.from(key.as_bytes()).toString('hex')}`;
  const tmp = `${path}.new`;
  rmSync(tmp, { force: true });
  try {
    closeSync(openSync(tmp, 'wx', 0o600));
    if (process.platform === 'win32') {
      const user = process.env.USERNAME;
      try {
        if (!user) throw new Error('USERNAME is not set');
        execFileSync('icacls', [tmp, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'pipe' });
      } catch (e) {
        throw new Error(`the key file's access could not be limited to ${user ?? 'this user'}, so no key was made: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const fd = openSync(tmp, 'r+');
    try {
      writeSync(fd, `${JSON.stringify({ type: 'PaymentSigningKeyShelley_ed25519', description: 'Batcher signing key', cborHex }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} exists: a batcher key is never overwritten`);
      throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  // Windows cannot open a folder to force it to disk; NTFS journals the link itself.
  if (process.platform !== 'win32') {
    const dir = openSync(dirname(path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  const keyHash = key.to_public().hash().to_hex();
  return { keyHash, address: enterpriseAddress(keyHash, network) };
}

/** The key's own enterprise address (no stake part): where the batcher is funded. */
export function enterpriseAddress(keyHash: string, network: number): string {
  return CSL.EnterpriseAddress.new(network, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(keyHash))).to_address().to_bech32(undefined);
}

export function signerOf(key: CSL.PrivateKey): Signer {
  return {
    keyHash: key.to_public().hash().to_hex(),
    sign(txHex: string): string {
      const tx = CSL.FixedTransaction.from_hex(txHex);
      tx.sign_and_add_vkey_signature(key);
      return tx.to_hex();
    },
  };
}
