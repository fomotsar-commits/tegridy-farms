// Types for core.js — the shared leaf/tree runtime.
//
// The runtime lives in the sibling .js because a Vercel lambda cannot import a .ts
// module and the alternative was a hand-maintained JS fork of a leaf encoding. See
// core.js's header for the full reasoning. This file is erased at build time; it exists
// so the TypeScript side keeps every type it had when this code was leaf.ts + tree.ts.

import type { Address, Hex } from 'viem';

/** One row of a campaign — the exact tuple the distributor hashes. */
export interface AirdropLeaf {
  /** Position in the campaign, `uint256` on-chain. Also the claimed-bitmap slot. */
  index: number;
  /** Recipient. Tokens always go here, never to the caller of `claim`. */
  account: Address;
  /** Base-unit amount, `uint256` on-chain. Never a decimal figure. */
  amount: bigint;
}

export interface MerkleTree {
  /** Leaf hashes in campaign-index order — position i is the leaf for index i. */
  readonly leaves: readonly Hex[];
  /** layers[0] is the leaves; the last layer is the single root. */
  readonly layers: readonly (readonly Hex[])[];
  readonly root: Hex;
}

/** Throws on any leaf the distributor could not pay out; never returns a bad hash. */
export declare function hashLeaf(leaf: AirdropLeaf): Hex;

export declare function buildMerkleTree(leaves: readonly Hex[]): MerkleTree;

export declare function merkleProof(tree: MerkleTree, index: number): Hex[];

export declare function verifyMerkleProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean;
