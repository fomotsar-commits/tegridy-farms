import { m } from 'framer-motion';
import { ArtImg } from '../ArtImg';

interface FeatureNotDeployedProps {
  /** Main line, e.g. "NFT lending isn't live yet". */
  title: string;
  /** Optional secondary line explaining when it returns. */
  subtitle?: string;
  /** Page-art id for the backdrop (degrades gracefully if missing). */
  pageId: string;
  idx?: number;
}

/**
 * Shared "contract not deployed" placeholder. Rendered in place of a feature
 * whose on-chain contract isn't part of the current deployment — i.e. its
 * address is the zero address in constants.ts (see isDeployed()).
 *
 * Mirrors the inline placeholders already used by GaugeVoting,
 * LPFarmingSection, and LaunchpadSection so every deferred surface reads as a
 * deliberate "coming soon" rather than rendering live, transaction-firing UI
 * against an undeployed address.
 */
export function FeatureNotDeployed({ title, subtitle, pageId, idx = 0 }: FeatureNotDeployedProps) {
  return (
    <m.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="rounded-2xl p-8 sm:p-10 text-center relative overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,0.12)' }}
    >
      <div className="absolute inset-0">
        <ArtImg pageId={pageId} idx={idx} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.66)' }} />
      </div>
      <div className="relative z-10">
        <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 mb-3">
          SOON
        </span>
        <p className="text-white/90 text-sm" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{title}</p>
        {subtitle && (
          <p className="text-white/65 text-[12px] mt-1.5 max-w-md mx-auto leading-relaxed" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            {subtitle}
          </p>
        )}
      </div>
    </m.div>
  );
}
