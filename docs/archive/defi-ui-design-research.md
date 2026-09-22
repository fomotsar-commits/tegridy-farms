# DeFi UI Design Research: Top Yield Farming & DEX Protocols (2025-2026)

Comprehensive design notes from researching the top protocols across all major blockchains.

---

## 1. RAYDIUM (raydium.io) -- Solana

### Color Palette
- **Primary Accent**: `#abc4ff` (soft periwinkle blue)
- **Secondary Accent**: `#22D1F8` (vivid cyan)
- **Purple**: `#8C6EEF`
- **Pink/Error**: `#FF4EA3`
- **Warning/Gold**: `#FED33A`
- **Success**: `#22D1F8` (cyan doubles as success)
- **Text Primary**: `#ECF5FF` (near-white with blue tint)
- **Text Secondary**: `#abc4ff` at varying opacities
- **Text Tertiary/Placeholder**: `#abc4ff80` (50% opacity periwinkle)

### Background & Gradients
- **Main Background Gradient**: `linear-gradient(29.71deg, #121C34 -18.98%, #050D17 14.6%, #070A15 56.26%, rgba(9, 14, 29, 0.97) 85.27%)` -- deep navy to near-black with subtle blue undertone
- **Background Dark**: `#0b1022`
- **Background Medium**: `#161E32`
- **Background Light**: `#1C243E`
- **Button Gradient**: `linear-gradient(272.03deg, #39D0D8 2.63%, #22D1F8 95.31%)` -- teal-to-cyan
- **Outline Button Gradient**: Semi-transparent cyan at 10% opacity
- **Transparent Containers**: `linear-gradient(271.31deg, rgba(96, 59, 200, 0.2) 1.47%, rgba(140, 110, 239, 0.12) 100%)` -- purple glassmorphism

### Card Styling
- **Card Shadow**: `0px 8px 24px rgba(79, 83, 243, 0.12)` -- subtle purple glow
- **Card Border**: `#8C6EEF80` (50% opacity purple)
- **Divider**: `rgba(171, 196, 255, 0.12)` -- barely visible periwinkle lines
- **Modal Background**: `#ABC4FF12` (7% opacity periwinkle)
- **Border Radius**: `8px` (md), `1rem/16px` (2xl)

### Typography
- **Font Family**: "Space Grotesk" (geometric sans-serif, modern techy feel)
- **Font Sizes**: 12px (xs) through 40px (hero title)
- **Font Weights**: 300, 400, 500, 700
- **Special Features**: `'ss04', 'tnum' 1` (tabular numerals for aligned data columns)

### Layout & Navigation
- Built on Chakra UI component system
- Responsive breakpoints: 48em, 64em, 90em, 120em
- Full-viewport layout (`overflow: hidden; height: 100%`)
- Custom scrollbar: `rgba(255, 255, 255, 0.2)` thumb, 6px wide, 8px border-radius
- Transitions: 200ms standard duration

### Standout Elements
- Badge system with purple `rgba(140, 110, 239, 0.5)` and cyan `rgba(34, 209, 248, 0.5)` variants
- Token avatar backgrounds use subtle 20% opacity gradients
- Multi-layered background creates extraordinary depth
- Tabular numerals ensure data columns align perfectly

---

## 2. HYPERLIQUID (app.hyperliquid.xyz) -- Hyperliquid L1

### Color Palette
- **Primary Background**: Linear gradient from `#071127` to `#071a2a` (extremely deep navy)
- **Card Background**: `#0b1220` (slightly lighter navy)
- **Text Primary**: `#e6eef6` (soft off-white)
- **Text Muted**: `#94a3b8` (slate gray)
- **Accent Color**: `#06b6d4` (single vivid cyan -- the ONLY bright color outside P&L)
- **Glass Effect**: `rgba(255, 255, 255, 0.03)` (barely perceptible)
- **Green/Red**: Used ONLY for P&L, never decoratively

