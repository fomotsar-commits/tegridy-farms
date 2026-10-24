// A token's on-chain name, symbol and picture link (Metaplex Token Metadata).
//
// ANYONE CAN WRITE THESE. A launch made outside this site, or a lookalike token,
// carries whatever text its creator chose, so everything decoded here is raw and
// untrusted: the page must pass it through a display-safe filter before showing it,
// and must never treat a matching name or symbol as proof of identity. Only the mint
// address identifies a token.
//
// What IS checked here: the account is owned by the Token Metadata program, sits
// at the mint's metadata address, and names that mint. `isMutable` is decoded so a
// page can warn that a launch's details can still change (ours never can).

import { PublicKey } from '@solana/web3.js';
import type { Decoded } from '../curve/program';
import { clipDetail, type CurveRpc, type Read } from '../curve/read';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../write/metaplex';

export interface TokenMetadata {
  address: PublicKey;
  mint: PublicKey;
  updateAuthority: PublicKey;
  /** Raw. Render only through a display-safe filter. */
  name: string;
  symbol: string;
  uri: string;
  isMutable: boolean;
}

/** `Key::MetadataV1` in mpl-token-metadata. */
const KEY_METADATA_V1 = 4;
/** Generous caps on the borsh length prefixes; real accounts pad to 32 / 10 / 200. */
const CAP = { name: 64, symbol: 32, uri: 256 } as const;

/**
 * Decode a Metadata account. `expectedMint` must equal the account's own `mint`
 * field; a mismatch is `wrong-discriminator` (it is some other token's details).
 * Trailing NUL padding is stripped.
 */
export function decodeTokenMetadata(data: Uint8Array, expectedMint: PublicKey, address?: PublicKey): Decoded<TokenMetadata> {
  let o = 0;
  const need = (n: number) => o + n <= data.length;
  if (!need(1 + 32 + 32)) return { ok: false, reason: 'bad-length' };
  if (data[0] !== KEY_METADATA_V1) return { ok: false, reason: 'wrong-discriminator' };
  o = 1;
  const updateAuthority = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const mint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  if (!mint.equals(expectedMint)) return { ok: false, reason: 'wrong-discriminator' };

  const dec = new TextDecoder('utf-8', { fatal: false });
  const str = (cap: number): string | null => {
    if (!need(4)) return null;
    const len = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(o, true);
    o += 4;
    if (len > cap || !need(len)) return null;
    const s = dec.decode(data.subarray(o, o + len)).replace(/\0+$/, '');
    o += len;
    return s;
  };
  const name = str(CAP.name);
  const symbol = str(CAP.symbol);
  const uri = str(CAP.uri);
  if (name === null || symbol === null || uri === null) return { ok: false, reason: 'malformed' };

  if (!need(2 + 1)) return { ok: false, reason: 'bad-length' };
  o += 2; // seller_fee_basis_points
  const hasCreators = data[o++];
  if (hasCreators === 1) {
    if (!need(4)) return { ok: false, reason: 'bad-length' };
    const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(o, true);
    o += 4;
    if (n > 5 || !need(n * 34)) return { ok: false, reason: 'malformed' };
    o += n * 34;
  } else if (hasCreators !== 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (!need(2)) return { ok: false, reason: 'bad-length' };
  o += 1; // primary_sale_happened
  const mutable = data[o];
  if (mutable !== 0 && mutable !== 1) return { ok: false, reason: 'malformed' };

  return {
    ok: true,
    value: {
      address: address ?? metadataPda(expectedMint),
      mint,
      updateAuthority,
      name,
      symbol,
      uri,
      isMutable: mutable === 1,
    },
  };
}

/** Read and decode a mint's metadata. `absent` = the token has no Metaplex details. */
export async function readTokenMetadata(rpc: CurveRpc, mint: PublicKey): Promise<Read<TokenMetadata>> {
  const address = metadataPda(mint);
  let info;
  try {
    info = await rpc.getAccountInfo(address);
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
  if (!info) return { kind: 'absent' };
  if (!info.owner.equals(METAPLEX_TOKEN_METADATA_ID)) return { kind: 'undecodable', reason: 'wrong-discriminator' };
  const d = decodeTokenMetadata(info.data, mint, address);
  return d.ok ? { kind: 'ok', value: d.value } : { kind: 'undecodable', reason: d.reason };
}
