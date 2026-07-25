import { describe, it, expect } from 'vitest';
import { splitRowStatus, parseAttentionSplits } from './LaunchPage';

const A = '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456'; // checksum-valid
const B = '0x00000000000000000000000000000000000000AA';

// The attention-split fee stream is perpetual and immutable, so a mistyped
// beneficiary must FAIL LOUDLY — the old code silently dropped invalid rows at
// submit while the displayed remainder still counted them, shipping a launch
// whose fee split differed from what the wizard showed.
describe('attention split validation', () => {
  it('classifies blank / valid / invalid rows', () => {
    expect(splitRowStatus({ address: '', shareBps: 0 })).toMatchObject({ blank: true, invalid: false });
    expect(splitRowStatus({ address: A, shareBps: 1000 })).toMatchObject({ valid: true, invalid: false });
    expect(splitRowStatus({ address: '0xnotanaddress', shareBps: 500 })).toMatchObject({ invalid: true });
    expect(splitRowStatus({ address: A, shareBps: 0 })).toMatchObject({ invalid: true }); // addr, no share
    expect(splitRowStatus({ address: '', shareBps: 500 })).toMatchObject({ invalid: true }); // share, no addr
  });

  it('trims surrounding whitespace when classifying (the common paste bug)', () => {
    expect(splitRowStatus({ address: `  ${A}  `, shareBps: 500 })).toMatchObject({ valid: true });
  });

  it('parseAttentionSplits keeps valid rows and ignores blanks', () => {
    const out = parseAttentionSplits([
      { address: A, shareBps: 1000 },
      { address: '', shareBps: 0 }, // blank — ignored
      { address: `  ${B}  `, shareBps: 500 }, // trimmed
    ]);
    expect(out).toEqual([
      { address: A, shareBps: 1000 },
      { address: B, shareBps: 500 },
    ]);
  });

  it('THROWS on an invalid non-blank row — never silently drops it', () => {
    expect(() => parseAttentionSplits([
      { address: A, shareBps: 1000 },
      { address: '0xdeadbeef', shareBps: 500 }, // malformed
    ])).toThrow(/Invalid attention beneficiary/);
  });

  it('MUTATION GUARD: the old silent-drop would have returned only the valid row', () => {
    const rows = [
      { address: A, shareBps: 1000 },
      { address: '0xdeadbeef', shareBps: 500 }, // malformed — old code dropped it
    ];
    // Reconstruct the pre-fix behaviour and assert it hid the bad row (the bug).
    const oldSilent = rows.filter((r) => splitRowStatus(r).valid);
    expect(oldSilent).toHaveLength(1);
    // The fix refuses instead of silently proceeding with the dropped row.
    expect(() => parseAttentionSplits(rows)).toThrow();
  });
});
