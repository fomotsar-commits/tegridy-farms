/**
 * Icon — unified inline-SVG primitive with locked stroke-width and size.
 *
 * Created as part of the Spartan Battle Plan (Agent 5) to eliminate icon-
 * inconsistency drift across the app (stroke-widths previously varied 1.5–1.8).
 *
 * This is a greenfield primitive — it is NOT a wholesale replacement. Existing
 * icons across TopNav/BottomNav/pages are untouched. Adopt this progressively
 * in future changes.
 *
 * Defaults:
 *   size = 20 (px)
 *   strokeWidth = 1.5
 *   aria-hidden = true (decorative by default; pass aria-label to override)
 */
import type { ReactElement, SVGProps } from 'react';

export type IconName =
  | 'dashboard'
  | 'farm'
  | 'trade'
  | 'lending'
  | 'governance'
  | 'community'
  | 'security'
  | 'menu'
  | 'close'
  | 'chevron-down'
  | 'external-link'
  | 'shield'
  | 'check'
  | 'alert';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

// Inline SVG paths (Lucide-style, 24-unit grid).
const PATHS: Record<IconName, ReactElement> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  farm: (
    <>
      <path d="M3 21V11l9-6 9 6v10" />
      <path d="M9 21V14h6v7" />
    </>
  ),
  trade: (
    <>
      <path d="M7 10l-4 4 4 4" />
      <path d="M3 14h14" />
      <path d="M17 4l4 4-4 4" />
      <path d="M21 8H7" />
    </>
  ),
  lending: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M15 9.5A2.5 2.5 0 0 0 12.5 7h-1A2.5 2.5 0 0 0 9 9.5a2.5 2.5 0 0 0 2.5 2.5h1a2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 1-2.5 2.5h-1A2.5 2.5 0 0 1 9 14.5" />
    </>
  ),
  governance: (
    <>
      <path d="M5 21h14" />
      <path d="M6 10l6-6 6 6" />
      <path d="M6 10v11" />
      <path d="M18 10v11" />
      <path d="M9 14l3 3 3-3" />
    </>
  ),
  community: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="10" cy="7" r="4" />
      <path d="M21 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M17 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  security: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  'chevron-down': <polyline points="6 9 12 15 18 9" />,
  'external-link': (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </>
  ),
  shield: (
    <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16.5" x2="12" y2="16.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.5,
  className,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
  ...rest
}: IconProps) {
  const isDecorative = !ariaLabel;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={isDecorative ? (ariaHidden ?? true) : undefined}
      aria-label={ariaLabel}
      role={isDecorative ? undefined : 'img'}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

export default Icon;
