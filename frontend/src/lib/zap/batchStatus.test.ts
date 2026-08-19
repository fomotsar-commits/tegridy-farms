import { describe, it, expect } from 'vitest';
import { parseCallsStatus } from './batchStatus';

describe('parseCallsStatus', () => {
  it('reads a pending batch as pending', () => {
    expect(parseCallsStatus({ status: 100 }, 2)).toEqual({ kind: 'pending' });
    expect(parseCallsStatus({ status: 'PENDING' }, 2)).toEqual({ kind: 'pending' });
  });

  it('spreads one shared receipt across every call in the batch', () => {
    const out = parseCallsStatus({ status: 200, receipts: [{ status: '0x1', transactionHash: '0xabc' }] }, 3);
    expect(out).toEqual({
      kind: 'settled',
      calls: [
        { status: 'confirmed', txHash: '0xabc' },
        { status: 'confirmed', txHash: '0xabc' },
        { status: 'confirmed', txHash: '0xabc' },
      ],
    });
  });

  it('maps one receipt per call when the wallet returns them that way', () => {
    const out = parseCallsStatus(
      { status: 200, receipts: [{ status: '0x1', transactionHash: '0xa' }, { status: '0x0', transactionHash: '0xb' }] },
      2,
    );
    expect(out).toEqual({
      kind: 'settled',
      calls: [
        { status: 'confirmed', txHash: '0xa' },
        { status: 'reverted', txHash: '0xb' },
      ],
    });
  });

  it('reports a pre-execution rejection as failed, which is safe to send again', () => {
    expect(parseCallsStatus({ status: 400 }, 2)).toMatchObject({ kind: 'failed' });
  });

  it('refuses to align a receipt count that matches neither shape', () => {
    const out = parseCallsStatus({ status: 200, receipts: [{ status: '0x1' }, { status: '0x1' }] }, 3);
    expect(out.kind).toBe('unreadable');
  });

  it('refuses a receipt whose status it does not recognise', () => {
    expect(parseCallsStatus({ status: 200, receipts: [{ status: 'maybe' }] }, 1).kind).toBe('unreadable');
  });

  it('treats a failure with no receipts as unknown, not as failed', () => {
    // The difference matters: `failed` resumes, `unreadable` blocks until someone looks.
    const out = parseCallsStatus({ status: 500 }, 2);
    expect(out.kind).toBe('unreadable');
  });

  it('refuses garbage rather than reading it optimistically', () => {
    for (const payload of [null, 'ok', 42, [], {}, { status: 200 }]) {
      expect(parseCallsStatus(payload, 1).kind).toBe('unreadable');
    }
  });
});
