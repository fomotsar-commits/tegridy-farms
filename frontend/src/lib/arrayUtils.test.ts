import { describe, it, expect } from 'vitest';
import { chunkArray } from './arrayUtils';

describe('chunkArray', () => {
  it('returns empty array for empty input', () => {
    expect(chunkArray([], 50)).toEqual([]);
  });

  it('splits a small array into one chunk when below size', () => {
    expect(chunkArray([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
  });

  it('splits at exact boundaries', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('produces a final partial chunk for non-divisible lengths', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  it('handles size larger than array', () => {
    expect(chunkArray([1, 2], 100)).toEqual([[1, 2]]);
  });

  it('clamps zero / negative size to 1 (defensive — never returns empty chunks)', () => {
    expect(chunkArray([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunkArray([1, 2], -5)).toEqual([[1], [2]]);
  });

  it('chunks 250 ids into 5 batches of 50 (R044 H1 sizing)', () => {
    const ids = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkArray(ids, 50);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.length === 50)).toBe(true);
    expect(chunks.flat()).toEqual(ids);
  });

  it('chunks 1000 ids into 20 batches of 50', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i);
    const chunks = chunkArray(ids, 50);
    expect(chunks).toHaveLength(20);
    expect(chunks[0]).toEqual(ids.slice(0, 50));
    expect(chunks[19]).toEqual(ids.slice(950, 1000));
  });
});
