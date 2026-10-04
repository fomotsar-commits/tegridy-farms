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

/**
 * A token as the page would read it. Left as it is: a clean token called Corn, with a
 * name nobody can change. `freeze`: its creator kept the freeze authority. `name` and
 * `symbol`: what it calls itself (BOBO is a well-known name with one real mint).
 * `transferFee`: it charges a transfer fee, which this site still refuses.
 */
export function realToken(mint: PublicKey, o: { freeze?: PublicKey; name?: string; symbol?: string; transferFee?: boolean; decimals?: number } = {}): TokenSafety {
  const base = mintBytes(null, o.decimals ?? 6);
  if (o.freeze) {
    new DataView(base.buffer).setUint32(46, 1, true);
    base.set(o.freeze.toBytes(), 50);
  }
  const entries = [
    // The name is kept in the mint itself, and nobody can point it elsewhere.
    entry(EXTENSION.MetadataPointer, Uint8Array.from([...NOBODY, ...mint.toBytes()])),
    ...(o.transferFee ? [entry(EXTENSION.TransferFeeConfig, new Uint8Array(108))] : []),
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
