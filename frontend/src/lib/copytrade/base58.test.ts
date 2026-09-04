import { describe, it, expect } from 'vitest';
import { base58Decode, isSolanaPubkey, isSolanaSignature } from './base58';

// The whole point of this module is that LENGTH IN CHARACTERS IS NOT LENGTH IN
// BYTES. Every case here is one a bare 32–44-char regex gets wrong.

describe('base58Decode', () => {
  it('decodes the wrapped-SOL mint to 32 bytes', () => {
    const bytes = base58Decode('So11111111111111111111111111111111111111112');
    expect(bytes?.length).toBe(32);
  });

  it('keeps the all-1 System Program key at 32 bytes, not 33', () => {
    // The regression the verifier's own comment records: padding "0" to "00"
    // before the zero test appends a spurious byte and turns the most
    // recognisable key on the chain into "not a Solana address".
    const bytes = base58Decode('11111111111111111111111111111111');
    expect(bytes?.length).toBe(32);
    expect(bytes?.every((b) => b === 0)).toBe(true);
  });

  it('returns null for characters outside the alphabet', () => {
    for (const bad of ['0', 'O', 'I', 'l']) {
      expect(base58Decode(`${bad}oooooooooooooooooooooooooooooooo`), bad).toBeNull();
    }
    expect(base58Decode('')).toBeNull();
  });
});

describe('isSolanaPubkey', () => {
  it('accepts a real 32-byte mint', () => {
    expect(isSolanaPubkey('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isSolanaPubkey('4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump')).toBe(true);
  });

  it('rejects a 44-character base58 string that decodes to 33 bytes', () => {
    // Passes /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ and is still not an address. A
    // regex-only guard would store this and link it.
    const s = 'z'.repeat(44);
    expect(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)).toBe(true);
    expect(base58Decode(s)?.length).toBe(33);
    expect(isSolanaPubkey(s)).toBe(false);
  });

  it('rejects an EVM address and a signature-length key', () => {
    expect(isSolanaPubkey('0x420698CFdEDdEa6bc78D59bC17798113ad278F9D')).toBe(false);
    expect(isSolanaPubkey('5'.repeat(88))).toBe(false);
  });
});

describe('isSolanaSignature', () => {
  it('separates a 64-byte signature from a 32-byte pubkey', () => {
    // Built rather than pasted so the assertion is about byte length and not
    // about one captured string.
    const sig = 'z'.repeat(87);
    expect(base58Decode(sig)?.length).toBe(64);
    expect(isSolanaSignature(sig)).toBe(true);
    expect(isSolanaPubkey(sig)).toBe(false);
    expect(isSolanaSignature('So11111111111111111111111111111111111111112')).toBe(false);
  });
});
