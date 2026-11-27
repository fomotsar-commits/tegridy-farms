import { SITE_URL } from './constants';

/**
 * The read link a post carries. X keeps the card it drew for a link and draws again only for a link
 * it has not seen, so the link carries the heat the card paints (h, to the hundredth): a new number is
 * a new link. With no reading in hand, the UTC day it was posted (d). The page reads nothing from either.
 */
export function readLink(address: string, degrees?: number | null, now: number = Date.now()): string {
  if (typeof degrees === 'number' && Number.isFinite(degrees) && degrees >= 0) {
    return `${SITE_URL}/read/${address}?h=${degrees.toFixed(2)}`;
  }
  return `${SITE_URL}/read/${address}?d=${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}`;
}
