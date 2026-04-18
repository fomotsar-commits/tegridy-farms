# Social Preview Spec — GitHub Open Graph Image

Design spec for the 1280x640 social preview image attached to the repo via
GitHub Settings -> Social preview. Exported asset lives at `docs/og-preview.png`.

## Canvas

- Dimensions: 1280 x 640 px (GitHub OG aspect 2:1)
- Safe area: 80 px inset on all sides (critical content stays inside 1120 x 480)
- Background: radial gradient, center at 30% / 40%
  - Inner: `#101e36` (--color-bg-elevated)
  - Mid:   `#0c1628` (--color-bg-surface)
  - Outer: `#060c1a` (--color-bg-base)
- Overlay: soft purple glow blob, `rgba(139, 92, 246, 0.30)` at 40% opacity,
  Gaussian blur ~200 px, positioned upper-left behind the logo

## Color Palette (from frontend/src/index.css)

| Role          | Token                    | Hex / RGBA                |
|---------------|--------------------------|---------------------------|
| Primary       | --color-primary          | #8b5cf6                   |
| Primary glow  | --color-primary-glow     | rgba(139, 92, 246, 0.40)  |
| BG base       | --color-bg-base          | #060c1a                   |
| BG surface    | --color-bg-surface       | #0c1628                   |
| BG elevated   | --color-bg-elevated      | #101e36                   |
| Text primary  | --color-text-primary     | #ede9fe                   |
| Text secondary| --color-text-secondary   | #a599c9                   |
| Success (TVL) | --color-success          | #31d0aa                   |
| Warning       | --color-warning          | #ffb237                   |
| Border        | --color-border           | rgba(139, 92, 246, 0.30)  |

## TOWELI Logo Placement

- Position: top-left, anchor at (80, 80)
- Size: 96 x 96 px (square lockup)
- Drop shadow: `0 0 24px rgba(139, 92, 246, 0.60)` for glow
- Immediately right of logo (x = 200, y = 112), small wordmark:
  - Text: `TEGRIDDY FARMS`
  - Font: Inter / Space Grotesk, 28 px, weight 700, color `#ede9fe`
  - Letter-spacing: 0.08em, uppercase

## Title Positioning

- Anchor: left edge 80 px, vertical center ~52% of canvas (y ~= 300)
- Line 1 (primary): `DeFi with Tegriddy.`
  - Font: Inter 88 px / weight 800 / color `#ede9fe`
  - Line height: 1.05, letter-spacing: -0.02em
- Line 2 (accent): `Swap. Farm. Lend. Onchain.`
  - Font: Inter 44 px / weight 600 / color `#a599c9`
  - Margin-top: 16 px
- Max width: 900 px (wraps inside safe area)

## Tagline (1-line)

- Position: beneath title at y ~= 440
- Text: `Permissionless AMM + NFT lending on Ethereum — no middlemen, no compromises.`
- Font: Inter 22 px / weight 500 / color `rgba(165, 153, 201, 0.9)`
- Max width: 980 px, single line (truncate with ellipsis if needed)

## Live-Stats Callout (TVL placeholder)

- Position: top-right, anchor at (1200, 80), right-aligned
- Pill container:
  - Size: auto-width x 56 px, padding 16 px horizontal
  - Background: `rgba(49, 208, 170, 0.10)`
  - Border: 1 px solid `rgba(49, 208, 170, 0.40)`
  - Border-radius: 28 px (fully pill)
  - Backdrop-filter: blur(8 px) if target renderer supports it
- Content (single line, 14 px gap between nodes):
  - Pulsing dot: 10 px circle, `#31d0aa`, halo `rgba(49, 208, 170, 0.40)`
  - Label: `TVL` — 14 px / weight 600 / color `#a599c9` / uppercase / 0.1em tracking
  - Value: `$--.-M` (placeholder; replace at export time with live figure)
    - 22 px / weight 700 / color `#31d0aa` / tabular-nums

## CTA

- Position: bottom-left, anchor at (80, 560)
- Format: monospace pill badge
  - Background: `rgba(139, 92, 246, 0.15)`
  - Border: 1 px solid `rgba(139, 92, 246, 0.50)`
  - Border-radius: 10 px
  - Padding: 12 px 20 px
- Text: `github.com/fomotsar-commits/tegridy-farms`
  - Font: JetBrains Mono / IBM Plex Mono, 24 px, weight 500
  - Color: `#ede9fe`
- Optional prefix glyph: `>` in `#8b5cf6`, 4 px right margin

## Footer Accent

- Bottom-right (80 px inset): small version tag
  - Text: `v1 - audited - mainnet`
  - Font: Inter 16 px / weight 500 / color `rgba(165, 153, 201, 0.6)`

## Figma / Canva Export Checklist

- [ ] Frame is exactly 1280 x 640 px (no odd dimensions)
- [ ] All text sits inside the 80 px safe-area inset
- [ ] Palette tokens match hex values from `frontend/src/index.css`
- [ ] Fonts embedded or outlined before export (avoid fallback rendering)
- [ ] TOWELI logo is a raster or outlined vector (no broken SVG references)
- [ ] Live-stats pill value replaced with a real TVL number (or kept as `$--.-M` placeholder)
- [ ] Background gradient renders smoothly — no banding at 100% zoom
- [ ] Purple glow blur preserved (many exporters flatten blur; verify after export)
- [ ] Export as PNG, RGB, 24-bit, no alpha (GitHub flattens transparency)
- [ ] Target file size under 1 MB (GitHub rejects larger images)
- [ ] Filename: `og-preview.png`
- [ ] Destination path: `docs/og-preview.png`
- [ ] Preview in GitHub repo settings — confirm no cropping
- [ ] Tweet/Discord/Telegram preview check (OG renderers crop differently)

## Implementation Notes

- Keep a layered source file (Figma / Canva / .psd) at `docs/og-preview.source`
  or in a linked design doc so TVL and version tag can be updated without rebuild
- When TVL crosses a milestone, re-export and commit a fresh `og-preview.png`
- Do NOT include wallet addresses, emails, or any PII in the preview
