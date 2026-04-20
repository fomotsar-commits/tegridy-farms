import { m } from 'framer-motion';
import { useAccount, useChainId, useChains, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '../../lib/constants';
import { ArtImg } from '../ArtImg';

/**
 * Phase 2 primitive — collapses three inlined copies (AdminPage
 * fail-closed screen, CommunityPage banner, FarmPage banner) into a
 * single import. Two variants are exposed:
 *
 *  - `<WrongChainBanner>` — soft inline banner with a Switch button.
 *    Renders null unless the wallet is connected AND on a non-canonical
 *    chain. Drop it at the top of pages that still function for reads
 *    on the wrong chain; `isWrongNetwork` useNetworkCheck and friends
 *    can be removed in favor of this.
 *
 *  - `<WrongChainScreen>` — full-page fail-closed panel. Use this from
 *    inside a page's early-return chain when wrong chain is high-risk
 *    enough that you want to block the UI entirely (Admin is the only
 *    current caller). Does its own full-bleed art to match the parent
 *    page's aesthetic.
 *
 * Both consult wagmi's `useChainId` + `useAccount` + `useSwitchChain`;
 * no shared state.
 */

const DEFAULT_CHAIN_ID = CHAIN_ID;

function useChainState(requiredChainId: number) {
  const walletChainId = useChainId();
  const { isConnected } = useAccount();
  const chains = useChains();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const canonicalName = chains.find((c) => c.id === requiredChainId)?.name ?? 'Ethereum Mainnet';
  // wagmi returns the configured default when disconnected, so gate on
  // isConnected explicitly rather than trusting a mismatch.
  const isWrong = isConnected && walletChainId !== requiredChainId;
  const switchToRequired = () => switchChain({ chainId: requiredChainId });
  return { canonicalName, isWrong, isSwitching, switchToRequired };
}

// ────────────────────────────────────────────────────────────
// Soft banner
// ────────────────────────────────────────────────────────────

type WrongChainBannerProps = {
  /** Override the required chain; defaults to CHAIN_ID. */
  requiredChainId?: number;
  /** One-liner shown under the heading. Sensible default provided. */
  message?: string;
  /** Merged into the banner root className. */
  className?: string;
};

export function WrongChainBanner({
  requiredChainId = DEFAULT_CHAIN_ID,
  message,
  className,
}: WrongChainBannerProps) {
  const { canonicalName, isWrong, isSwitching, switchToRequired } =
    useChainState(requiredChainId);

  if (!isWrong) return null;

  const resolvedMessage =
    message ??
    `This page talks to contracts on ${canonicalName}. Your wallet is on a different network — writes will revert until you switch.`;

  return (
    <m.div
      role="alert"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap ${className ?? ''}`}
      style={{ background: 'rgba(245, 158, 11, 0.10)', border: '1px solid rgba(245, 158, 11, 0.35)' }}
    >
      <div className="min-w-0">
        <p
          className="text-amber-300 text-[13px] font-semibold"
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}
        >
          Wrong network
        </p>
        <p className="text-white/75 text-[12px]" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
          {resolvedMessage}
        </p>
      </div>
      <button
        onClick={switchToRequired}
        disabled={isSwitching}
        className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-white text-black hover:bg-white/90 transition-colors disabled:opacity-60 whitespace-nowrap"
      >
        {isSwitching ? 'Switching…' : `Switch to ${canonicalName}`}
      </button>
    </m.div>
  );
}

// ────────────────────────────────────────────────────────────
// Fail-closed full-page screen
// ────────────────────────────────────────────────────────────

type WrongChainScreenProps = {
  /** Override the required chain; defaults to CHAIN_ID. */
  requiredChainId?: number;
  /** Heading inside the card. Defaults to "Wrong Network". */
  title?: string;
  /** Sub-copy. Sensible default provided. */
  message?: string;
  /** pageId for the full-bleed background art. */
  pageId?: string;
  /** Art index for the pageId. */
  artIdx?: number;
};

export function WrongChainScreen({
  requiredChainId = DEFAULT_CHAIN_ID,
  title = 'Wrong Network',
  message,
  pageId = 'admin',
  artIdx = 0,
}: WrongChainScreenProps) {
  const { canonicalName, isSwitching, switchToRequired } = useChainState(requiredChainId);

  const resolvedMessage =
    message ??
    `This page is only available on ${canonicalName}. Your wallet is on a different network.`;

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId={pageId} idx={artIdx} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
        <div className="glass-card p-8 rounded-2xl text-center max-w-md">
          <h1 className="heading-luxury text-2xl text-white mb-3">{title}</h1>
          <p className="text-white/85 text-sm mb-5">{resolvedMessage}</p>
          <button
            onClick={switchToRequired}
            disabled={isSwitching}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-white text-black hover:bg-white/90 transition-all disabled:opacity-60"
          >
            {isSwitching ? 'Switching…' : `Switch to ${canonicalName}`}
          </button>
        </div>
      </div>
    </div>
  );
}
