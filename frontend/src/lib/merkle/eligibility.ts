import type { Address, Hex } from 'viem';
import { findRow, type CampaignManifest, type CampaignRow } from './campaign';
import { verifyMerkleProof } from './core.js';

/**
 * Why a wallet can or cannot claim — and, when the answer is unknown, the fact that it
 * is unknown.
 *
 * The failure this exists to prevent: a page that cannot reach the chain, or that was
 * handed no claim list, rendering "you are not eligible". That reads as a statement
 * about the wallet when it is a statement about the page. Every input below is
 * nullable, and every null resolves to `unknown` with the missing piece named, never
 * to a negative verdict.
 */

export type EligibilityStatus =
  /** Proof checks out locally, the window is open, the slot is unclaimed. */
  | 'eligible'
  /** No wallet connected — nothing has been checked yet. */
  | 'no-wallet'
  /** The list was read and this wallet is not in it. The only honest negative. */
  | 'not-listed'
  /** On-chain claimed bit is set for this wallet's index. */
  | 'already-claimed'
  /** `block.timestamp >= expiresAt`; only `reclaim` remains. */
  | 'window-closed'
  /** The row exists but its proof does not reproduce the campaign's root. */
  | 'proof-invalid'
  /** The manifest's root is not the root this distributor is paying against. */
  | 'root-mismatch'
  /** Something needed to answer was unavailable. Never a verdict about the wallet. */
  | 'unknown';

export interface OnChainCampaign {
  merkleRoot: Hex;
  claimsOpen: boolean;
  expiresAt: number;
  claimFeeWei: bigint;
}

export interface EligibilityInput {
  /** The claim list. `null` means none was loaded — not that the wallet is absent. */
  manifest: CampaignManifest | null;
  /** Connected wallet, or `null`. */
  account: Address | null;
  /** Campaign state read from the distributor, or `null` when the read failed. */
  onChain: OnChainCampaign | null;
  /** `isClaimed(index)`, or `null` when that read failed or has not run. */
  claimed: boolean | null;
}

export interface EligibilityResult {
  status: EligibilityStatus;
  /** One-line verdict for a heading. */
  title: string;
  /** The reason, naming what was checked or what was missing. */
  detail: string;
  /** True only for `eligible`. Every other status, including `unknown`, is false. */
  canClaim: boolean;
  /** The matched row, when there is one. */
  row: CampaignRow | null;
}

function result(
  status: EligibilityStatus,
  title: string,
  detail: string,
  row: CampaignRow | null = null,
): EligibilityResult {
  return { status, title, detail, canClaim: status === 'eligible', row };
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { manifest, account, onChain, claimed } = input;

  if (!account) {
    return result(
      'no-wallet',
      'Wallet not connected',
      'Connect a wallet to check it against the claim list. Nothing has been checked yet.',
    );
  }

  if (!manifest) {
    return result(
      'unknown',
      'No data',
      'No claim list is loaded, so this page cannot tell whether this wallet is eligible. The chain ' +
        'stores only the campaign root — the list itself is published by whoever created the campaign.',
    );
  }

  // Root mismatch is checked before the row lookup on purpose. A wallet present in the
  // wrong list is not eligible for THIS campaign, and reporting it as eligible would
  // send it into a claim that can only revert.
  if (onChain && manifest.root.toLowerCase() !== onChain.merkleRoot.toLowerCase()) {
    return result(
      'root-mismatch',
      'This list is not this campaign',
      `The loaded list has root ${manifest.root}, but the distributor is paying against ` +
        `${onChain.merkleRoot}. One of them belongs to a different campaign.`,
    );
  }

  const row = findRow(manifest, account);
  if (!row) {
    const criteria = manifest.criteria?.trim();
    // The campaign's real size, never `rows.length`, which for a store-sourced manifest
    // is the number of rows THIS PAGE asked for (at most one). Reporting that as the
    // list size would tell a wallet it is missing from a list of one address.
    const size = manifest.recipientCount ?? manifest.rows.length;
    // A `partial` manifest means the hosted store did the looking and reported this
    // account absent. Saying so is the difference between a verdict this page can
    // stand behind and one it is repeating. Either way it is reached only because a
    // list WAS read — a store that failed produces `manifest: null` above, not this.
    const who = manifest.partial
      ? `${account} is not among the ${size} addresses in the campaign's stored list.`
      : `${account} does not appear in the loaded list of ${size} addresses.`;
    return result(
      'not-listed',
      'Not in this campaign',
      `${who} ` +
        (criteria
          ? `The list was selected as: ${criteria}`
          : 'The campaign creator did not publish the selection criteria with this list.'),
    );
  }

  if (!verifyMerkleProof(row.proof, manifest.root, row.leaf)) {
    return result(
      'proof-invalid',
      'Proof does not match the list',
      'This wallet has a row, but its proof does not reproduce the list root — the manifest is ' +
        'damaged. The distributor would reject this claim. Ask the campaign creator to republish.',
      row,
    );
  }

  if (!onChain) {
    return result(
      'unknown',
      'Campaign state unavailable',
      `${account} is in the loaded list, but the campaign contract could not be read, so whether ` +
        'the claim window is open and whether this allocation was already claimed are both unknown.',
      row,
    );
  }

  if (!onChain.claimsOpen) {
    return result(
      'window-closed',
      'Claim window closed',
      `Claims closed at ${new Date(onChain.expiresAt * 1000).toUTCString()}. Whatever was unclaimed ` +
        'can be taken back by the campaign creator; the distributor accepts no further claims.',
      row,
    );
  }

  if (claimed === null) {
    return result(
      'unknown',
      'Claim status unavailable',
      `${account} is in the list and the window is open, but the claimed-bitmap read for index ` +
        `${row.index} did not return, so this page cannot say whether the allocation is still there.`,
      row,
    );
  }

  if (claimed) {
    return result(
      'already-claimed',
      'Already claimed',
      `Index ${row.index} is marked claimed on-chain. The tokens were sent to ${row.account} — the ` +
        'distributor pays the address in the leaf, so a claim by a third party still lands there.',
      row,
    );
  }

  return result('eligible', 'Eligible', `Proof verified locally against root ${manifest.root}.`, row);
}
