import { describe, it, expect } from 'vitest';
import { pad, toHex, type Address } from 'viem';
import { buildCampaign, verifyManifest } from './campaign';
import { verifyMerkleProof } from './tree';
import { hashLeaf } from './leaf';

/**
 * The size the build note actually asks for: a campaign with 1,000+ leaves.
 *
 * Two things are being checked, and only one of them is arithmetic.
 *
 *   - Every proof in a large tree verifies. A tree that is correct at four leaves can
 *     still be wrong at a thousand, because odd-node promotion only bites on layers
 *     whose length is odd, and 1,000 has odd layers at several depths (1000 → 500 →
 *     250 → 125 → 63 → 32 → 16 → 8 → 4 → 2 → 1) while 1,024 has none.
 *   - The index a row gets is stable under input order. It is the on-chain bitmap slot,
 *     so it has to come from the data and not from the file.
 */

function addressAt(i: number): Address {
  return pad(toHex(i + 1), { size: 20 }) as Address;
}

function listOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({ account: addressAt(i), amount: BigInt(i + 1) * 10n ** 15n }));
}

describe('a thousand-leaf campaign', () => {
  const list = listOf(1000);
  const manifest = buildCampaign(list);

  it('assigns a contiguous index per row and totals every allocation', () => {
    expect(manifest.rows).toHaveLength(1000);
    expect(manifest.rows.map((r) => r.index)).toEqual([...Array(1000).keys()]);
    expect(manifest.total).toBe(list.reduce((s, e) => s + e.amount, 0n));
  });

  it('verifies all 1,000 proofs against the root', () => {
    expect(verifyManifest(manifest)).toEqual({ ok: true, badRows: [] });
  });

  it('rejects a row proof when re-pointed at its neighbour', () => {
    // A tree where every proof verifies is only half the property; proofs must also
    // fail for leaves they were not issued for, or the root proves nothing.
    for (let i = 0; i < 50; i++) {
      const row = manifest.rows[i]!;
      const neighbour = manifest.rows[i + 1]!;
      expect(verifyMerkleProof(row.proof, manifest.root, neighbour.leaf)).toBe(false);
    }
  });

  it('produces the same root from a reversed input list', () => {
    const reversed = buildCampaign([...list].reverse());
    expect(reversed.root).toBe(manifest.root);
    expect(reversed.rows.map((r) => r.account)).toEqual(manifest.rows.map((r) => r.account));
  });
});

describe('a power-of-two campaign has no promoted nodes and still agrees', () => {
  const manifest = buildCampaign(listOf(1024));

  it('verifies every proof', () => {
    expect(verifyManifest(manifest)).toEqual({ ok: true, badRows: [] });
  });

  it('gives every leaf a full-depth proof', () => {
    // 1,024 leaves = 10 layers above the leaves, and with no odd node anywhere every
    // proof is exactly 10 long. A short proof here would mean a layer was skipped.
    for (const row of manifest.rows) expect(row.proof).toHaveLength(10);
  });

  it('hashes each row to the leaf recorded on it', () => {
    for (const row of manifest.rows) {
      expect(hashLeaf({ index: row.index, account: row.account, amount: row.amount })).toBe(row.leaf);
    }
  });
});
