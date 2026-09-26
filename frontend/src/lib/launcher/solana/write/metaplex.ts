// Metaplex Token Metadata: the one instruction a launch needs, encoded by hand.
//
// WHY BY HAND: the SDK (`@metaplex-foundation/mpl-token-metadata`) is not a
// dependency, and one fixed-shape instruction does not justify one.
//
// WHY LOCKED (`is_mutable = false`): `create_launch` revokes the mint authority, so
// supply is fixed forever. If the name, symbol and picture could still change, a
// creator could re-brand a coin after people bought it: impersonate another token,
// or swap the image. Locking them means what a buyer saw is what they hold. The
// URIs we accept are content addresses (IPFS / Arweave), so the files behind them
// cannot change either.
//
// WHY BEFORE `create_launch`, in the same transaction: Metaplex requires the MINT
// AUTHORITY to sign metadata creation, and `create_launch` destroys that authority.
// Afterwards nobody can ever create metadata for the mint.

import { Buffer } from 'buffer';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { SYSTEM_PROGRAM_ID, SYSVAR_RENT_PUBKEY } from '../curve/program';

export const METAPLEX_TOKEN_METADATA_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/** `CreateMetadataAccountV3`'s instruction tag in the Token Metadata program. */
export const CREATE_METADATA_V3_TAG = 33;

/** Metaplex's own ceilings (mpl-token-metadata `MAX_NAME_LENGTH` / `MAX_SYMBOL_LENGTH`). */
export const METADATA_NAME_MAX_BYTES = 32;
export const METADATA_SYMBOL_MAX_BYTES = 10;
/**
 * OUR ceiling, not Metaplex's (theirs is 200). 100 keeps the launch transaction
 * well inside the 1,232-byte packet limit with room for a wallet's own guard
 * instructions, and every URI we accept fits (`ipfs://<cid>` is at
 * most ~80 bytes; `https://arweave.net/<43>` is 62).
 */
export const METADATA_URI_MAX_BYTES = 100;

const METADATA_SEED = new TextEncoder().encode('metadata');

/** `["metadata", program, mint]` under Token Metadata. */
export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [METADATA_SEED, METAPLEX_TOKEN_METADATA_ID.toBytes(), mint.toBytes()],
    METAPLEX_TOKEN_METADATA_ID,
  )[0];
}

const utf8 = new TextEncoder();

function borshString(label: string, s: string, maxBytes: number): number[] {
  const bytes = utf8.encode(s);
  if (bytes.length === 0) throw new RangeError(`${label} is empty`);
  if (bytes.length > maxBytes) {
    throw new RangeError(`${label} is ${bytes.length} bytes; the most allowed is ${maxBytes}`);
  }
  // Token Metadata pads stored strings with NUL and readers strip trailing NULs, so
  // a NUL we wrote would be indistinguishable from padding. Refuse it outright.
  if (bytes.includes(0)) throw new RangeError(`${label} contains a NUL byte`);
  const len = bytes.length;
  return [len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, (len >>> 24) & 0xff, ...bytes];
}

export interface CreateMetadataV3Accounts {
  metadata: PublicKey;
  mint: PublicKey;
  mintAuthority: PublicKey;
  payer: PublicKey;
  updateAuthority: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

/**
 * `CreateMetadataAccountV3` with `is_mutable = false`.
 *
 * data: `u8 33 | DataV2 { name, symbol, uri (borsh strings), seller_fee_basis_points
 * u16 = 0, creators None, collection None, uses None } | is_mutable false |
 * collection_details None`.
 *
 * Accounts: metadata (w) · mint · mint authority (s) · payer (s, w) · update
 * authority (s) · system program · rent sysvar. Rent is optional in current
 * Token Metadata; it is passed anyway because `create_launch` already carries it,
 * so it costs one byte in the message, and it keeps older program versions happy.
 *
 * Throws on a name over 32 bytes, a symbol over 10, a URI over 100, an empty
 * field, or a NUL byte.
 */
export function createMetadataV3Ix(a: CreateMetadataV3Accounts): TransactionInstruction {
  const data = [
    CREATE_METADATA_V3_TAG,
    ...borshString('name', a.name, METADATA_NAME_MAX_BYTES),
    ...borshString('symbol', a.symbol, METADATA_SYMBOL_MAX_BYTES),
    ...borshString('uri', a.uri, METADATA_URI_MAX_BYTES),
    0, 0, // seller_fee_basis_points: u16 = 0
    0, // creators: None
    0, // collection: None
    0, // uses: None
    0, // is_mutable: false
    0, // collection_details: None
  ];
  return new TransactionInstruction({
    programId: METAPLEX_TOKEN_METADATA_ID,
    keys: [
      { pubkey: a.metadata, isSigner: false, isWritable: true },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: a.mintAuthority, isSigner: true, isWritable: false },
      { pubkey: a.payer, isSigner: true, isWritable: true },
      { pubkey: a.updateAuthority, isSigner: true, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface DecodedMetadataV3Args {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  isMutable: boolean;
}

/**
 * Decode `CreateMetadataAccountV3` data back out, accepting ONLY the shape this
 * site builds: no creators, no collection, no uses, no collection details, zero
 * royalties, immutable. Anything else is `null`, which the intent check refuses.
 */
export function decodeCreateMetadataV3(data: Uint8Array): DecodedMetadataV3Args | null {
  let o = 0;
  const need = (n: number) => o + n <= data.length;
  if (!need(1) || data[o++] !== CREATE_METADATA_V3_TAG) return null;
  const dec = new TextDecoder('utf-8', { fatal: true });
  const str = (max: number): string | null => {
    if (!need(4)) return null;
    const len = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
    o += 4;
    if (len <= 0 || len > max || !need(len)) return null;
    const bytes = data.subarray(o, o + len);
    o += len;
    if (bytes.includes(0)) return null;
    try {
      return dec.decode(bytes);
    } catch {
      return null;
    }
  };
  const name = str(METADATA_NAME_MAX_BYTES);
  const symbol = str(METADATA_SYMBOL_MAX_BYTES);
  const uri = str(METADATA_URI_MAX_BYTES);
  if (name === null || symbol === null || uri === null) return null;
  if (!need(2 + 5)) return null;
  const sfbp = data[o]! | (data[o + 1]! << 8);
  o += 2;
  const creators = data[o++];
  const collection = data[o++];
  const uses = data[o++];
  const isMutable = data[o++];
  const details = data[o++];
  if (o !== data.length) return null;
  if (creators !== 0 || collection !== 0 || uses !== 0 || details !== 0) return null;
  if (isMutable !== 0 && isMutable !== 1) return null;
  return { name, symbol, uri, sellerFeeBasisPoints: sfbp, isMutable: isMutable === 1 };
}
