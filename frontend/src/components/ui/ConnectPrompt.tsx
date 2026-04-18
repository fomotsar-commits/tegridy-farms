/**
 * ConnectPrompt — wallet-gate empty state for transactional pages.
 *
 * Why this exists:
 *   Before this component, Farm/Trade/Lending rendered their full interactive
 *   UI even when no wallet was connected. Users saw broken-looking token
 *   inputs, modals, and charts and assumed the site was broken.
 *
 * Usage:
 *   const { isConnected } = useAccount();
 *   if (!isConnected) return <ConnectPrompt surface="farm" />;
 */
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';

type Surface = 'farm' | 'trade' | 'lending' | 'governance' | 'generic';

interface ConnectPromptProps {
  surface?: Surface;
  title?: string;
  description?: string;
}

const DEFAULTS: Record<Surface, { title: string; description: string; cta: string }> = {
  farm: {
    title: 'Connect to farm with tegridy',
    description:
      'Lock TOWELI for up to 4 years, earn 100% of protocol swap fees, and boost your LP rewards. Your staking position is an ERC-721 NFT — portable, collateralizable, yours.',
    cta: 'Start Farming',
  },
  trade: {
    title: 'Connect to swap on the native DEX',
    description:
      'Every basis point of fees routes to stakers. Trade here to support the yield flywheel — or use Uniswap if you want Uniswap to keep the fees instead.',
    cta: 'Swap TOWELI',
  },
  lending: {
    title: 'Connect to borrow or lend',
    description:
      'Supply TOWELI for yield, borrow against your staking NFT, or use JBAC / JBAY Gold NFTs as collateral. 1-hour grace period, no liquidation auctions — peer-to-peer.',
    cta: 'Open Lending',
  },
  governance: {
    title: 'Connect to vote with tegridy',
    description:
      'Stakers direct where LP farming emissions flow. Your locked TOWELI is your voting power. Bribers pay you to vote their way — totally not bribes, just donations.',
    cta: 'Open Governance',
  },
  generic: {
    title: 'Connect your wallet',
    description:
      'This surface requires a connected wallet. Your wallet address is used to read your on-chain positions and submit transactions. No sign-up, no password, no email.',
    cta: 'Connect Wallet',
  },
};

export function ConnectPrompt({ surface = 'generic', title, description }: ConnectPromptProps) {
  const defaults = DEFAULTS[surface];
  const finalTitle = title ?? defaults.title;
  const finalDescription = description ?? defaults.description;

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="max-w-[560px] mx-auto px-4 py-16 md:py-20 text-center"
      role="region"
      aria-label="Wallet connection required"
    >
      <div
        className="mx-auto mb-6 flex items-center justify-center rounded-full"
        style={{
          width: 64,
          height: 64,
          background: 'rgba(139, 92, 246, 0.12)',
          border: '1px solid rgba(245, 228, 184, 0.25)',
        }}
        aria-hidden="true"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f5e4b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 8H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2z" />
          <path d="M16 14h2" />
          <path d="M3 10V6a2 2 0 0 1 2-2h12v4" />
        </svg>
      </div>

      <h2 className="text-2xl md:text-3xl font-bold text-white mb-3 tracking-tight">
        {finalTitle}
      </h2>

      <p className="text-white/70 text-sm md:text-base leading-relaxed mb-8">
        {finalDescription}
      </p>

      <div className="flex flex-col sm:flex-row gap-3 items-center justify-center">
        <ConnectButton.Custom>
          {({ openConnectModal, mounted }) => (
            <button
              onClick={openConnectModal}
              disabled={!mounted}
              className="btn-primary px-7 py-2.5 text-[14px]"
              aria-label="Open wallet connection modal"
            >
              Connect Wallet
            </button>
          )}
        </ConnectButton.Custom>

        <Link
          to="/faq"
          className="px-5 py-2.5 text-[13px] text-white/70 hover:text-white transition-colors underline-offset-4 hover:underline"
        >
          New to DeFi? Read the FAQ
        </Link>
      </div>

      <p className="text-white/40 text-[11px] mt-10 max-w-[420px] mx-auto">
        By connecting, you confirm you've read the{' '}
        <Link to="/security" className="underline hover:text-white/70">security disclosures</Link>
        {' '}and understand DeFi risk. Not financial advice.
      </p>
    </m.div>
  );
}

export default ConnectPrompt;
