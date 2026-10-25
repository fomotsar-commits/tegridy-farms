// The batcher's signing key: made on the server (the owner's ruling: never copied), into a
// cardano-cli style key file only its owner can read. Only its key hash and address are ever
// printed or logged.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { Signer } from './watcher.ts';

/** A cardano-cli payment signing key file: {"type": "PaymentSigningKeyShelley_ed25519", "cborHex": "5820<32 bytes>"}. */
export function keyFromFile(path: string): CSL.PrivateKey {
  let file: { type?: unknown; cborHex?: unknown };
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as typeof file;
  } catch {
    throw new Error(`the key file ${path} is not readable JSON`);
  }
  if (file.type !== 'PaymentSigningKeyShelley_ed25519' || typeof file.cborHex !== 'string' || !/^5820[0-9a-f]{64}$/.test(file.cborHex)) throw new Error(`the key file ${path} is not a payment signing key`);
  return CSL.PrivateKey.from_normal_bytes(Buffer.from(file.cborHex.slice(4), 'hex'));
}

/**
 * Makes a new signing key at `path`, which must not exist (a key is never overwritten), readable
 * by its owner only. On Windows, Node ignores the file mode: the file's access list is cut down to
 * the current user (icacls), and if that fails the new, never-used key is deleted rather than left
 * readable. Returns what may be shown: the key hash and the enterprise address to fund.
 */
export function makeKeyFile(path: string, network: number): { keyHash: string; address: string } {
  if (existsSync(path)) throw new Error(`${path} exists: a batcher key is never overwritten`);
  const key = CSL.PrivateKey.generate_ed25519();
  const cborHex = `5820${Buffer.from(key.as_bytes()).toString('hex')}`;
  writeFileSync(path, `${JSON.stringify({ type: 'PaymentSigningKeyShelley_ed25519', description: 'Batcher signing key', cborHex }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    try {
      if (!user) throw new Error('USERNAME is not set');
      execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'pipe' });
    } catch (e) {
      rmSync(path, { force: true });
      throw new Error(`the key file's access could not be limited to ${user ?? 'this user'}, so the new key was deleted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const hash = key.to_public().hash();
  return { keyHash: hash.to_hex(), address: CSL.EnterpriseAddress.new(network, CSL.Credential.from_keyhash(hash)).to_address().to_bech32(undefined) };
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
