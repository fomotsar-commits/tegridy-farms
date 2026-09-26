// The warnings a launch's details earn. Pinned: a details file that names ANOTHER
// token is "Copied details"; one that names no token (what every pasted link looks
// like, since the token's address is made after the file) is a plain note, not the
// accusation.
import { describe, expect, it } from 'vitest';
import { fakeApi, MINT, CREATOR } from './fakeWriteApi.fixture';
import { identityWarnings } from './identity';
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
