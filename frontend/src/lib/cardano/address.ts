// Cardano Shelley addresses as bytes, with no Cardano library: the top bar shows a wallet's
// address from here, so this file must stay small and must never import csl.ts.
//
// A Shelley address is one header byte, then a 28-byte payment credential, then (for a base
// address) a 28-byte stake credential (CIP-19). The header's high nibble is the type, the low
// nibble the network (1 = mainnet). bech32 comes from @scure/base, already in the bundle and
// audited by Cure53.

import { bech32 } from '@scure/base';

export const MAINNET_NETWORK_ID = 1;

/** Long enough for any Shelley address; bech32's default 90 is too short for a base address. */
const BECH32_LIMIT = 200;

export interface Credential {
  kind: 'key' | 'script';
  /** 28 bytes, hex. */
  hash: string;
}

export interface ParsedAddress {
  /** The whole address, hex: what gets compared. Never compare a prefix or a bech32 fragment. */
  hex: string;
  bech32: string;
  network: number;
  payment: Credential;
  /** Null for an enterprise address. */
  stake: Credential | null;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('Not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Header types this rail accepts (CIP-19): base addresses 0-3 and enterprise 6-7. Pointer
 * (4-5), Byron (8) and reward (14-15) addresses are refused: none of them can receive a swap.
 */
const PAYMENT_IS_SCRIPT: Record<number, boolean> = { 0: false, 1: true, 2: false, 3: true, 6: false, 7: true };
const STAKE_IS_SCRIPT: Record<number, boolean> = { 0: false, 1: false, 2: true, 3: true };

/** A Shelley address from its bytes, or null when it is not one this rail can pay. */
export function parseAddressBytes(bytes: Uint8Array): ParsedAddress | null {
  const header = bytes[0];
  if (header === undefined) return null;
  const type = header >> 4;
  const network = header & 0x0f;
  const paymentIsScript = PAYMENT_IS_SCRIPT[type];
  if (paymentIsScript === undefined) return null;
  const enterprise = type === 6 || type === 7;
  if (bytes.length !== (enterprise ? 29 : 57)) return null;
  const payment: Credential = { kind: paymentIsScript ? 'script' : 'key', hash: bytesToHex(bytes.subarray(1, 29)) };
  const stake: Credential | null = enterprise
    ? null
    : { kind: STAKE_IS_SCRIPT[type] ? 'script' : 'key', hash: bytesToHex(bytes.subarray(29, 57)) };
  const prefix = network === MAINNET_NETWORK_ID ? 'addr' : 'addr_test';
  return {
    hex: bytesToHex(bytes),
    bech32: bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT),
    network,
    payment,
    stake,
  };
}

export function parseAddressHex(hex: string): ParsedAddress | null {
  try {
    return parseAddressBytes(hexToBytes(hex));
  } catch {
    return null;
  }
}

export function parseAddressBech32(text: string): ParsedAddress | null {
  try {
    const decoded = bech32.decode(text as `${string}1${string}`, BECH32_LIMIT);
    const parsed = parseAddressBytes(bech32.fromWords(decoded.words));
    if (!parsed) return null;
    // The prefix must agree with the network nibble: an addr_test1 string with a mainnet
    // header is malformed, not mainnet.
    const want = parsed.network === MAINNET_NETWORK_ID ? 'addr' : 'addr_test';
    return decoded.prefix === want ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The whole address, hex, of an output a script spends, whatever its stake part: a key, a script,
 * a pointer or none (CIP-19 types 1, 3, 5, 7). Only for an output the contract itself knows by
 * its payment part alone (the factory's entries: factory_validator.ak keeps them by payment
 * credential, so anyone may put one at our factory with a stake part of their choosing). Every
 * address the site pays or shows goes through parseAddressBech32, which refuses pointers.
 */
export function scriptSpentAddressHex(text: string): { hex: string; network: number; scriptHash: string } | null {
  let bytes: Uint8Array;
  let prefix: string;
  try {
    const decoded = bech32.decode(text as `${string}1${string}`, BECH32_LIMIT);
    bytes = bech32.fromWords(decoded.words);
    prefix = decoded.prefix;
  } catch {
    return null;
  }
  const header = bytes[0];
  if (header === undefined) return null;
  const type = header >> 4;
  const network = header & 0x0f;
  // A pointer is three variable-length numbers: at least a byte each.
  const lengthOk = type === 1 || type === 3 ? bytes.length === 57 : type === 7 ? bytes.length === 29 : type === 5 ? bytes.length >= 32 : false;
  if (!lengthOk || prefix !== (network === MAINNET_NETWORK_ID ? 'addr' : 'addr_test')) return null;
  return { hex: bytesToHex(bytes), network, scriptHash: bytesToHex(bytes.subarray(1, 29)) };
}

/**
 * An address paying `payment` with `stake` as its stake part. This is how a Minswap V2 order
 * address is made: the order script's payment credential and the trader's own stake
 * credential, so the ADA in an open order keeps earning for the trader (SDK buildOrderAddress).
 */
export function composeAddress(payment: Credential, stake: Credential | null, network: number = MAINNET_NETWORK_ID): ParsedAddress {
  let type: number;
  if (stake === null) type = payment.kind === 'script' ? 7 : 6;
  else if (payment.kind === 'key') type = stake.kind === 'key' ? 0 : 2;
  else type = stake.kind === 'key' ? 1 : 3;
  const bytes = hexToBytes(bytesToHex(new Uint8Array([(type << 4) | network])) + payment.hash + (stake?.hash ?? ''));
  const parsed = parseAddressBytes(bytes);
  if (!parsed) throw new Error('composeAddress: credentials are not 28 bytes');
  return parsed;
}

/** For a chip: the start and the end. The whole address is what gets copied and compared. */
export function shortCardanoAddress(bech: string): string {
  return bech.length > 20 ? `${bech.slice(0, 10)}…${bech.slice(-6)}` : bech;
}
