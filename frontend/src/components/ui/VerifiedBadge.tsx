import { getAddressUrl } from '../../lib/explorer';
import type { VerificationState } from '../../hooks/useSourceVerification';

/**
 * Etherscan source-verification status for one address.
 *
 * `unchecked` is NOT a synonym for `unverified`. A rate-limited, aborted or
 * failed /api/etherscan call must never render "source unverified" against one
 * of our own live contracts — that is a claim we cannot back, and it would
 * defame our own deployment. It must equally never render an optimistic
 * "source verified". Both non-answers collapse to a muted placeholder that
 * asserts nothing in either direction.
 *
 * Callers own the deploy gate: do NOT render this for a zero-address /
 * not-yet-deployed contract. Those keep the existing "pending deploy" pill and
 * are never queried.
 */
interface VerifiedBadgeProps {
  /** Required, no default — a caller cannot fall into an optimistic render. */
  state: VerificationState;
  /** Address, used only to build the Etherscan #code link. */
  address: string;
  /** Human label for the aria-label, e.g. "Gauge Controller". */
  label: string;
  /** ContractsPage is pinned to Ethereum mainnet; override for other chains. */
  chainId?: number;
}

/**
 * Shared geometry matching the existing "pending deploy" / "deprecated" /
 * "redeploy queued" / "awaiting multisig" pills on ContractsPage, so this reads
 * as one more member of that family rather than a new visual language.
 */
const PILL = 'text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border';

export function VerifiedBadge({ state, address, label, chainId = 1 }: VerifiedBadgeProps) {
  if (state === 'verified') {
    // #code lands on Etherscan's Contract Source tab — the whole point of the badge
    // is that a skeptic can click through and read the source themselves.
    return (
      <a
        href={`${getAddressUrl(chainId, address)}#code`}
        target="_blank"
        rel="noopener noreferrer"
        className={`${PILL} border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors inline-flex items-center`}
        title="Source code verified on Etherscan — opens the Contract Source tab"
        aria-label={`${label}: source code verified on Etherscan. Open the verified source (opens in new tab)`}
      >
        source verified{' '}
        <span aria-hidden="true" className="text-emerald-300/50 ml-1">&#8599;</span>
      </a>
    );
  }

  if (state === 'unverified') {
    // Neutral, not amber: amber already means "pending deploy" one pill to the left.
    // The honesty lives in the word, not the hue — which is also the accessible
    // framing, since the badge must never be colour-only.
    return (
      <span
        className={`${PILL} border-white/20 bg-white/5 text-white/60`}
        title="Etherscan has no published source for this address"
      >
        source unverified
      </span>
    );
  }

  // 'unchecked' — still loading, rate-limited, or the request failed. We do not
  // know, so we assert nothing. Mirrors the muted em dash ContractsPage already
  // renders when a cell has nothing honest to show.
  return (
    <span
      className="text-[11px] text-white/30 inline-flex items-center px-1.5"
      title="Source verification not checked (still loading, or Etherscan was unreachable)"
    >
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{`${label}: source verification status not checked`}</span>
    </span>
  );
}
