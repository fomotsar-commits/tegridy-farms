import { useState } from 'react';
import { RECEIPT_WORDS } from '../../lib/arrival';
import { isSupportedHeatAddress } from '../../lib/heat/heatClient';
import { tick } from '../../lib/tick';

/**
 * The island's picture of a wallet's card: the image its card page names for X (og:image,
 * read 2026-11-03), 1200 by 630, carrying the degrees, the tier, the since line and the
 * island's art. The island draws it; the venue only hangs it.
 */
const islandCardImage = (wallet: string): string => `https://memetics.wtf/api/card?w=${encodeURIComponent(wallet)}`;

/**
 * THE FLEX (island answer twenty-four, build 7): under a warm read, the venue hands over the
 * island's card for the wallet, the object that travels on X. The picture and the press both
 * open the card's page on the island, as the receipt's Share does. A picture that does not load
 * leaves the press, never a broken image.
 */
export function IslandCard({ wallet, className = 'mb-4' }: { wallet: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!isSupportedHeatAddress(wallet)) return null;
  return (
    <a
      href={RECEIPT_WORDS.cardUrl(wallet)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={tick}
      data-testid="island-card"
      className={`block max-w-[480px] rounded-xl overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] ${className}`}
      style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}
    >
      {!broken && (
        <img
          src={islandCardImage(wallet)}
          alt=""
          width={1200}
          height={630}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          className="block w-full h-auto"
        />
      )}
      <span className="flex min-h-[44px] items-center justify-center px-4 text-[13px] font-semibold" style={{ color: 'var(--color-kyle)' }}>
        {RECEIPT_WORDS.share}
        <span aria-hidden="true" className="ml-1">↗</span>
      </span>
    </a>
  );
}
