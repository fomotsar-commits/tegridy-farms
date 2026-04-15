/* ─── Shared design tokens & constants for Launchpad components ─── */

export const GLASS =
  'bg-gradient-to-br from-[rgba(13,21,48,0.6)] to-[rgba(6,12,26,0.8)] backdrop-blur-[20px] border border-white/20';
export const INPUT =
  'w-full bg-transparent border-b border-white/10 px-1 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors placeholder:text-white';
export const LABEL = 'text-[11px] uppercase tracking-wider label-pill text-white mb-1.5 block';
export const BTN_EMERALD =
  'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-70 disabled:pointer-events-none';

export const PHASE_LABELS = ['Paused', 'Allowlist', 'Public'] as const;
export const FEATURE_BULLETS = [
  { label: 'ERC-721 Collections', icon: '\u25C8' },
  { label: 'Merkle Allowlists', icon: '\u25CE' },
  { label: 'Dutch Auctions', icon: '\u25C7' },
  { label: 'Delayed Reveals', icon: '\u25C9' },
  { label: 'ERC-2981 Royalties', icon: '\u25C6' },
  { label: 'Revenue Splits', icon: '\u25D0' },
];

export const fadeUp = { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35 } };
export const fadeUpVariants = { hidden: { opacity: 0, y: 14 }, visible: { opacity: 1, y: 0, transition: { duration: 0.35 } } };
export const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
