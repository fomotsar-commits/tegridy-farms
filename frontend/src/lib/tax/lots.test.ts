import { describe, it, expect } from 'vitest';
import { matchLots, type AcquisitionEvent, type DisposalEvent, type TaxLotEvent } from './lots';
import { COST_BASIS_METHODS, isCostBasisMethod, methodInfo, methodStatement, NOT_TAX_ADVICE } from './methods';

const DAY = 86_400;
const T0 = 1_700_000_000;

function acq(id: string, qty: bigint, cost: bigint | null, dayOffset: number): AcquisitionEvent {
  return {
    kind: 'acquire',
    id,
    asset: 'tok',
    assetSymbol: 'TOK',
    quantity: qty,
    decimals: 0,
    costBasis: cost,
    timestamp: T0 + dayOffset * DAY,
    txHash: `0x${id}`,
  };
}

function dis(
  id: string,
  qty: bigint,
  proceeds: bigint | null,
  dayOffset: number,
  nominatedLotIds?: string[],
): DisposalEvent {
  return {
    kind: 'dispose',
    id,
    asset: 'tok',
    assetSymbol: 'TOK',
    quantity: qty,
    decimals: 0,
    proceeds,
    timestamp: T0 + dayOffset * DAY,
    txHash: `0x${id}`,
    nominatedLotIds,
  };
}

function run(events: TaxLotEvent[], method: Parameters<typeof matchLots>[0]['method']) {
  return matchLots({ events, method, quoteCurrency: 'USD' });
}

// Three lots of 10 at rising cost, then one disposal of 10 for 500.
const LOTS: TaxLotEvent[] = [acq('a', 10n, 100n, 0), acq('b', 10n, 300n, 10), acq('c', 10n, 200n, 20)];

describe('the method chooses the lot, and the choice changes the answer', () => {
  it('FIFO consumes the oldest lot', () => {
    const r = run([...LOTS, dis('d', 10n, 500n, 30)], 'fifo');
    expect(r.disposals[0]!.lots.map((l) => l.lotId)).toEqual(['a']);
    expect(r.disposals[0]!.gain).toBe(400n);
  });

  it('LIFO consumes the newest lot', () => {
    const r = run([...LOTS, dis('d', 10n, 500n, 30)], 'lifo');
    expect(r.disposals[0]!.lots.map((l) => l.lotId)).toEqual(['c']);
    expect(r.disposals[0]!.gain).toBe(300n);
  });

  it('HIFO consumes the highest cost PER UNIT', () => {
    const r = run([...LOTS, dis('d', 10n, 500n, 30)], 'hifo');
    expect(r.disposals[0]!.lots.map((l) => l.lotId)).toEqual(['b']);
    expect(r.disposals[0]!.gain).toBe(200n);
  });

  it('HIFO ranks by unit cost, not by total — a big cheap lot must not win', () => {
    const r = run(
      [acq('big', 100n, 500n, 0), acq('small', 1n, 50n, 1), dis('d', 1n, 60n, 5)],
      'hifo',
    );
    // big: 5/unit. small: 50/unit. HIFO must take `small`.
    expect(r.disposals[0]!.lots.map((l) => l.lotId)).toEqual(['small']);
  });

  it('the four declared methods really are four different answers on one history', () => {
    const gains = (['fifo', 'lifo', 'hifo'] as const).map(
      (m) => run([...LOTS, dis('d', 10n, 500n, 30)], m).disposals[0]!.gain,
    );
    expect(new Set(gains).size).toBe(3);
  });
});

describe('specific identification honours the nomination and refuses to fall back', () => {
  it('consumes the nominated lot', () => {
    const r = run([...LOTS, dis('d', 10n, 500n, 30, ['c'])], 'spec-id');
    expect(r.disposals[0]!.lots.map((l) => l.lotId)).toEqual(['c']);
  });

  it('leaves an unnominated disposal unmatched rather than silently applying FIFO', () => {
    const r = run([...LOTS, dis('d', 10n, 500n, 30)], 'spec-id');
    const d = r.disposals[0]!;
    expect(d.lots).toEqual([]);
    expect(d.unmatchedQuantity).toBe(10n);
    expect(d.gain).toBeNull();
    expect(d.incompleteReasons).toContain('no-nomination');
    expect(r.totals.complete).toBe(false);
  });
});

