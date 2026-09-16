import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOverrideModule, mergeScoped } from './overrideFileMerge';

// THE SCOPED SAVE, AND THE READ IT DEPENDS ON.
//
// A studio tab now POSTs only `${bungalowId}|*` and the middleware keeps every
// other resident's keys from the file on disk. The merge is one line; the part
// that can destroy work is the READ that feeds it. If parsing silently returned
// less than the file contained, the rewrite would delete the difference — the
// same data loss the scoped save was built to stop, arriving through the fix.
//
// So these tests are mostly about the read failing LOUDLY, and about the real
// files on disk actually round-tripping.

const LIB = join(process.cwd(), 'src', 'lib');

const SAMPLE = `/** header */
import type { ArtOverride } from './artOverrides';

export const BUNGALOW_ART_OVERRIDES: Record<string, ArtOverride> = {
  "bayla|farm:0": { artId: "bayla-03" },
  "bayla|home:0": { artId: "bayla-11", objectPosition: "72% 47%" },
  "pepe|home:0": { artId: "pepe-02", objectPosition: "50% 20%", scale: 1.4 },
};

export function bungalowOverrideKey() { return ''; }
`;

describe('parseOverrideModule', () => {
  it('reads every entry, with and without the optional fields', () => {
    const parsed = parseOverrideModule(SAMPLE, 'BUNGALOW_ART_OVERRIDES');
    expect(parsed).toEqual({
      'bayla|farm:0': { artId: 'bayla-03' },
      'bayla|home:0': { artId: 'bayla-11', objectPosition: '72% 47%' },
      'pepe|home:0': { artId: 'pepe-02', objectPosition: '50% 20%', scale: 1.4 },
    });
  });

  // The load-bearing case. Anything this cannot read must stop the write, never
  // shrink it — see the module comment.
  it('throws on a line it cannot parse rather than dropping it', () => {
    const corrupted = SAMPLE.replace('  "bayla|farm:0": { artId: "bayla-03" },', '  this is not an entry');
    expect(() => parseOverrideModule(corrupted, 'BUNGALOW_ART_OVERRIDES')).toThrow(/unparseable/i);
  });

  it('throws when the export is missing entirely', () => {
    expect(() => parseOverrideModule(SAMPLE, 'NO_SUCH_EXPORT')).toThrow(/could not find/i);
  });

  it('throws on an unterminated literal instead of reading to end of file', () => {
    expect(() => parseOverrideModule(SAMPLE.replace('\n};', '\n'), 'BUNGALOW_ART_OVERRIDES')).toThrow(
      /unterminated/i,
    );
  });

  // Both real files are written by this same middleware, so a parser that
  // cannot read them is broken no matter what the synthetic cases say.
  it.each([
    ['bungalowArtOverrides.ts', 'BUNGALOW_ART_OVERRIDES'],
    ['artOverrides.ts', 'ART_OVERRIDES'],
  ] as const)('round-trips the real %s on disk', (file, exportName) => {
    const parsed = parseOverrideModule(readFileSync(join(LIB, file), 'utf8'), exportName);
    const count = Object.keys(parsed).length;
    expect(count, `${file} parsed to zero entries — the read silently came back empty`).toBeGreaterThan(0);
    for (const [key, entry] of Object.entries(parsed)) {
      expect(typeof entry.artId, `${key} has no artId`).toBe('string');
      expect(entry.artId.length).toBeGreaterThan(0);
    }
  });
});

describe('mergeScoped', () => {
  const existing = parseOverrideModule(SAMPLE, 'BUNGALOW_ART_OVERRIDES');

  it("replaces the scope's keys and keeps every other resident's", () => {
    const merged = mergeScoped(existing, 'bayla', { 'bayla|farm:0': { artId: 'bayla-19' } });
    // Bayla's surviving pick is the new one...
    expect(merged['bayla|farm:0']).toEqual({ artId: 'bayla-19' });
    // ...the bayla key the save did NOT carry is gone (it was deselected)...
    expect(merged['bayla|home:0']).toBeUndefined();
    // ...and pepe, who was never part of this save, is untouched.
    expect(merged['pepe|home:0']).toEqual({ artId: 'pepe-02', objectPosition: '50% 20%', scale: 1.4 });
  });

  // The regression, stated directly: this is the shape of the 3.3-second wipe.
  it('a second resident saving cannot erase the first', () => {
    const afterBayla = mergeScoped(existing, 'bayla', { 'bayla|farm:0': { artId: 'bayla-19' } });
    const afterPepe = mergeScoped(afterBayla, 'pepe', { 'pepe|home:0': { artId: 'pepe-07' } });
    expect(afterPepe['bayla|farm:0'], "pepe's save erased bayla's placement").toEqual({ artId: 'bayla-19' });
    expect(afterPepe['pepe|home:0']).toEqual({ artId: 'pepe-07' });
  });

  it('an empty save for a scope clears only that scope', () => {
    const merged = mergeScoped(existing, 'bayla', {});
    expect(Object.keys(merged)).toEqual(['pepe|home:0']);
  });

  it('a scope that shares a prefix with another is not caught by it', () => {
    const withPrefixTwin = { ...existing, 'bayla-two|home:0': { artId: 'x' } };
    const merged = mergeScoped(withPrefixTwin, 'bayla', {});
    expect(merged['bayla-two|home:0'], 'the pipe delimiter did not bound the prefix').toEqual({ artId: 'x' });
  });
});
