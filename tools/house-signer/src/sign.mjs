// secp256k1 signing for the house key, with the last check before anything leaves.
//
// noble signs deterministically (RFC 6979, no extra entropy) and low-s by default, the
// same way viem does, so the signatures here equal viem's byte for byte (test/sign.test.mjs).
// Even so, every signature is recovered and compared with the house address before it is
// returned (PIN:P16): a signature that does not recover to the house is never handed out,
// whatever went wrong to produce it.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { addressOfPublicKey } from './keccak.mjs';
import { bigintToBytes, bytesToHex, concatBytes, eqAddr, hexToBytes, isBytes32 } from './hex.mjs';

const N = secp256k1.CURVE.n;
const HALF_N = N >> 1n;

export function isValidPrivateKey(privateKey) {
  return privateKey instanceof Uint8Array && privateKey.length === 32 && secp256k1.utils.isValidPrivateKey(privateKey);
}

export function addressOf(privateKey) {
  if (!isValidPrivateKey(privateKey)) throw new Error('not a valid secp256k1 private key');
  return addressOfPublicKey(secp256k1.getPublicKey(privateKey, false));
}

/** The address a 65-byte r||s||v signature over a 32-byte digest recovers to. */
export function recoverAddress(digestHex, signatureHex) {
  if (!isBytes32(digestHex)) throw new Error('digest must be 32 bytes');
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  const v = sig[64];
  if (v !== 27 && v !== 28) throw new Error('signature v must be 27 or 28');
  const s = new secp256k1.Signature(
    BigInt(bytesToHex(sig.slice(0, 32))),
    BigInt(bytesToHex(sig.slice(32, 64))),
  ).addRecoveryBit(v - 27);
  return addressOfPublicKey(s.recoverPublicKey(hexToBytes(digestHex)).toRawBytes(false));
}

function refuse(field, reason) {
  return { ok: false, field, reason };
}

/**
 * Sign a 32-byte digest with the house key.
 *
 * Returns { ok: true, signature (0x + 65 bytes r||s||v, v 27/28), r, s, yParity } or a
 * refusal. `signImpl` exists only so tests can hand in a broken signer and prove the
 * checks below catch it; production always uses noble's sign.
 */
export function signDigest({ digest, privateKey, expected, signImpl = secp256k1.sign }) {
  if (!isBytes32(digest)) return refuse('digest', 'the digest to sign is not 32 bytes');
  const raw = signImpl(hexToBytes(digest), privateKey, { lowS: true });
  const { r, s, recovery } = raw;
  if (recovery !== 0 && recovery !== 1) return refuse('signature', 'the signature has no usable recovery bit');
  if (s > HALF_N) return refuse('P16.lowS', 'the signature is not in low-s form, which Seaport and every wallet treat as malleable'); // PIN:P16.lowS
  const signature = bytesToHex(concatBytes(bigintToBytes(r, 32), bigintToBytes(s, 32), Uint8Array.of(27 + recovery)));
  let recovered;
  try {
    recovered = recoverAddress(digest, signature);
  } catch (e) {
    return refuse('signature', `the signature could not be recovered (${e.message})`);
  }
  if (!eqAddr(recovered, expected)) return refuse('P16.recover', 'the signature does not recover to the house address, so it is not returned'); // PIN:P16.recover
  return { ok: true, signature, r, s, yParity: recovery };
}