### Card Styling
- **Background**: `#0b1220`
- **Border Radius**: 12px
- **Border**: 1px `rgba(255, 255, 255, 0.03)` (nearly invisible)
- **Padding**: 18px internal
- **Wrapper Shadow**: `0 12px 40px rgba(2, 6, 23, 0.6)` (deep, diffused)
- **Wrapper Padding**: 32px, 14px border-radius

### Typography
- **Font Family**: Inter or Segoe UI (neutral, professional)
- **Hierarchy**: Large bold for prices/positions, medium for controls, small muted for helper text
- **Line Height**: 1.6 for readability, 24px base vertical rhythm
- **Headline Sizes**: h1 at 28px, h2 at 18px

### Layout Architecture
- **Three-column trading canvas**: Market overview (left), order blotter & chart (center), positions/portfolio (right)
- **Mobile**: Stacks vertically -- chart top, controls mid, portfolio bottom
- **Page Padding**: 36px
- **Grid Gap**: 18px between items
- **Paragraph Margin**: 10px

### Interaction Design
- **Buttons**: Cyan background (`#06b6d4`) with dark text (`#072031`), 10px padding, 10px border-radius, font-weight 600
- **Keyboard Indicators**: 13px font in glassmorphic boxes with `rgba(255, 255, 255, 0.04)` borders
- **Collapsible Panels**: Novice simplicity with advanced parameters behind expandable sections
- **Animation Duration**: 120-220ms for confirmations, fills, margin updates
- **Toast Notifications**: With action links for failed transaction recovery

### Data Visualization
- Chart overlays: funding rate bands, margin cushion, liquidation horizons, VWAP
- Sparklines inside order rows for quick market context
- Information density is HIGH but visually calm

### What Makes It Premium
- **Extreme restraint**: Only one accent color (cyan). Greens/reds only for P&L
- No noisy gradients in data areas
- Glassmorphism is subtle (3% opacity), never flashy
- Professional trading terminal feel -- closer to Bloomberg than typical DeFi
- Information density without visual chaos

---

## 3. PANCAKESWAP (pancakeswap.finance) -- Multi-chain

