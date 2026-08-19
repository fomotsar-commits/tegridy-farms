import { describe, it, expect } from 'vitest';
import { getAddress, parseEther, type Address } from 'viem';
import { buildCampaign, findRow, parseManifest, serializeManifest, verifyManifest } from './campaign';
import { hashLeaf } from './leaf';
import { buildMerkleTree } from './tree';

// Lowercase throughout: viem's `isAddress` is checksum-strict by default, which is the
// behaviour we want (a mixed-case address that fails EIP-55 is a transcription error,
// not an address). All-lowercase is the unambiguous spelling a paste actually carries.
const A = '0xaaaa000000000000000000000000000000000001' as Address;
const B = '0xbbbb000000000000000000000000000000000002' as Address;
const C = '0xcccc000000000000000000000000000000000003' as Address;

const LIST = [
  { account: A, amount: parseEther('10') },
  { account: B, amount: parseEther('20') },
  { account: C, amount: parseEther('30') },
];

describe('buildCampaign refuses lists it cannot honestly turn into a tree', () => {
  it('rejects an empty list rather than emitting a root for nothing', () => {
    expect(() => buildCampaign([])).toThrow(/empty/i);
  });

  it('rejects a duplicated wallet, naming both rows', () => {
    // Summing silently would change the amount the operator reviewed. Dropping one
    // silently would pay less than the list said. Both are worse than refusing.
    expect(() =>
      buildCampaign([
        { account: A, amount: parseEther('10') },
        { account: A, amount: parseEther('5') },
      ]),
    ).toThrow(/appears twice \(rows 1 and 2\)/);
  });

  it('rejects a zero allocation instead of burning a bitmap slot on nothing', () => {
    expect(() => buildCampaign([{ account: A, amount: 0n }])).toThrow(/greater than zero/);
  });

  it('is case-insensitive about the same wallet spelled differently', () => {
    expect(() =>
      buildCampaign([
        { account: A, amount: parseEther('1') },
        { account: getAddress(A), amount: parseEther('1') },
      ]),
    ).toThrow(/appears twice/);
  });
});

describe('manifests are self-checking', () => {
  it('verifies every row against its own root', () => {
    expect(verifyManifest(buildCampaign(LIST))).toEqual({ ok: true, badRows: [] });
  });

  it('catches a tampered amount', () => {
    const m = buildCampaign(LIST);
    // The scenario: someone edits a published manifest to enlarge their allocation.
    // The proof no longer reproduces the root, so the claim page must refuse it here
    // rather than let the distributor revert at the wallet prompt.
    m.rows[1]!.amount = parseEther('999');
    const check = verifyManifest(m);
    expect(check.ok).toBe(false);
    expect(check.badRows).toContain(1);
  });

  it('catches a leaf that does not match its own row fields', () => {
    const m = buildCampaign(LIST);
    m.rows[0]!.leaf = m.rows[2]!.leaf;
    expect(verifyManifest(m).ok).toBe(false);
  });

  it('finds a wallet regardless of address casing', () => {
    const m = buildCampaign(LIST);
    // Stored checksummed, looked up by whatever spelling the wallet reports.
    expect(findRow(m, B)?.account).toBe(getAddress(B));
    expect(findRow(m, getAddress(B))?.account).toBe(getAddress(B));
    expect(findRow(m, '0x000000000000000000000000000000000000dead' as Address)).toBeNull();
  });
});

describe('serialisation survives the JSON boundary', () => {
  it('round-trips amounts as base-unit strings, not numbers', () => {
    const m = buildCampaign([{ account: A, amount: 12345678901234567890123456n }]);
    m.criteria = 'holders at block 25,900,000';
    const back = parseManifest(serializeManifest(m));
    expect(back.rows[0]!.amount).toBe(12345678901234567890123456n);
    expect(back.root).toBe(m.root);
    expect(back.criteria).toBe('holders at block 25,900,000');
    // The JSON never carries a number for an amount — a 1e24 allocation would not
    // survive an IEEE-754 double, and the loss would be silent.
    expect(serializeManifest(m)).toContain('"amount": "12345678901234567890123456"');
  });

  it('refuses a manifest that is not one, instead of returning a partial object', () => {
    expect(() => parseManifest('not json')).toThrow(/valid JSON/);
    expect(() => parseManifest('{"version":2,"root":"0x00","rows":[]}')).toThrow(/version/);
    expect(() => parseManifest('{"version":1,"root":"0xdeadbeef","rows":[]}')).toThrow(/32-byte/);
    expect(() =>
      parseManifest(JSON.stringify({ version: 1, root: `0x${'11'.repeat(32)}`, rows: [] })),
    ).toThrow(/rows are missing/);
  });

  it('refuses an amount smuggled in as a JSON number', () => {
    const m = buildCampaign(LIST);
    const raw = JSON.parse(serializeManifest(m)) as { rows: { amount: unknown }[] };
    raw.rows[0]!.amount = 1e21;
    expect(() => parseManifest(JSON.stringify(raw))).toThrow(/decimal string of base units/);
  });
});

describe('the tree refuses shapes that would make a proof ambiguous', () => {
  it('rejects duplicate leaves', () => {
    const leaf = hashLeaf({ index: 0, account: A, amount: 1n });
    expect(() => buildMerkleTree([leaf, leaf])).toThrow(/duplicate leaf/);
  });

  it('rejects an empty leaf set', () => {
    expect(() => buildMerkleTree([])).toThrow(/no leaves/);
  });
});
