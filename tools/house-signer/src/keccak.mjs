// keccak-256 and EIP-55 checksums, from the one pinned hashing library.
//
// Import this only after preflight.mjs has proven @noble/hashes resolves inside this
// folder's own node_modules (cli.mjs loads it with a dynamic import for that reason).

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToPlainHex, isAddress, utf8 } from './hex.mjs';

export function keccak256(bytes) {
  return keccak_256(bytes);
}

export function keccakHex(bytes) {
  return `0x${bytesToPlainHex(keccak_256(bytes))}`;
}

export function keccakText(text) {
  return keccak_256(utf8(text));
}

/** The 4-byte selector of a Solidity function signature, e.g. "approve(address,uint256)". */
export function selectorOf(signature) {
  return `0x${bytesToPlainHex(keccak_256(utf8(signature)).slice(0, 4))}`;
}

/** EIP-55 mixed-case form of an address. */
export function toChecksumAddress(address) {
  if (!isAddress(address)) throw new Error('not an address');
  const plain = address.slice(2).toLowerCase();
  const hash = bytesToPlainHex(keccak_256(utf8(plain)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? plain[i].toUpperCase() : plain[i];
  return out;
}

/**
 * True for an all-lowercase or all-uppercase address (no checksum claimed) and for a
 * mixed-case one whose checksum is right. A mixed-case address with a wrong checksum is
 * almost always a typo, so policy and registry entries that carry one are refused.
 */
export function checksumOk(address) {
  if (!isAddress(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/** The address of an uncompressed secp256k1 public key (65 bytes, 0x04 prefix). */
export function addressOfPublicKey(uncompressed) {
  if (!(uncompressed instanceof Uint8Array) || uncompressed.length !== 65 || uncompressed[0] !== 4) {
    throw new Error('expected a 65-byte uncompressed public key');
  }
  return `0x${bytesToPlainHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
}
