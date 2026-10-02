// The write-slot fence both cards share. Fail CLOSED on anything unknown; open at or
// past the write's slot, so the wait is never permanent; and never another wallet's.
import { describe, it, expect, vi } from 'vitest';
import { basisBehindWrite, confirmedSlotOf, slotOrNull } from './writeFence';

const ME = 'Me111';

describe('basisBehindWrite', () => {
  it('no fence, or another wallet\'s fence, never marks a basis stale', () => {
    expect(basisBehindWrite(null, ME, 1)).toBe(false);
    expect(basisBehindWrite({ key: 'Other', slot: 500 }, ME, 1)).toBe(false);
  });

  it('⚠️ a basis older than the write is stale; at or past it is not', () => {
    expect(basisBehindWrite({ key: ME, slot: 500 }, ME, 400)).toBe(true);
    expect(basisBehindWrite({ key: ME, slot: 500 }, ME, 499)).toBe(true);
    expect(basisBehindWrite({ key: ME, slot: 500 }, ME, 500)).toBe(false);
    expect(basisBehindWrite({ key: ME, slot: 500 }, ME, 501)).toBe(false);
  });

  it('⚠️ a missing slot on EITHER side is stale (fail closed)', () => {
    expect(basisBehindWrite({ key: ME, slot: null }, ME, 900)).toBe(true);
    expect(basisBehindWrite({ key: ME, slot: 500 }, ME, null)).toBe(true);
    expect(basisBehindWrite({ key: ME, slot: 500 }, ME, undefined)).toBe(true);
    expect(basisBehindWrite({ key: ME, slot: 500 }, ME, 500.5)).toBe(true);
  });
});

describe('confirmedSlotOf / slotOrNull', () => {
  it('reads value[0].slot, and null on none, junk, or a failed call — never a guess', async () => {
    expect(await confirmedSlotOf({ getSignatureStatuses: vi.fn(async () => ({ value: [{ slot: 500 }] })) }, 'S')).toBe(500);
    expect(await confirmedSlotOf({ getSignatureStatuses: vi.fn(async () => ({ value: [null] })) }, 'S')).toBeNull();
    expect(await confirmedSlotOf({ getSignatureStatuses: vi.fn(async () => ({ value: [{ slot: '500' }] })) }, 'S')).toBeNull();
    expect(await confirmedSlotOf({ getSignatureStatuses: vi.fn(async () => { throw new Error('down'); }) }, 'S')).toBeNull();
    expect(slotOrNull(-1)).toBeNull();
    expect(slotOrNull(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
