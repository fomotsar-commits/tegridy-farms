// Leaf encoding and tree shape for TegridyAirdropDistributor — the ONE implementation.
//
// WHY THIS IS .js AND NOT .ts (this is the whole reason the file exists):
//   frontend/api/_lib/airdrop.js generates proofs server-side and must hash leaves and
//   pairs EXACTLY as the browser does. A Vercel lambda cannot import a .ts module, so
//   the only two options were this file or a hand-maintained JS fork of leaf.ts +
//   tree.ts. A fork of a leaf encoding is the worst possible fork: a divergence produces
//   a root the deployed bytecode can never verify, and it surfaces at claim time, after
//   a campaign has been funded. Types live in the co-located core.d.ts, which is erased
//   at build time. Same arrangement, same reasoning as api/_lib/record-core.js.
//
// ─── The leaf encoding is not a choice this file gets to make ────────────────
//
// It is transcribed from the vendored Uniswap distributor the campaign contract
// inherits (contracts/src/vendor/uniswap-merkle-distributor/MerkleDistributor.sol):
//
//     bytes32 node = keccak256(abi.encodePacked(index, account, amount));
//
// with `index` and `amount` declared `uint256` and `account` declared `address`.
// `abi.encodePacked` emits 32 + 20 + 32 = 84 bytes with no padding between the fields,
// so widening `account` to 32 bytes, narrowing `index` to uint64, or reordering the
// tuple all produce a root the deployed contract can never verify.
//
// The 84-byte leaf preimage is also what keeps this tree safe from the internal-node
// forgery that sorted-pair trees are otherwise exposed to: an internal node hashes a
// 64-byte preimage, so no internal node can be replayed as a leaf.
//
// ─── The tree shape is likewise transcribed ──────────────────────────────────
//
// This is the shape OpenZeppelin's `MerkleProof.verify` consumes, which is what the
// vendored distributor calls. Two properties are load-bearing and neither is a
// preference:
//
//   - Pairs are hashed COMMUTATIVELY: the two 32-byte words are ordered by their
//     numeric value before hashing, because `MerkleProof._hashPair` does the same and a
//     proof therefore carries no left/right information for the verifier to check.
//   - An odd node at the end of a layer is PROMOTED unchanged to the next layer rather
//     than paired with itself. Duplicating it would still verify, but it makes two
//     distinct index paths resolve to one node.
//
// contracts/test/AirdropFactory.t.sol builds the identical shape in Solidity, and
// contracts/test/AirdropMerkleVector.t.sol pins one concrete tree that both languages
// must agree on. src/lib/merkle/vector.test.ts pins the same tree from this side.

import { concatHex, encodePacked, getAddress, isAddress, keccak256 } from 'viem';

/** Widest value each `uint256` field may carry before the encoder would truncate. */
const UINT256_MAX = (1n << 256n) - 1n;

function assertValidLeaf(leaf) {
  if (!Number.isInteger(leaf.index) || leaf.index < 0) {
    throw new Error(`merkle leaf: index must be a non-negative integer, got ${String(leaf.index)}`);
  }
  if (!Number.isSafeInteger(leaf.index)) {
    throw new Error(`merkle leaf: index ${String(leaf.index)} exceeds the safe-integer range`);
  }
  if (!isAddress(leaf.account)) {
    throw new Error(`merkle leaf: ${String(leaf.account)} is not an address`);
  }
  if (typeof leaf.amount !== 'bigint') {
    throw new Error('merkle leaf: amount must be a bigint of base units');
  }
  if (leaf.amount < 0n || leaf.amount > UINT256_MAX) {
    throw new Error(`merkle leaf: amount ${leaf.amount.toString()} is outside uint256`);
  }
  if (leaf.amount === 0n) {
    // A zero-amount leaf burns its bitmap slot on a transfer of nothing. Rejected at
    // build time rather than left to disappoint a claimant who paid gas for it.
    throw new Error('merkle leaf: amount must be greater than zero');
  }
}

/**
 * Hash one leaf exactly as the distributor does.
 *
 * `getAddress` is applied first so a lowercase, uppercase or checksummed spelling of
 * the same account produces the same leaf — viem's packed encoder is case-insensitive
 * here, but normalising makes the dedup check in campaign.ts compare the same thing
 * the hash does.
 */
export function hashLeaf(leaf) {
  assertValidLeaf(leaf);
  return keccak256(
    encodePacked(['uint256', 'address', 'uint256'], [BigInt(leaf.index), getAddress(leaf.account), leaf.amount]),
  );
}

/** Lowercase so the string comparison below matches Solidity's numeric bytes32 compare. */
function norm(h) {
  return h.toLowerCase();
}

/**
 * `keccak256(abi.encode(a, b))` with the pair sorted — `abi.encode` of two `bytes32`
 * is their plain 64-byte concatenation, so concatenating here is the same bytes.
 *
 * Both words are fixed-width lowercase hex of equal length, so lexicographic string
 * order and 256-bit numeric order coincide.
 */
function hashPair(a, b) {
  const x = norm(a);
  const y = norm(b);
  return x <= y ? keccak256(concatHex([x, y])) : keccak256(concatHex([y, x]));
}

export function buildMerkleTree(leaves) {
  if (leaves.length === 0) {
    // A campaign with no leaves has no root to fund against. The factory rejects a
    // zero root, so returning one here would only move the failure to the wallet.
    throw new Error('merkle tree: cannot build a tree with no leaves');
  }
  const seen = new Set();
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

  const layers = [leaves.map(norm)];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }

  return { leaves: layers[0], layers, root: layers[layers.length - 1][0] };
}

/** Sibling hashes from leaf to root for one campaign index. */
export function merkleProof(tree, index) {
  if (!Number.isInteger(index) || index < 0 || index >= tree.leaves.length) {
    throw new Error(`merkle tree: index ${String(index)} is outside 0..${tree.leaves.length - 1}`);
  }
  const proof = [];
  let idx = index;
  for (let d = 0; d + 1 < tree.layers.length; d++) {
    const layer = tree.layers[d];
    const sibling = idx ^ 1;
    // Absent only for a promoted odd node, which contributes no proof element.
    if (sibling < layer.length) proof.push(layer[sibling]);
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
export function verifyMerkleProof(proof, root, leaf) {
  let computed = norm(leaf);
  for (const node of proof) computed = hashPair(computed, node);
  return computed === norm(root);
}
