// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LIMITS, checkContentUri } from '../../../launchMetadata/validate.js';
import {
  METADATA_URI_MAX_BYTES,
  METAPLEX_TOKEN_METADATA_ID,
  createMetadataV3Ix,
  decodeCreateMetadataV3,
  metadataPda,
} from './metaplex';

const MINT = Keypair.generate().publicKey;
const ME = Keypair.generate().publicKey;
const base = { metadata: metadataPda(MINT), mint: MINT, mintAuthority: ME, payer: ME, updateAuthority: ME };

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe('CreateMetadataAccountV3, byte for byte', () => {
  it('matches a hand-computed vector, emoji included, and is LOCKED (is_mutable = 0)', () => {
    const uri = 'https://ipfs.io/ipfs/bafkreia';
    const ix = createMetadataV3Ix({ ...base, name: 'Tegridy \u{1F33F}', symbol: 'TGD', uri });
    const expected = [
      33, // CreateMetadataAccountV3
      12, 0, 0, 0, ...ascii('Tegridy '), 0xf0, 0x9f, 0x8c, 0xbf, // name: 8 ASCII bytes + U+1F33F as 4 UTF-8 bytes
      3, 0, 0, 0, ...ascii('TGD'),
      uri.length, 0, 0, 0, ...ascii(uri),
      0, 0, // seller_fee_basis_points = 0
      0, // creators None
      0, // collection None
      0, // uses None
      0, // is_mutable = false
      0, // collection_details None
    ];
    expect(Array.from(ix.data)).toEqual(expected);
  });

  it('accounts: metadata(w), mint, authority(s), payer(s,w), update authority(s), system, rent', () => {
    const ix = createMetadataV3Ix({ ...base, name: 'A', symbol: 'AB', uri: 'https://arweave.net/x' });
    expect(ix.programId.equals(METAPLEX_TOKEN_METADATA_ID)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [metadataPda(MINT).toBase58(), false, true],
      [MINT.toBase58(), false, false],
      [ME.toBase58(), true, false],
      [ME.toBase58(), true, true],
      [ME.toBase58(), true, false],
      ['11111111111111111111111111111111', false, false],
      ['SysvarRent111111111111111111111111111111111', false, false],
    ]);
  });

  it('the metadata address is Metaplex’s ["metadata", program, mint] PDA', () => {
    const [want] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METAPLEX_TOKEN_METADATA_ID.toBuffer(), MINT.toBuffer()],
      METAPLEX_TOKEN_METADATA_ID,
    );
    expect(metadataPda(MINT).equals(want)).toBe(true);
  });

  it('refuses a name over 32 bytes, a symbol over 10, a URI over 80, empties and NULs', () => {
    const mk = (o: Partial<{ name: string; symbol: string; uri: string }>) => () =>
      createMetadataV3Ix({ ...base, name: 'ok', symbol: 'OK', uri: 'https://x', ...o });
    expect(mk({ name: 'x'.repeat(32) })).not.toThrow();
    expect(mk({ name: 'x'.repeat(33) })).toThrow(/33 bytes/);
    // 8 emoji = 32 bytes fits; 9 = 36 does not. The cap is BYTES, not characters.
    expect(mk({ name: '\u{1F33F}'.repeat(8) })).not.toThrow();
    expect(mk({ name: '\u{1F33F}'.repeat(9) })).toThrow(/36 bytes/);
    expect(mk({ symbol: 'X'.repeat(10) })).not.toThrow();
    expect(mk({ symbol: 'X'.repeat(11) })).toThrow();
    expect(mk({ uri: 'h'.repeat(80) })).not.toThrow();
    expect(mk({ uri: 'h'.repeat(81) })).toThrow(/81 bytes/);
    expect(mk({ name: '' })).toThrow(/empty/);
    expect(mk({ name: 'a\u0000b' })).toThrow(/NUL/);
  });

  // The cap is sized to the links the form can produce, so the create transaction
  // still fits with the plant in it (prepare.test.ts measures it).
  it('the link cap is 80, the same as the form’s, and the longest link the form makes fits it', () => {
    expect(METADATA_URI_MAX_BYTES).toBe(80);
    expect(LIMITS.uriBytes).toBe(METADATA_URI_MAX_BYTES);
    const longestCid = `b${'a'.repeat(70)}`;
    for (const pasted of [`ipfs://${longestCid}`, `https://${longestCid}.ipfs.w3s.link/`, `https://arweave.net/${'A'.repeat(43)}`]) {
      const c = checkContentUri(pasted);
      expect(c.ok, pasted).toBe(true);
      const uri = c.ok ? c.value : '';
      expect(new TextEncoder().encode(uri).length, uri).toBeLessThanOrEqual(METADATA_URI_MAX_BYTES);
      expect(() => createMetadataV3Ix({ ...base, name: 'A', symbol: 'AB', uri })).not.toThrow();
    }
  });
});

describe('decodeCreateMetadataV3 accepts only the shape this site builds', () => {
  it('round-trips', () => {
    const ix = createMetadataV3Ix({ ...base, name: 'Tegridy \u{1F33F}', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x' });
    expect(decodeCreateMetadataV3(ix.data)).toEqual({
      name: 'Tegridy \u{1F33F}', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x', sellerFeeBasisPoints: 0, isMutable: false,
    });
  });
  it('reports is_mutable = 1 so the intent check can refuse it', () => {
    const d = Uint8Array.from(createMetadataV3Ix({ ...base, name: 'A', symbol: 'AB', uri: 'https://x' }).data);
    d[d.length - 2] = 1;
    expect(decodeCreateMetadataV3(d)?.isMutable).toBe(true);
  });
  it('refuses creators, trailing bytes, a wrong tag and invalid UTF-8', () => {
    const good = Uint8Array.from(createMetadataV3Ix({ ...base, name: 'A', symbol: 'AB', uri: 'https://x' }).data);
    const withCreators = Uint8Array.from(good);
    withCreators[withCreators.length - 5] = 1;
    expect(decodeCreateMetadataV3(withCreators)).toBeNull();
    expect(decodeCreateMetadataV3(Uint8Array.from([...good, 0]))).toBeNull();
    const wrongTag = Uint8Array.from(good);
    wrongTag[0] = 32;
    expect(decodeCreateMetadataV3(wrongTag)).toBeNull();
    const badUtf8 = Uint8Array.from(good);
    badUtf8[5] = 0xff; // the name byte
    expect(decodeCreateMetadataV3(badUtf8)).toBeNull();
  });
});
