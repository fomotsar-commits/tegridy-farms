// The editorial look (owner, 2026-10-17: "we need an avantegarde app"): near-black, cream, and the
// venue's green for "here"; heavy heading type, index numbers, hairlines, mono captions, hard
// corners, film grain. First built for the menu (NavDrawer.tsx), now the dashboard's too
// (IslandDashboard.tsx), so the two read as one system. The same in both themes.
export const EDITORIAL_BG = '#05080f';
export const EDITORIAL_INK = '#f5e4b8';
export const EDITORIAL_EASE = [0.22, 1, 0.36, 1] as const;
// Film grain over the black, tiled from an inline SVG (the CSP's img-src allows data:).
export const EDITORIAL_GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")";
export const HEADING_FONT = { fontFamily: 'var(--font-family-heading)' } as const;
export const pad2 = (n: number) => String(n).padStart(2, '0');