### Color Palette (Dark Theme)
- **Primary**: `#1FC7D4` (bright teal/cyan)
- **Primary Bright**: `#53DEE9` (lighter cyan)
- **Primary Dark**: `#0098A1` (deep teal)
- **Secondary**: `#9A6AFF` (vibrant purple -- note: different from light theme's `#7645D9`)
- **Success**: `#31D0AA` (mint green)
- **Failure/Error**: `#ED4B9E` (hot pink)
- **Warning**: `#FFB237` (amber)
- **Background**: `#08060B` (near-black with purple tint)
- **Background Alt**: `#27262c` (dark charcoal)
- **Background Alt 2**: `rgba(39, 38, 44, 0.7)` (semi-transparent charcoal)
- **Card Border**: `#383241` (dark purple-gray)
- **Text**: `#F4EEFF` (off-white with purple tint)
- **Text Subtle**: `#B8ADD2` (muted lavender)
- **Text Disabled**: `#666171` (medium gray-purple)
- **Input Background**: `#372F47` (dark purple)
- **Input Secondary**: `#262130` (deeper purple)
- **Dropdown**: `#1E1D20`
- **Dropdown Deep**: `#100C18` (near-black purple)
- **Tertiary**: `#353547` (dark muted purple)
- **Disabled**: `#524B63` (medium purple-gray)
- **Overlay**: `#452a7a` (deep purple)
- **Binance**: `#F0B90B`
- **Gold**: `#FFC700`

### Color Palette (Light Theme)
- **Primary**: `#1FC7D4`
- **Secondary**: `#7645D9` (standard purple)
- **Background**: `#FAF9FA`
- **Background Alt**: `#FFFFFF`
- **Card Border**: `#E7E3EB` (soft purple-gray)
- **Text**: `#280D5F` (deep purple)
- **Text Subtle**: `#7A6EAA` (medium purple)
- **Input**: `#eeeaf4` (very light purple)

### Gradients
- Bubblegum, inverseBubblegum, cardHeader, blue, violet, violetAlt, gold gradient presets available

### Design System
- Built with styled-components and a formal ThemeProvider
- Full UIKit with standardized components (now "pancake-toolkit")
- Dark/light toggle with system preference detection via `prefers-color-scheme`
- Next.js with SSR (`appGip: true`)

### What Makes It Distinctive
- Purple-tinted dark theme (not pure gray/blue like most DeFi)
- Playful, approachable brand while maintaining data credibility
- Teal + purple as dual accent colors is distinctive
- Every neutral has a purple undertone, creating cohesion
- Social login integration (Privy authentication)

---

## 4. JUPITER (jup.ag) -- Solana

### Color Palette & Typography
- **Font Stack**: Inter (weights 300-700) + Courier Prime (for code/data)
- **Accent Color**: `#C8F284` (lime green -- signature Jupiter color)
- **Theme**: Dark mode primary with dark/light toggle capability (`.changing-theme` class)
- **Layout**: Next.js app, 100vw width, `overflow-x: clip`

### Swap Terminal Design
- **Border Radius**: 10px on cards/containers
- **Interactive Borders**: 2px solid transparent, transitions to `#C8F284` (lime green) on hover
- **Transition Timing**: `0.2s ease-in-out` for opacity and border changes
- **Display Modes**: Integrated, widget, or modal -- three ways to present swap

### What Makes It Premium
- Lime green (`#C8F284`) as accent is HIGHLY distinctive -- no other major DEX uses this
- Inter font family gives professional, clean feel
- Plugin/terminal architecture means consistent design across integrations
- "Ultra Mode" swap experience is the flagship feature
- Minimal, focused UI -- swap-centric rather than dashboard-heavy

---

## 5. PENDLE FINANCE (pendle.finance) -- Multi-chain

### Design Characteristics (from analysis and industry knowledge)
- **Theme**: Dark mode dominant with deep blue-purple backgrounds
- **Primary Accent**: Blue-cyan gradients for yield data
- **Navigation**: Top navigation bar with chain selector
- **Font**: Clean sans-serif (likely Inter or similar)

### Data Presentation
- Yield markets displayed in card/table hybrid layouts
- PT (Principal Token) and YT (Yield Token) shown with clear APY breakdowns
- Fixed APY prominently displayed in large, bright numbers (usually cyan/green)
- Implied APY shown with line charts
- Token logos displayed in circular overlapping pairs for yield markets

### Layout Pattern
- Markets page uses a filterable/sortable table-card layout
- Each yield market row shows: asset pair, chain, maturity date, implied APY, underlying APY, TVL
- Trade interface has a centered swap-style card with PT/YT toggle
- Sidebar or top-nav for section navigation (Trade, Earn, Dashboard)

### What Makes It Premium
- Yield-centric data visualization is unique -- maturity dates, implied vs underlying APY
- Clean data density -- lots of numbers but well-organized
- Professional feel targeting DeFi power users
- Multi-chain selector integrated cleanly into top nav

---

## 6. AERODROME FINANCE (aerodrome.finance) -- Base

### Design Characteristics
- **Branding**: "The central liquidity hub on Base network"
- **Logo**: 512px PNG available
- **Theme**: Dark mode, clean minimal interface
- **Relationship**: Fork/sibling of Velodrome (Optimism), sharing core UI patterns

### Layout & Navigation
- Top navigation with tabs for Swap, Pools, Vote, Dashboard
- Swap interface is centered card-style
- Pool listings in sortable table format
- veAERO locking interface for governance

### Color Theme
- Blue-tinted dark theme consistent with Base network branding
- Clean, institutional feel -- less playful than PancakeSwap, more accessible than Hyperliquid
- Blue accent colors for primary actions

---

## 7. VELODROME FINANCE (app.velodrome.finance) -- Optimism

### Design Characteristics
- **Branding**: "The central trading and liquidity marketplace on Optimism network"
- **Theme**: Dark mode with clear navigation tabs
- **Logo**: 512px PNG
- **Sibling**: Aerodrome (Base) -- nearly identical UI patterns

### Layout
- Clear navigation tabs: Swaps, Pools, Vote
- Sortable/filterable pool tables
- veVELO locking interface
- Dark-mode option with clean layout

### What Makes It Distinctive
- Velodrome/Aerodrome pioneered the ve(3,3) DEX UI pattern
- Voting/gauge interface is a distinguishing feature
- Clean, functional design -- not flashy but highly usable
- Optimism red accent likely used alongside dark blue theme

---

## 8. CAMELOT DEX (app.camelot.exchange) -- Arbitrum

### Design Characteristics
- **Theme**: Dark theme with medieval/fantasy branding
- **Loading Spinner Colors**: `#f5f5f5` border, `#000` accent, `#ff4500` error state
- **Framework**: Nuxt.js
- **API**: `api.camelot.exchange`

### Brand Identity
- Medieval fantasy aesthetic (Excalibur, Round Table, GRAIL token)
- Dark, rich backgrounds with amber/gold accent colors
- Custom iconography inspired by fantasy themes
- $GRAIL and xGRAIL token branding

### Layout
- Top navigation bar
- Concentrated liquidity (V3-style) interface
- Nitro pools for yield farming with custom staking cards
- Spaced, card-based pool layouts

### What Makes It Premium
- Strong thematic branding sets it apart (medieval/fantasy)
- Amber/gold accents on dark backgrounds feel luxurious
- Rich visual identity beyond just "another swap interface"
- Custom illustrations and branding throughout

---

## 9. SHADOW EXCHANGE (shadow.so) -- Sonic

### Design Characteristics
- **Font Family**: "Satoshi" (modern geometric sans-serif, popular in crypto/fintech)
- **Theme**: Dark theme (`bg-darker`, `text-light` classes)
- **Framework**: Next.js with Vercel analytics
- **Max Container Width**: `1750px`
- **Desktop Padding**: `lg:px-12 lg:pt-16` (48px horizontal, 64px top)
- **Text Rendering**: Antialiased for crisp clarity

### Layout
- Responsive, mobile-first design with breakpoint-specific spacing
- Background images with `bg-cover bg-center`
- Nested layout system with parallel routing
- Suspense boundaries and dynamic loading (code-split chunks)

### Performance
- SpeedInsights integration (performance-optimized)
- Sub-second interactions matching Sonic chain speed
- Clean, responsive interface with no lag

### What Makes It Premium
- Satoshi font is a distinctive, modern choice
- Built for speed -- matches Sonic chain's sub-second finality
- x(3,3) model UI with concentrated liquidity range selectors
- Clean, no-nonsense design focused on trading efficiency

---

## 10. TRADER JOE / LFJ (traderjoexyz.com) -- Avalanche, Arbitrum, others

### Design Characteristics
- **Theme**: Dark theme with warm accent colors
- **Brand**: Playful but professional (named after the retail store concept)
- **Framework**: Next.js app

### Navigation
- Top navigation with sections: Trade, Pool, Farm, Lend, Staking
- Straightforward, beginner-friendly layout
- Dashboard with real-time data on pools, farms, rewards

### Data Presentation
- Pool cards show: token pair, APR, liquidity amount, fee tier
- Farm cards show: LP token staking with APR breakdown (Pool APR + JOE APR)
- Harvest buttons for claiming rewards
- Swap confirmation screens show: minimum received, price impact, LP fees
- Real-time charts, price alerts, portfolio tracking

### Liquidity Book Interface
- Unique "bins" visualization for concentrated liquidity
- Price range selectors specific to Liquidity Book design
- Visual representation of liquidity distribution across price bins

### What Makes It Premium
- "Fun graphics, designs and menus" -- intentionally not boring
- Beginner-friendly with advanced tools available
- Liquidity Book bin visualization is unique to Trader Joe
- Multi-chain deployment with consistent design language

---

## CROSS-PROTOCOL DESIGN PATTERNS & TRENDS

### Universal Dark Theme Approach
Every single top protocol uses dark mode as default. The standard palette:
- Background: `#08-#12` range (near-black with colored undertones)
- Cards: 5-10% lighter than background
- Text: `#E0-#F4` range (off-white, never pure `#FFF`)
- Borders: 3-12% opacity white or colored

### Background Strategies
1. **Solid dark** (Hyperliquid, PancakeSwap): `#070-#0B0` range, simple and professional
2. **Multi-stop gradients** (Raydium): Complex gradients create depth and movement
3. **Blue-tinted dark** (Aerodrome, Velodrome, Hyperliquid): Navy undertones feel institutional
4. **Purple-tinted dark** (PancakeSwap, Pendle): Purple undertones feel more DeFi-native

### Card Design Patterns
- **Border Radius**: 8-16px standard across all protocols
- **Borders**: Extremely subtle (3-12% opacity), colored to match accent
- **Shadows**: Tinted shadows (purple/blue glow) rather than black shadows
- **Backgrounds**: 5-15% lighter than page background, often with subtle transparency
- **Glassmorphism**: Used sparingly -- `backdrop-filter: blur(10-20px)` with 10-40% opacity

### Typography Hierarchy
| Protocol | Font | Character |
|----------|------|-----------|
| Raydium | Space Grotesk | Techy, geometric |
| Hyperliquid | Inter | Professional, neutral |
| Jupiter | Inter + Courier Prime | Clean + monospace data |
| Shadow | Satoshi | Modern, trendy |
| PancakeSwap | Custom/System | Approachable |

**Best Practice**: Use tabular numerals (`font-feature-settings: 'tnum'`) for data columns so numbers align vertically.

### Accent Color Strategies
| Protocol | Primary Accent | Secondary | Strategy |
|----------|---------------|-----------|----------|
| Raydium | Cyan `#22D1F8` | Purple `#8C6EEF` | Dual accent, vibrant |
| Hyperliquid | Cyan `#06b6d4` | None | Single accent, restraint |
| PancakeSwap | Teal `#1FC7D4` | Purple `#9A6AFF` | Dual accent, playful |
| Jupiter | Lime `#C8F284` | -- | Single accent, unique |
| Camelot | Amber/Gold | -- | Thematic |
| Pendle | Blue-cyan | -- | Data-focused |

### Navigation Patterns
- **Top Nav (dominant)**: Pendle, Aerodrome, Velodrome, Camelot, Trader Joe, PancakeSwap, Jupiter
- **Sidebar (rare in DeFi)**: Some dashboards use collapsible sidebars
- **Common nav items**: Swap, Pools/Liquidity, Farm/Earn, Dashboard/Portfolio, Vote/Governance
- **Chain Selector**: Integrated into nav bar for multi-chain protocols
- **Wallet Connect**: Always top-right, prominent button

### Swap Interface Standard
All protocols follow a near-identical swap card layout:
1. Centered card (max-width ~480px)
2. "From" token input at top with token selector dropdown
3. Swap direction arrow/button in the middle
4. "To" token input at bottom
5. Rate/price impact info below the card
6. Large CTA button at bottom ("Swap", "Connect Wallet")
7. Settings gear icon (top-right of card) for slippage tolerance

### Pool/Farm Card Layouts
Two dominant patterns:
1. **Table Layout** (Aerodrome, Velodrome, Raydium, Pendle): Sortable columns with token pair, APR, TVL, volume. Each row expandable for details.
2. **Card Grid** (PancakeSwap, Trader Joe, Camelot): Individual cards per pool with all data visible. Usually 2-3 columns on desktop.

### Data Presentation Best Practices
- **APR/APY**: Large, bright-colored numbers (cyan, green, or lime). Often the most visually prominent element.
- **TVL**: Secondary importance, usually in muted text or smaller font.
- **Token Prices**: Shown in swap interface, less prominent in pool listings.
- **User Positions**: Dedicated dashboard/portfolio page with expandable rows.
- **Rewards**: Highlighted with accent colors and "Claim" CTAs.

### What Separates "Premium" from "Generic"

**Premium protocols share these traits:**
1. **Color restraint** -- 1-2 accent colors max, never rainbow
2. **Tinted shadows** -- Purple/blue box-shadows instead of black
3. **Subtle glassmorphism** -- 3-12% opacity backgrounds, not heavy frosted glass
4. **Tabular numerals** -- Numbers align in columns perfectly
5. **Micro-animations** -- 120-220ms transitions, not jarring
6. **Information hierarchy** -- APR is prominent, secondary data is appropriately muted
7. **Consistent spacing** -- 4/8px grid system throughout
8. **Custom scrollbars** -- Thin, semi-transparent, matching theme
9. **Gradient buttons** -- CTAs use subtle gradients rather than flat colors
10. **Depth through layering** -- Multiple background layers creating dimensional feel

**Generic protocols suffer from:**
- Too many colors competing for attention
- Black shadows on dark backgrounds (looks flat or dirty)
- Inconsistent spacing and alignment
- Pure white text (harsh on dark backgrounds)
- No typographic hierarchy for data
- Flat, single-layer backgrounds
- Standard browser scrollbars and form elements

---

## RECOMMENDED STACK FOR A NEW DEFI APP

### Colors (Dark Theme)
```
--bg-primary: #0a0e1a        (deep navy-black)
--bg-secondary: #111827       (slightly lighter)
--bg-card: #1a2035            (card surfaces)
--bg-card-hover: #1f2847      (card hover state)
--border-subtle: rgba(255, 255, 255, 0.06)
--border-accent: rgba(YOUR_ACCENT, 0.3)

--text-primary: #e8edf5       (off-white, blue-tinted)
--text-secondary: #94a3b8     (muted slate)
--text-tertiary: #64748b      (very muted)

--accent-primary: #22d1f8     (cyan -- proven winner)
--accent-secondary: #8c6eef   (purple -- great complement)
--success: #31d0aa
--error: #ff4ea3
--warning: #ffb237

--shadow-card: 0px 8px 24px rgba(YOUR_ACCENT_RGB, 0.12)
--shadow-elevated: 0 12px 40px rgba(2, 6, 23, 0.6)
```

### Typography
```
--font-primary: 'Inter', 'Space Grotesk', or 'Satoshi'
--font-mono: 'JetBrains Mono', 'Courier Prime', monospace
--font-feature-settings: 'tnum' 1   (tabular numerals!)

--text-xs: 12px
--text-sm: 14px
--text-base: 16px
--text-lg: 18px
--text-xl: 20px
--text-2xl: 24px
--text-3xl: 30px
--text-hero: 40px
```

### Card Styling
```
border-radius: 12px
border: 1px solid rgba(255, 255, 255, 0.06)
background: var(--bg-card)
padding: 20px
backdrop-filter: blur(12px)  (for glassmorphic variants)
box-shadow: var(--shadow-card)
transition: all 200ms ease
```

### Button Styling
```
Primary: background: linear-gradient(272deg, #39D0D8, #22D1F8)
         color: #072031
         border-radius: 10px
         font-weight: 600
         padding: 12px 24px

Secondary: background: transparent
           border: 1px solid rgba(34, 209, 248, 0.3)
           color: #22D1F8
```

### Spacing Scale (8px base)
```
4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96
```
