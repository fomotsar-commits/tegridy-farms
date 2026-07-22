import { describe, it, expect } from 'vitest';
import { mergeProtocolEvents } from './merge';
import type { PulseItem } from './types';

function item(id: string, ts: number, over: Partial<PulseItem> = {}): PulseItem {
  return { id, kind: 'buy', usd: 0, actor: '', txHash: '', ts, whale: false, ...over };
}

describe('mergeProtocolEvents', () => {
  it('returns [] for empty / nullish streams (self-gating)', () => {
    expect(mergeProtocolEvents([])).toEqual([]);
    expect(mergeProtocolEvents([null, undefined, []])).toEqual([]);
  });

  it('merges streams newest-first by ts', () => {
    const trades = [item('t1', 100), item('t2', 300)];
    const deltas = [item('fee:1', 200, { kind: 'fee' })];
    const out = mergeProtocolEvents([trades, deltas]);
    expect(out.map((e) => e.id)).toEqual(['t2', 'fee:1', 't1']);
  });

  it('dedupes by id (first stream wins)', () => {
    const a = [item('x', 500, { kind: 'fee' })];
    const b = [item('x', 500, { kind: 'pol' })];
    const out = mergeProtocolEvents([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('fee');
  });

  it('drops items with a non-honest timestamp (ts <= 0)', () => {
    const out = mergeProtocolEvents([[item('good', 10), item('bad', 0), item('neg', -5)]]);
    expect(out.map((e) => e.id)).toEqual(['good']);
  });

  it('caps to the limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => item(`i${i}`, i + 1));
    const out = mergeProtocolEvents([many], { limit: 5 });
    expect(out).toHaveLength(5);
    expect(out[0].id).toBe('i39'); // newest
  });
});
