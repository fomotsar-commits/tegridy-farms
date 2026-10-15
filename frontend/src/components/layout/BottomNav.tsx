import { Link, useLocation } from 'react-router-dom';
import React from 'react';
import { BAR_NAV } from '../../lib/navConfig';
import { useActiveBungalowId } from '../../hooks/useActiveBungalowId';

const ICON = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

/** One icon per bar word; a NavItem carries none. */
const ICONS: Record<string, React.ReactNode> = {
  Heat: (
    <svg {...ICON}>
      <path d="M12 3c.6 3.4 4.5 5.6 4.5 10.2a4.5 4.5 0 0 1-9 0c0-2.1.9-3.6 2.2-4.8.2 1.5.9 2.5 2.1 3C11.4 9 11.1 6 12 3z" />
    </svg>
  ),
  Rooms: (
    <svg {...ICON}>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-6h4v6" />
    </svg>
  ),
  Lock: (
    <svg {...ICON}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  Launch: (
    <svg {...ICON}>
      <path d="M12 3c3 2.4 4.5 5.8 4.5 9.8L14.6 16H9.4l-1.9-3.2C7.5 8.8 9 5.4 12 3z" />
      <circle cx="12" cy="9.5" r="1.5" />
      <path d="M9.4 16L7 20l3.2-1.2M14.6 16L17 20l-3.2-1.2" />
    </svg>
  ),
  Swap: (
    <svg {...ICON}>
      <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />
    </svg>
  ),
};

/**
 * The phone bar: the same five words as the top bar (navConfig BAR_NAV). Five is the ceiling,
 * a 44px target and a 10px label at 390px, so Dashboard is a drawer row. A word is lit on every
 * page it owns, never by its own URL alone: Heat and Rooms both open the home.
 */
export const BottomNav = React.memo(function BottomNav() {
  // Swap's target follows the room, so a door must re-render this memoized bar.
  useActiveBungalowId();
  const { pathname, hash } = useLocation();
  return (
    // Hides at >=800px, where TopNav's words appear; AppLayout's pb and index.css's
    // safe-area-content-bottom end at 799px to match. The inset keeps it above iOS's home bar.
    <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 min-[800px]:hidden"
      style={{
        background: 'rgba(6,12,26,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-purple-75)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
      {/* No bottom inset on this row: the nav pads by it, and padding both left a large inset
          (an Android in-app browser) no room for the icons. */}
      <div className="flex items-center justify-around h-16">
        {BAR_NAV.map((word) => {
          const lit = word.lit(pathname, hash);
          return (
            <Link key={word.label} to={word.to} aria-label={word.label}
              aria-current={lit ? 'page' : undefined}
              data-lit={lit}
              // min-w-0 lets the label truncate; the 44px floor comes from flex-1 and min-h.
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 min-h-[48px] px-1 py-2 transition-colors ${
                lit ? 'text-purple-400' : 'text-white/60'
              }`}>
              {ICONS[word.label]}
              <span className="text-[10px] font-medium leading-tight truncate max-w-full">{word.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
});
