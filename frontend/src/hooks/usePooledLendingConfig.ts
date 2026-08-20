import { isDeployed } from '../lib/constants';

// Wiring for the pooled NFT-lending pools (#61) and the instalment desk (#62).
//
// EVERY ADDRESS HERE IS ZERO AND THAT IS THE FEATURE'S STATE, NOT AN OVERSIGHT.
// `contracts/src/nftfi/NftfiPooledLendingVault.sol` and `NftfiBnpl.sol` are
// written, tested and deployed nowhere. No ceremony has run, so there is no
// address to put here, and until one exists every surface below reports the
// pool as not deployed rather than as an empty one.
//
// These live in this file rather than in `lib/constants.ts` because nothing
// outside this slice reads them yet. When a ceremony does run, moving them into
// constants.ts alongside the other deploy gates is the right migration — a
// second home for contract addresses is a way for two of them to disagree.

export type PooledLendingCollectionKey = 'JBAC' | 'NAKA' | 'GNSS';

export interface PooledLendingPool {
  key: PooledLendingCollectionKey;
  /** How the collection is named on the rest of the venue. */
  label: string;
  /** The ERC-721 this pool would lend against. These are live addresses. */
  collection: `0x${string}`;
  /**
   * The pool contract. Zero everywhere.
   *
   * One vault per collection is the isolation model, not a deployment
   * convenience: the contract's `collection` is immutable and no vault can
   * reach another's balance sheet.
   */
  vault: `0x${string}`;
}

const ZERO = '0x0000000000000000000000000000000000000000' as const;

// Collection addresses mirror the ones the P2P desk already whitelists in
// `components/nftfinance/NFTLendingSection.tsx`. They are here so a pool card
// can name the collection it WOULD serve; nothing calls them while `vault` is
// zero.
//
// TYPED AS A TUPLE, NOT AS `readonly PooledLendingPool[]`. `usePooledLendingVaults`
// reads slots 0, 1 and 2 by hand, because React forbids calling a hook in a loop
// over a list whose length could change. An array annotation makes every one of
// those three reads `PooledLendingPool | undefined` — the compiler is right, an
// array of unknown length has no guaranteed third element — and the hook would be
// reading `pool.vault` off nothing if the list ever shrank. `satisfies` keeps the
// shape checked while leaving the length known.
export const POOLED_LENDING_POOLS = [
  {
    key: 'JBAC',
    label: 'Jungle Bay Ape Club',
    collection: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9',
    vault: ZERO,
  },
  {
    key: 'NAKA',
    label: 'Nakamigos',
    collection: '0xd774557b647330C91Bf44cfEAB205095f7E6c367',
    vault: ZERO,
  },
  {
    key: 'GNSS',
    label: 'GNSS Art',
    collection: '0xa1De9f93c56C290C48849B1393b09eB616D55dbb',
    vault: ZERO,
  },
] as const satisfies readonly PooledLendingPool[];

/** The instalment desk. Also deployed nowhere. */
export const BNPL_DESK_ADDRESS = ZERO;

export function deployedPooledLendingPools(): readonly PooledLendingPool[] {
  return POOLED_LENDING_POOLS.filter((p) => isDeployed(p.vault));
}

export function isPooledLendingLive(): boolean {
  return deployedPooledLendingPools().length > 0;
}

export function isBnplLive(): boolean {
  return isDeployed(BNPL_DESK_ADDRESS);
}

/**
 * The vault terms the SOURCE sets, for a surface that must describe the product
 * before a deployment exists to ask.
 *
 * Mirrors the initialisers in contracts/src/nftfi/NftfiPooledLendingVault.sol.
 * Kept as a separate export rather than a fallback inside `usePooledLendingVault`
 * for the same reason `BNPL_WRITTEN_TERMS` is: a fallback folded into the hook
 * would let a dead read look like a live one. Anything drawn from here has to be
 * labelled as the written terms at the point it is drawn.
 */
export const POOLED_VAULT_WRITTEN_TERMS = {
  ltvBps: 3_000,
  aprBps: 1_500,
  loanDurationSeconds: 30 * 24 * 60 * 60,
  originationFeeBps: 0,
  interestFeeBps: 0,
} as const;

// ─── ABIs ────────────────────────────────────────────────────────────
//
// Hand-written and deliberately narrow: only the reads these surfaces render
// and the writes they offer. A wider ABI would let a future edit call something
// nobody reviewed on a money contract.

export const NFTFI_POOLED_VAULT_ABI = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'collection', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'principalOutstanding', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'seizedPrincipal', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'utilisationBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxPrincipal', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'depositCapWei', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ltvBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'aprBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'loanDuration', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'originationFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'interestFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'liquidationSink', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'floorStatus',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }, { type: 'bool' }, { type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxWithdraw',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const NFTFI_BNPL_ABI = [
  { type: 'function', name: 'collection', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'depositBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'saleFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'planCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'listingCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'INSTALMENTS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'INSTALMENT_INTERVAL', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'PAYMENT_GRACE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'view',
    inputs: [{ name: 'priceWei', type: 'uint256' }],
    outputs: [
      { name: 'depositWei', type: 'uint256' },
      { name: 'financedWei', type: 'uint256' },
      { name: 'originationWei', type: 'uint256' },
      { name: 'interestWei', type: 'uint256' },
      { name: 'totalWei', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'plans',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'priceWei', type: 'uint256' },
      { name: 'financedWei', type: 'uint256' },
      { name: 'principalPerInstalment', type: 'uint256' },
      { name: 'loanId', type: 'uint256' },
      { name: 'startedAt', type: 'uint64' },
      { name: 'instalmentsPaid', type: 'uint8' },
      { name: 'settled', type: 'bool' },
      { name: 'forfeited', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'scheduleStatus',
    stateMutability: 'view',
    inputs: [{ name: 'planId', type: 'uint256' }],
    outputs: [
      { name: 'nextDueAt', type: 'uint64' },
      { name: 'forfeitable', type: 'bool' },
    ],
  },
] as const;
