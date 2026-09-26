// The warnings a launch's details earn. Pinned: a details file that names ANOTHER
// token is "Copied details"; one that names no token (what every pasted link looks
// like, since the token's address is made after the file) is a plain note, not the
// accusation.
import { describe, expect, it } from 'vitest';
import { fakeApi, MINT, CREATOR } from './fakeWriteApi.fixture';
import { identityWarnings, safeImageUrl } from './identity';
import { IPFS_GATEWAYS } from '../../../lib/ipfsGateways';
import type { MetadataRead } from './ports';

const meta = fakeApi().meta;
const file = (mint: string | null, mintMatches: boolean): MetadataRead => ({
  kind: 'ok',
  json: { name: 'Farm Fresh', symbol: 'FRESH', description: '', image: null, mint },
  mintMatches,
  issues: [],
});

describe('identityWarnings: the details file and the token it names', () => {
  it('a file naming a different token is "Copied details"', () => {
    expect(identityWarnings(meta, null, file(CREATOR.toBase58(), false))).toContain(
      'Copied details: the linked details file was made for a different token.',
    );
  });
  it('a file naming NO token is not called copied; it gets a plain note', () => {
    const w = identityWarnings(meta, null, file(null, false));
    expect(w.some((x) => /Copied details/.test(x))).toBe(false);
    expect(w).toContain('The linked details file does not say which token it belongs to.');
  });
  it('a file naming this token earns neither', () => {
    expect(identityWarnings(meta, null, file(MINT.toBase58(), true))).toEqual([]);
  });
});

describe('safeImageUrl: a picture is shown from a gateway that still works', () => {
  // ipfs.io and dweb.link were retired on 2026-09-21. Pictures named on them, or as
  // ipfs://, must render from the site's live gateway list.
  const withImage = (image: string): MetadataRead => ({
    kind: 'ok',
    json: { name: 'Farm Fresh', symbol: 'FRESH', description: '', image, mint: null },
    mintMatches: false,
    issues: [],
  });
  const CID = `bafkrei${'a'.repeat(52)}`;
  it.each([`ipfs://${CID}`, `https://ipfs.io/ipfs/${CID}`, `https://dweb.link/ipfs/${CID}`])('%s', (image) => {
    expect(safeImageUrl(meta, withImage(image))).toBe(`${IPFS_GATEWAYS[0]}${CID}`);
  });
  it('Arweave is shown as it is, and a mutable web address is not shown at all', () => {
    const ar = `https://arweave.net/${'A'.repeat(43)}`;
    expect(safeImageUrl(meta, withImage(ar))).toBe(ar);
    expect(safeImageUrl(meta, withImage('https://evil.example/p.png'))).toBeNull();
  });
});
