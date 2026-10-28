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
