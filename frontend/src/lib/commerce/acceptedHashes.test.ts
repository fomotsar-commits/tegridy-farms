import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACCEPTED_HASHES_KEY,
  loadAccepted,
  previouslyAcceptedFor,
  recordAccepted,
} from './acceptedHashes';

const MERCHANT_A = '0x1111111111111111111111111111111111111111';
const MERCHANT_B = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'ab'.repeat(32)}`;
const NOW = 1_760_000_000;

beforeEach(() => localStorage.clear());

describe('the merchant remembers which hashes they already counted', () => {
  it('answers with the invoice a hash was accepted for', () => {
    expect(recordAccepted(MERCHANT_A, 1, HASH, 'inv-abc234def567', NOW)).toBe(true);
    expect(previouslyAcceptedFor(MERCHANT_A, 1, HASH)).toBe('inv-abc234def567');
  });

  it('matches a hash pasted back in a different case', () => {
    recordAccepted(MERCHANT_A, 1, HASH, 'inv-abc234def567', NOW);
    expect(previouslyAcceptedFor(MERCHANT_A, 1, HASH.toUpperCase().replace('0X', '0x'))).toBe('inv-abc234def567');
  });

  it('never answers about another merchant\'s ledger', () => {
    recordAccepted(MERCHANT_A, 1, HASH, 'inv-abc234def567', NOW);
    expect(previouslyAcceptedFor(MERCHANT_B, 1, HASH)).toBeNull();
    expect(loadAccepted(MERCHANT_B)).toEqual([]);
  });

  it('treats the same 32 bytes on another chain as another transaction', () => {
    recordAccepted(MERCHANT_A, 1, HASH, 'inv-abc234def567', NOW);
    expect(previouslyAcceptedFor(MERCHANT_A, 8453, HASH)).toBeNull();
  });

  it('keeps the FIRST invoice a hash was counted for', () => {
    // The whole point of the row is to be able to say "you already used this on
    // X". Overwriting with the second presentation would erase the evidence.
    recordAccepted(MERCHANT_A, 1, HASH, 'inv-first0000000', NOW);
    recordAccepted(MERCHANT_A, 1, HASH, 'inv-second000000', NOW + 60);
    expect(previouslyAcceptedFor(MERCHANT_A, 1, HASH)).toBe('inv-first0000000');
  });

  it('refuses to record something that is not a hash or not an address', () => {
    expect(recordAccepted(MERCHANT_A, 1, '0xdead', 'inv-abc234def567', NOW)).toBe(false);
    expect(recordAccepted('not-an-address', 1, HASH, 'inv-abc234def567', NOW)).toBe(false);
    expect(loadAccepted(MERCHANT_A)).toEqual([]);
  });
});

describe('a ledger that cannot be read is empty, never a throw', () => {
  it('survives a corrupt envelope', () => {
    localStorage.setItem(ACCEPTED_HASHES_KEY, '{not json at all');
    expect(() => loadAccepted(MERCHANT_A)).not.toThrow();
    expect(loadAccepted(MERCHANT_A)).toEqual([]);
    expect(previouslyAcceptedFor(MERCHANT_A, 1, HASH)).toBeNull();
  });

  it('drops rows that no longer decode rather than repairing them', () => {
    // A repaired row here would be an invoice id nobody chose, standing in for
    // the fact a merchant is about to release goods against.
    localStorage.setItem(
      ACCEPTED_HASHES_KEY,
      JSON.stringify({
        v: 1,
        rows: [
          { merchant: MERCHANT_A, chainId: 1, txHash: HASH, invoiceId: 'inv-good00000000', acceptedAt: NOW },
          { merchant: MERCHANT_A, chainId: 1, txHash: '0xshort', invoiceId: 'inv-bad000000000', acceptedAt: NOW },
          { merchant: MERCHANT_A, txHash: HASH, invoiceId: 'inv-nochain00000', acceptedAt: NOW },
        ],
      }),
    );
    const rows = loadAccepted(MERCHANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invoiceId).toBe('inv-good00000000');
  });
});
