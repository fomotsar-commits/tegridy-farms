import { encodePacked, getAddress, isAddress, keccak256, type Address, type Hex } from 'viem';

/**
 * Leaf encoding for TegridyAirdropDistributor.
 *
 * The encoding is not a choice this file gets to make. It is transcribed from the
 * vendored Uniswap distributor the campaign contract inherits
 * (contracts/src/vendor/uniswap-merkle-distributor/MerkleDistributor.sol):
 *
 *     bytes32 node = keccak256(abi.encodePacked(index, account, amount));
 *
 * with `index` and `amount` declared `uint256` and `account` declared `address`.
 * `abi.encodePacked` emits 32 + 20 + 32 = 84 bytes with no padding between the
 * fields, so widening `account` to 32 bytes, narrowing `index` to uint64, or
 * reordering the tuple all produce a root the deployed contract can never verify —
 * and the failure surfaces only at claim time, after a campaign has been funded.
 *
 * The 84-byte leaf preimage is also what keeps this tree safe from the internal-node
 * forgery that sorted-pair trees are otherwise exposed to: an internal node hashes a
 * 64-byte preimage, so no internal node can be replayed as a leaf.
 */

/** One row of a campaign — the exact tuple the distributor hashes. */
export interface AirdropLeaf {
  /** Position in the campaign, `uint256` on-chain. Also the claimed-bitmap slot. */
  index: number;
  /** Recipient. Tokens always go here, never to the caller of `claim`. */
  account: Address;
  /** Base-unit amount, `uint256` on-chain. Never a decimal figure. */
  amount: bigint;
}

/** Widest value each `uint256` field may carry before the encoder would truncate. */
const UINT256_MAX = (1n << 256n) - 1n;

function assertValidLeaf(leaf: AirdropLeaf): void {
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
 * here, but normalising makes the dedup check in `campaign.ts` compare the same thing
 * the hash does.
 */
export function hashLeaf(leaf: AirdropLeaf): Hex {
  assertValidLeaf(leaf);
  return keccak256(
    encodePacked(['uint256', 'address', 'uint256'], [BigInt(leaf.index), getAddress(leaf.account), leaf.amount]),
  );
}
