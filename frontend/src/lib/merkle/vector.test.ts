import { describe, it, expect } from 'vitest';
import { parseEther, type Address, type Hex } from 'viem';
import { buildCampaign, verifyManifest } from './campaign';
import { hashLeaf } from './leaf';
import { buildMerkleTree, merkleProof, verifyMerkleProof } from './tree';

/**
 * THE CROSS-LANGUAGE VECTOR.
 *
 * The claim frontend builds the tree; the distributor verifies it. If the two disagree
 * by one byte of encoding, one flipped pair, or one differently-handled odd node, the
 * failure does not appear until a funded campaign's first claim reverts with
 * `InvalidProof` — after the tokens are already inside an immutable, ownerless
 * contract whose only other exit is the creator's post-expiry `reclaim`.
 *
 * Every hex below is pinned identically in `contracts/test/AirdropMerkleVector.t.sol`,
 * where the same leaf set is hashed by Solidity, funded into a real
 * `TegridyAirdropDistributor`, and CLAIMED with these proofs. So these are not
 * "expected values this file agrees with itself about" — they are values the deployed
 * bytecode accepts.
 *
 * If this test fails, do not re-pin. Find out which side moved.
 */

const A1 = '0x1111111111111111111111111111111111111111' as Address;
const A2 = '0x2222222222222222222222222222222222222222' as Address;
const A3 = '0x3333333333333333333333333333333333333333' as Address;
const A4 = '0x4444444444444444444444444444444444444444' as Address;
const A5 = '0x5555555555555555555555555555555555555555' as Address;

const AMOUNTS = [
  parseEther('1'),
  parseEther('2.5'),
  parseEther('3'),
  parseEther('4'),
  parseEther('5'),
] as const;

const PINNED_ROOT = '0xdac60bc31939956e63b59cf73e032c5058ac5cdda9fdb5f1cad96c9a591799bf' as Hex;

const PINNED_LEAVES: readonly Hex[] = [
  '0x4da60c0f242c36ca0c001c2b61dcce6fb9a4bedf9e5695fc0257e1e844eab803',
  '0x50aa075e521cc443f33b4ef7ac4a4fac43bcfd06d61c5078de422e1f0d569039',
  '0xe1c82cab2726bcddd571159bc37c7e1dd890e2bc74af5e758d8e5df39a6ae02f',
  '0xf669f38582739dabd19073bfff6ccd4eeb6d5d1f14b0636d477a4e20b0d0b768',
  '0xe57b93b9982b54b9724c22cf33e7ab48a13e92489ddd586cb2df0fe7be44b721',
];

/** Index 0's proof, as the Solidity fixture emits it. */
const PINNED_PROOF_0: readonly Hex[] = [
  '0x50aa075e521cc443f33b4ef7ac4a4fac43bcfd06d61c5078de422e1f0d569039',
  '0xd984255d07dc6592ac18841146d17f40a1189649fee0b6e56ba9c527effa68e7',
  '0xe57b93b9982b54b9724c22cf33e7ab48a13e92489ddd586cb2df0fe7be44b721',
];

/** Index 4 is the promoted odd node: one proof element, not three. */
const PINNED_PROOF_4: readonly Hex[] = ['0x80a127bcde5206013830853f0d98d4f39dd125045a4d39f3c40a37246fb4921d'];

const ACCOUNTS = [A1, A2, A3, A4, A5] as const;

describe('merkle vector — TypeScript reproduces what the distributor accepts', () => {
  it('hashes each leaf exactly as MerkleDistributor does', () => {
    ACCOUNTS.forEach((account, index) => {
      expect(hashLeaf({ index, account, amount: AMOUNTS[index]! })).toBe(PINNED_LEAVES[index]);
    });
  });

  it('derives the pinned root', () => {
    const tree = buildMerkleTree(PINNED_LEAVES);
    expect(tree.root).toBe(PINNED_ROOT);
  });

  it('derives the pinned proof for a paired leaf', () => {
    const tree = buildMerkleTree(PINNED_LEAVES);
    expect(merkleProof(tree, 0)).toEqual([...PINNED_PROOF_0]);
  });

  it('derives the pinned single-element proof for the promoted odd node', () => {
    const tree = buildMerkleTree(PINNED_LEAVES);
    expect(merkleProof(tree, 4)).toEqual([...PINNED_PROOF_4]);
  });

  it('verifies the pinned proofs against the pinned root', () => {
    expect(verifyMerkleProof(PINNED_PROOF_0, PINNED_ROOT, PINNED_LEAVES[0]!)).toBe(true);
    expect(verifyMerkleProof(PINNED_PROOF_4, PINNED_ROOT, PINNED_LEAVES[4]!)).toBe(true);
  });

  it('rejects a proof re-pointed at another leaf', () => {
    expect(verifyMerkleProof(PINNED_PROOF_0, PINNED_ROOT, PINNED_LEAVES[2]!)).toBe(false);
  });

  it('rejects a truncated proof', () => {
    expect(verifyMerkleProof(PINNED_PROOF_0.slice(0, 2), PINNED_ROOT, PINNED_LEAVES[0]!)).toBe(false);
  });
});

describe('buildCampaign reaches the same root from an unordered list', () => {
  // Shuffled on purpose. The index a row gets is the on-chain bitmap slot, so it must
  // come from the address ordering rather than from whatever order the creator's
  // spreadsheet happened to be in — otherwise two people building "the same" campaign
  // from the same data publish two different roots.
  const shuffled = [
    { account: A4, amount: AMOUNTS[3]! },
    { account: A1, amount: AMOUNTS[0]! },
    { account: A5, amount: AMOUNTS[4]! },
    { account: A3, amount: AMOUNTS[2]! },
    { account: A2, amount: AMOUNTS[1]! },
  ];

  it('produces the pinned root and the canonical index order', () => {
    const manifest = buildCampaign(shuffled);
    expect(manifest.root).toBe(PINNED_ROOT);
    expect(manifest.rows.map((r) => r.account)).toEqual([...ACCOUNTS]);
    expect(manifest.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('emits the pinned proofs on the rows', () => {
    const manifest = buildCampaign(shuffled);
    expect(manifest.rows[0]!.proof).toEqual([...PINNED_PROOF_0]);
    expect(manifest.rows[4]!.proof).toEqual([...PINNED_PROOF_4]);
  });

  it('totals the funding the distributor must receive', () => {
    expect(buildCampaign(shuffled).total).toBe(parseEther('15.5'));
  });

  it('self-verifies every row', () => {
    expect(verifyManifest(buildCampaign(shuffled))).toEqual({ ok: true, badRows: [] });
  });
});
