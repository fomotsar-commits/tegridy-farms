import { concatHex, keccak256, type Hex } from 'viem';

/**
 * The tree shape OpenZeppelin's `MerkleProof.verify` consumes, which is what the
 * vendored distributor calls.
 *
 * Two properties are load-bearing and neither is a preference:
 *
 *   - Pairs are hashed COMMUTATIVELY: the two 32-byte words are ordered by their
 *     numeric value before hashing, because `MerkleProof._hashPair` does the same and
 *     a proof therefore carries no left/right information for the verifier to check.
 *   - An odd node at the end of a layer is PROMOTED unchanged to the next layer
 *     rather than paired with itself. Duplicating it would still verify, but it makes
 *     two distinct index paths resolve to one node.
 *
 * contracts/test/AirdropFactory.t.sol builds the identical shape in Solidity, and
 * contracts/test/AirdropMerkleVector.t.sol pins one concrete tree that both languages
 * must agree on.
 */

export interface MerkleTree {
  /** Leaf hashes in campaign-index order — position i is the leaf for index i. */
  readonly leaves: readonly Hex[];
  /** layers[0] is the leaves; the last layer is the single root. */
  readonly layers: readonly (readonly Hex[])[];
  readonly root: Hex;
}

/** Lowercase so the string comparison below matches Solidity's numeric bytes32 compare. */
function norm(h: Hex): Hex {
  return h.toLowerCase() as Hex;
}

/**
 * `keccak256(abi.encode(a, b))` with the pair sorted — `abi.encode` of two `bytes32`
 * is their plain 64-byte concatenation, so concatenating here is the same bytes.
 *
 * Both words are fixed-width lowercase hex of equal length, so lexicographic string
 * order and 256-bit numeric order coincide.
 */
function hashPair(a: Hex, b: Hex): Hex {
  const x = norm(a);
  const y = norm(b);
  return x <= y ? keccak256(concatHex([x, y])) : keccak256(concatHex([y, x]));
}

export function buildMerkleTree(leaves: readonly Hex[]): MerkleTree {
  if (leaves.length === 0) {
    // A campaign with no leaves has no root to fund against. The factory rejects a
    // zero root, so returning one here would only move the failure to the wallet.
    throw new Error('merkle tree: cannot build a tree with no leaves');
  }
  const seen = new Set<string>();
  for (const leaf of leaves) {
    const key = norm(leaf);
    if (seen.has(key)) {
      // Identical leaves occupy two index positions that hash the same, so a proof
      // for one verifies for the other while the claimed-bitmap treats them as
      // separate slots. Refused rather than deduped: silently dropping a row would
      // change what the operator funded without telling them.
      throw new Error(`merkle tree: duplicate leaf ${key}`);
    }
    seen.add(key);
  }

  const layers: Hex[][] = [leaves.map(norm)];
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!);
    }
    layers.push(next);
  }

  return { leaves: layers[0]!, layers, root: layers[layers.length - 1]![0]! };
}

/** Sibling hashes from leaf to root for one campaign index. */
export function merkleProof(tree: MerkleTree, index: number): Hex[] {
  if (!Number.isInteger(index) || index < 0 || index >= tree.leaves.length) {
    throw new Error(`merkle tree: index ${String(index)} is outside 0..${tree.leaves.length - 1}`);
  }
  const proof: Hex[] = [];
  let idx = index;
  for (let d = 0; d + 1 < tree.layers.length; d++) {
    const layer = tree.layers[d]!;
    const sibling = idx ^ 1;
    // Absent only for a promoted odd node, which contributes no proof element.
    if (sibling < layer.length) proof.push(layer[sibling]!);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * The verifier, transcribed from `MerkleProof.processProof`.
 *
 * Written out rather than reusing `buildMerkleTree` so a claimant's check is
 * independent of the builder: a bug that produced a self-consistent but wrong tree
 * would still be caught here, because this function only knows the proof, the leaf,
 * and the root the chain reported.
 */
export function verifyMerkleProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let computed = norm(leaf);
  for (const node of proof) computed = hashPair(computed, node);
  return computed === norm(root);
}
