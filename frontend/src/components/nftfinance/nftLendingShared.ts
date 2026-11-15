// Shared look and helpers for the NFT lending tab (NFTLendingSection.tsx, NFTLendingLoans.tsx).
import { formatEther, parseEther, type Address } from 'viem';
import { ART } from '../../lib/artConfig';
import { GONDI_LOAN_ADDRESS, LENDING_COLLECTIONS, ZERO_ADDRESS, sameAddress } from '../../lib/gondi/loanOffer.js';

/** Gondi's loan contract is deployed and the site points at it. */
export const LENDING_LIVE = !sameAddress(GONDI_LOAN_ADDRESS, ZERO_ADDRESS);

// Per-collection art for the collateral selector: each project's own asset, so the cards
// show the actual collection. Paths match frontend/src/nakamigos/constants.js.
export const COLLECTION_ART: Record<string, string> = {
  JBAC: ART.jbacSkeleton.src,
  NAKA: '/splash/skeleton.jpg',
  GNSS: '/collections/gnssart.jpg',
};

export const COLLECTIONS = LENDING_COLLECTIONS as readonly { name: string; symbol: string; address: Address }[];

// 0.80 so labels and stat cards stay legible over the animated art behind this section;
// the 18% white border gives cards a clear edge against it.
export const CARD_BG = 'rgba(6, 12, 26, 0.80)';
export const CARD_BORDER = 'rgba(255, 255, 255, 0.18)';
export const LABEL_STYLE: React.CSSProperties = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' };
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
// Solid backing for a selected choice: the art bled through the old translucent tint and
// washed out the label.
export const SELECTED_BG = 'rgba(6, 40, 30, 0.92)';
// The money buttons (Wrap/Approve/Sign Offer, Take Loan, Repay) use the site's solid green
// .btn-primary, and fade only while they can't be pressed. Inline, because .btn-primary is
// unlayered CSS and its own 0.70 disabled opacity beats Tailwind's disabled:opacity-40.
export const FADED: React.CSSProperties = { opacity: 0.4 };

export const WETH_DEPOSIT_ABI = [
  { type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' },
] as const;

export function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr || '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 365) return `${Math.floor(days / 365)}y`;
  return `${days}d`;
}

export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}

export function fmtWeth(wei: bigint, digits = 4): string {
  return parseFloat(formatEther(wei)).toFixed(digits);
}

/** A typed amount as wei, or null when it is not a positive number. */
export function parseAmount(value: string): bigint | null {
  if (!value || !/^\d*\.?\d*$/.test(value.trim())) return null;
  try {
    const wei = parseEther(value.trim());
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

/** The highest rate the Lend form signs: 1000% a year. A lender used to basis points who
 *  types "1400" for 14% is stopped here instead of signing a 1400% offer nobody takes. */
export const MAX_APR_BPS = 100_000n;

/** A typed yearly rate in percent ("14", "12.5", "9.75") as basis points, or null when it
 *  is not a positive number of at most two decimals within MAX_APR_BPS. */
export function parseAprPercent(value: string): bigint | null {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const bps = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return bps > 0n && bps <= MAX_APR_BPS ? bps : null;
}

/** A due moment (seconds since 1970) in the reader's own time zone: "Dec 10, 2026, 3:14 PM". */
export function formatDue(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A typed token id, or null when it is not a whole number. */
export function parseTokenId(value: string): bigint | null {
  const v = value.trim();
  if (!/^\d{1,78}$/.test(v)) return null;
  return BigInt(v);
}

export function collectionSymbol(addr: string): string {
  const c = COLLECTIONS.find((x) => x.address.toLowerCase() === addr.toLowerCase());
  return c ? c.symbol : shortenAddress(addr);
}

/** A fresh offer id. Gondi tracks use and cancellation per (lender, offer id), so it must
 *  not repeat for a lender: seconds since 1970 in the high bits, 20 random bits below. */
export function newOfferId(): bigint {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return (BigInt(Math.floor(Date.now() / 1000)) << 20n) | BigInt(random[0]! & 0xfffff);
}

export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/** Loan lengths the Lend form and the ask form offer. */
export const DURATION_PRESETS = [
  { label: '7d', seconds: 7 * 86400 },
  { label: '14d', seconds: 14 * 86400 },
  { label: '30d', seconds: 30 * 86400 },
  { label: '90d', seconds: 90 * 86400 },
  { label: '180d', seconds: 180 * 86400 },
  { label: '365d', seconds: 365 * 86400 },
];
