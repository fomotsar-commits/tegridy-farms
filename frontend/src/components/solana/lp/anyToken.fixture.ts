// Test-only: tokens for the "any token may have a pool" tests, judged by the REAL checker
// (tokenSafety.ts `classifyToken`) from mint bytes, so every warning and block a test reads
// is in the checker's own words, never a copy of them.
//
// Each is a Token-2022 mint that carries its own name. A Metaplex name record is not used:
// reading one works out an address, which web3 cannot do under jsdom.

import type { PublicKey } from '@solana/web3.js';
import { mintBytes } from '../../../lib/solana/lp/testkit.fixture';
import { EXTENSION, TOKEN_2022_PROGRAM, classifyToken, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';

/** One extension entry: its type, its length, then its bytes. */
function entry(type: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, value.length, true);
  out.set(value, 4);
  return out;
}

/** A length-prefixed string, as the token metadata extension stores one. */
function text(s: string): number[] {
  const b = new TextEncoder().encode(s);
  return [b.length & 255, (b.length >> 8) & 255, 0, 0, ...b];
}

const NOBODY = new Uint8Array(32);
/** Who can raise the fixture's transfer fee, and who collects it: two fixed keys. */
export const FEE_RAISER = new Uint8Array(32).fill(7);
export const FEE_COLLECTOR = new Uint8Array(32).fill(8);

/** A 5% transfer fee with no cap, both settings the same: spl-token-2022 `TransferFeeConfig`, 108 bytes. */
function fivePercentFee(): Uint8Array {
  const v = new Uint8Array(108);
  const d = new DataView(v.buffer);
  v.set(FEE_RAISER, 0);
  v.set(FEE_COLLECTOR, 32);
  for (const at of [72, 90]) {
    d.setBigUint64(at + 8, (1n << 64n) - 1n, true);
    d.setUint16(at + 16, 500, true);
  }
  return v;
}

/**
 * A token as the page would read it. Left as it is: a clean token called Corn, with a
 * name nobody can change. `freeze`: its creator kept the freeze authority. `name` and
 * `symbol`: what it calls itself (BOBO is a well-known name with one real mint).
 * `transferFee`: it keeps back 5% of every transfer, and someone can still raise that: a
 * warning, never a block (owner, 2026-10-29). `transferHook`: it runs a program on every
 * transfer, which the pool program itself rejects.
 */
export function realToken(
  mint: PublicKey,
  o: { freeze?: PublicKey; name?: string; symbol?: string; transferFee?: boolean; transferHook?: boolean; decimals?: number } = {},
): TokenSafety {
  const base = mintBytes(null, o.decimals ?? 6);
  if (o.freeze) {
    new DataView(base.buffer).setUint32(46, 1, true);
    base.set(o.freeze.toBytes(), 50);
  }
  const entries = [
    // The name is kept in the mint itself, and nobody can point it elsewhere.
    entry(EXTENSION.MetadataPointer, Uint8Array.from([...NOBODY, ...mint.toBytes()])),
    ...(o.transferFee ? [entry(EXTENSION.TransferFeeConfig, fivePercentFee())] : []),
    ...(o.transferHook ? [entry(EXTENSION.TransferHook, new Uint8Array(64))] : []),
    entry(EXTENSION.TokenMetadata, Uint8Array.from([...NOBODY, ...mint.toBytes(), ...text(o.name ?? 'Corn'), ...text(o.symbol ?? 'CORN'), ...text('https://x.test/a.json'), 0, 0, 0, 0])),
  ];
  // The base mint, zero padding up to byte 165, the account-type byte (1 = a mint), then the entries.
  const data = new Uint8Array(166 + entries.reduce((n, e) => n + e.length, 0));
  data.set(base, 0);
  data[165] = 1;
  let at = 166;
  for (const e of entries) {
    data.set(e, at);
    at += e.length;
  }
  return classifyToken(mint.toBase58(), { address: mint.toBase58(), owner: TOKEN_2022_PROGRAM, data, lamports: 1 }, null);
}

/** One warning or block of a read token, by its code. Throws when the checker did not give it: a test then reads nothing by accident. */
export function reasonText(safety: TokenSafety, code: string): string {
  const found = safety.kind === 'read' ? [...safety.blocks, ...safety.warnings].find((r) => r.code === code) : undefined;
  if (!found) throw new Error(`the checker gave no '${code}' for this token`);
  return found.text;
}
