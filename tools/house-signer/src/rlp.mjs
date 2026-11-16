// Recursive Length Prefix encoding, for EIP-1559 transactions. Integers go in as minimal
// big-endian bytes (zero is the empty string), as the yellow paper requires; tx.mjs
// does that conversion. Checked against viem's serializeTransaction in test/tx.test.mjs.

import { bigintToMinimalBytes, concatBytes } from './hex.mjs';

function lengthPrefix(length, offset) {
  if (length < 56) return Uint8Array.of(offset + length);
  const lenBytes = bigintToMinimalBytes(BigInt(length));
  return concatBytes(Uint8Array.of(offset + 55 + lenBytes.length), lenBytes);
}

/** item: a Uint8Array (a string) or an array of items (a list). */
export function rlpEncode(item) {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concatBytes(lengthPrefix(item.length, 0x80), item);
  }
  if (Array.isArray(item)) {
    const payload = concatBytes(...item.map(rlpEncode));
    return concatBytes(lengthPrefix(payload.length, 0xc0), payload);
  }
  throw new Error('rlp: expected bytes or a list');
}