describe('an unknown is never a zero', () => {
  it('a disposal with no acquiring lot is unmatched, NOT zero-basis', () => {
    const r = run([dis('d', 5n, 500n, 1)], 'fifo');
    const d = r.disposals[0]!;
    expect(d.gain).toBeNull();
    expect(d.costBasis).toBeNull();
    expect(d.unmatchedQuantity).toBe(5n);
    expect(d.incompleteReasons).toContain('no-acquiring-lot');
    // The dangerous wrong answer would have been 500.
    expect(r.totals.realisedGain).toBe(0n);
    expect(r.totals.countedRows).toBe(0);
    expect(r.totals.complete).toBe(false);
  });

  it('a lot with no recorded cost produces no gain, NOT a zero-cost gain', () => {
    const r = run([acq('a', 10n, null, 0), dis('d', 10n, 500n, 5)], 'fifo');
    expect(r.disposals[0]!.gain).toBeNull();
    expect(r.disposals[0]!.incompleteReasons).toContain('lot-cost-unrecorded');
  });

  it('a disposal with no recorded proceeds produces no gain, NOT a total loss', () => {
    const r = run([acq('a', 10n, 100n, 0), dis('d', 10n, null, 5)], 'fifo');
    expect(r.disposals[0]!.gain).toBeNull();
    expect(r.disposals[0]!.incompleteReasons).toContain('proceeds-unrecorded');
  });

  it('excludes every unpriced row from the totals and marks them as excluded', () => {
    const r = run([acq('a', 10n, 100n, 0), dis('d', 10n, 500n, 5), dis('e', 5n, 90n, 6)], 'fifo');
    expect(r.totals.countedRows).toBe(1);
    expect(r.totals.incompleteRows).toBe(1);
    expect(r.totals.realisedGain).toBe(400n);
    expect(r.totals.complete).toBe(false);
  });
});

describe('partial fills, apportionment and open lots', () => {
  it('splits one lot across two disposals and apportions its cost', () => {
    const r = run([acq('a', 10n, 100n, 0), dis('d', 4n, 60n, 1), dis('e', 6n, 90n, 2)], 'fifo');
    expect(r.disposals[0]!.costBasis).toBe(40n);
    expect(r.disposals[1]!.costBasis).toBe(60n);
    expect(r.totals.realisedGain).toBe(50n);
    expect(r.totals.complete).toBe(true);
  });

  it('spans two lots for one disposal', () => {
    const r = run([acq('a', 6n, 60n, 0), acq('b', 6n, 120n, 1), dis('d', 10n, 300n, 2)], 'fifo');
    const d = r.disposals[0]!;
    expect(d.lots.map((l) => [l.lotId, l.quantity])).toEqual([
      ['a', 6n],
      ['b', 4n],
    ]);
    expect(d.costBasis).toBe(60n + 80n);
  });

  it('reports what is still open, apportioned to what is left', () => {
    const r = run([acq('a', 10n, 100n, 0), dis('d', 4n, 60n, 1)], 'fifo');
    expect(r.openLots).toEqual([
      { lotId: 'a', asset: 'tok', assetSymbol: 'TOK', quantity: 6n, costBasis: 60n, acquiredAt: T0 },
    ]);
  });

  it('lets a same-timestamp buy be available to a same-timestamp sell', () => {
    const buy = acq('a', 10n, 100n, 0);
    const sell = { ...dis('d', 10n, 150n, 0) };
    // Deliberately fed sell-first: ordering is the matcher's job, not the caller's.
    const r = run([sell, buy], 'fifo');
    expect(r.disposals[0]!.gain).toBe(50n);
  });

  it('reports held days as arithmetic and classifies nothing as long-term', () => {
    const r = run([acq('a', 10n, 100n, 0), dis('d', 10n, 500n, 400)], 'fifo');
    expect(r.disposals[0]!.heldDays).toBe(400);
    // A holding period past any common threshold, and the result still carries
    // no classification of it — that is a jurisdiction's rule, not arithmetic.
    expect(Object.keys(r.disposals[0]!)).not.toContain('term');
    expect(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/long-term/i);
  });
});

describe('the method is declared, described and never defaulted', () => {
  it('every method in the closed union has a table entry', () => {
    for (const m of ['fifo', 'lifo', 'hifo', 'spec-id'] as const) {
      expect(isCostBasisMethod(m)).toBe(true);
      expect(methodInfo(m).label.length).toBeGreaterThan(3);
      expect(methodInfo(m).describes.length).toBeGreaterThan(20);
    }
    expect(COST_BASIS_METHODS).toHaveLength(4);
  });

  it('rejects a method it does not implement', () => {
    expect(isCostBasisMethod('average-cost')).toBe(false);
  });

  it('stamps the method onto whatever quotes methodStatement', () => {
    expect(methodStatement('hifo')).toMatch(/HIFO/);
    expect(methodStatement('hifo')).toMatch(/highest cost per unit/i);
  });

  it('carries the disclaimer as one shared constant', () => {
    expect(NOT_TAX_ADVICE).toMatch(/not tax advice/i);
  });

  it('echoes the method back on the result, so an export cannot mislabel itself', () => {
    expect(run([], 'lifo').method).toBe('lifo');
  });
});
