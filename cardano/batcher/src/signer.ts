// The batcher's signing key, read from a cardano-cli style key file (made on the server by
// scripts/new-key.ts, never copied). Only its key hash is ever printed or logged.
import { readFileSync } from 'node:fs';
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
