/* ─── Shared design tokens & constants for Launchpad components ─── */

export const GLASS =
  'bg-gradient-to-br from-[rgba(13,21,48,0.6)] to-[rgba(6,12,26,0.8)] backdrop-blur-[20px] border border-white/20';
export const INPUT =
  'w-full bg-transparent border-b border-white/10 px-1 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors placeholder:text-white';
export const LABEL = 'text-[11px] uppercase tracking-wider label-pill text-white mb-1.5 block';
export const BTN_EMERALD =
  'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-70 disabled:pointer-events-none';

// R071 H-072-01: 5-entry array maps 1:1 to TegridyDropV2.sol enum MintPhase
// `{CLOSED, ALLOWLIST, PUBLIC, DUTCH_AUCTION, CANCELLED}`. Prior 3-entry list
// silently dropped DUTCH_AUCTION (admins couldn't pick it from the grid) and
// mislabeled CLOSED as "Paused" (paused() is a separate boolean reentrancy
// guard, not the mint phase). CANCELLED is reachable only via cancelSale()
// — `setMintPhase(CANCELLED)` reverts on-chain — so the admin grid uses
// PHASE_LABELS.slice(0, 4) and CANCELLED lives in the Danger Zone.
export const PHASE_LABELS = ['Closed', 'Allowlist', 'Public', 'Dutch Auction', 'Cancelled'] as const;
// South Park character palette: Kyle green, Stan blue, Cartman red,
// Kenny orange, Cartman yellow, Chef purple. One per bullet.
export const FEATURE_BULLETS = [
  { label: 'ERC-721 Collections', icon: '\u25C8', color: '#2eb62c' }, // Kyle green
  { label: 'Merkle Allowlists', icon: '\u25CE', color: '#4a90e2' },   // Stan blue
  { label: 'Dutch Auctions', icon: '\u25C7', color: '#e74c3c' },      // Cartman red
  { label: 'Delayed Reveals', icon: '\u25C9', color: '#e67e22' },     // Kenny orange
  { label: 'ERC-2981 Royalties', icon: '\u25C6', color: '#f1c40f' },  // Cartman yellow
  { label: 'Revenue Splits', icon: '\u25D0', color: '#9b59b6' },      // Chef purple
];

export const fadeUp = { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35 } };
export const fadeUpVariants = { hidden: { opacity: 0, y: 14 }, visible: { opacity: 1, y: 0, transition: { duration: 0.35 } } };
export const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
