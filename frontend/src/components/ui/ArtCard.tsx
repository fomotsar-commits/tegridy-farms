import type { ReactNode } from 'react';
import { ArtImg } from '../ArtImg';

/**
 * Shared art-backed card.
 *
 * WHY: the protocol's identity is art-first ("Art-first yield farming on
 * Ethereum" — Footer), and the established pages (Security, Dashboard,
 * Tokenomics, Lending) put a full-bleed art piece behind every card. Several
 * newer surfaces — the launcher pages in particular — shipped as bare dark
 * boxes, so they read as a different, colder app. This is the same treatment,
 * factored once instead of hand-rolled per page.
 *
 * Art is resolved through `ArtImg`, so /art-studio overrides, focal
 * `objectPosition`, `scale`, CLS-reserving width/height and the broken-image
 * fallback all come for free — this component adds no new art logic.
 *
 * CONTRAST: content sits on an opaque dark panel above the image (same values
 * as SecurityPage's card), so adding art never costs text legibility.
 */
export function ArtCard({
  pageId,
  idx,
  children,
  className = '',
  padding = 'p-5 md:p-6',
  fallbackPosition,
}: {
  pageId: string;
  idx: number;
  children: ReactNode;
  className?: string;
  padding?: string;
  fallbackPosition?: string;
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
          background: 'rgba(0,0,0,0.85)',
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
