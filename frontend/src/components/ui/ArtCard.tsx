import type { ReactNode } from 'react';
import { ArtImg } from '../ArtImg';

/**
 * An art-backed card: a full-bleed piece through ArtImg (studio overrides, focal point, the
 * broken-image fallback) under a dark panel that holds the content. `scrim` is the panel's
 * black opacity: 0.85 by default, SecurityPage's value, so text costs nothing; the LP cards
 * pass LP_SCRIM (0.78, the owner's rule) so their art shows through.
 */
export function ArtCard({
  pageId,
  idx,
  children,
  className = '',
  padding = 'p-5 md:p-6',
  fallbackPosition,
  scrim = 0.85,
}: {
  pageId: string;
  idx: number;
  children: ReactNode;
  className?: string;
  padding?: string;
  fallbackPosition?: string;
  scrim?: number;
}) {
  return (
    <div
      className={`rounded-2xl relative overflow-hidden ${className}`}
      style={{ border: '1px solid var(--color-purple-12)' }}
    >
      <div className="absolute inset-0" aria-hidden="true">
        <ArtImg
          pageId={pageId}
          idx={idx}
          fallbackPosition={fallbackPosition}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
        />
      </div>
      <div
        className={`relative z-10 m-2 md:m-3 rounded-lg ${padding}`}
        style={{
          background: `rgba(0,0,0,${scrim})`,
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
