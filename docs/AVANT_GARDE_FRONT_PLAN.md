# The front, made avant-garde — plan of 2026-10-19

> The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md). This file is the design note behind one pull request, not a to-do list.

Walked on production, 2026-10-19: the venue home, the BAYLA door, each of its six doors, the menu, at a wide desktop. Phone and iPad were read from the code and then shot with Playwright at 390 and 810.

## What the walk found

1. **The desktop hides the second tier.** The bar is four words. Pools, Check, Dashboard, fourteen features and the records sit behind an unlabelled 20px icon at the far right, after the wallet. On a phone that icon is where every app's menu is, so the phone reads as richer than the desktop. The content is the same; the desktop never says so.
2. **The "More" list is a pile.** Fourteen names in the order they were added, two columns, no grouping: History beside Lore beside Community beside Treasury; Pro Charting under Gallery. The owner's own words on 10-18: "until we can organize them better".
3. **The room has no index.** The BAYLA door is six cards tall (hero, market, burn, held time, holders, lore), about 3,600px. Nothing names what is below the fold, and the hero's six doors (Trade, Add, Stake, Scan, Marketplace, NFT loans) vanish on the first scroll.
4. **The language is already there.** The menu's editorial style (Archivo Black words, mono numbers, "fig. 03" captions, film grain, the circle reveal) is the strongest thing on the site. The rest of the chrome does not speak it.
5. **The owner's screen is wide** (about 3,400 CSS px). The 1,050px column floats in art. Not changed in this round: widening the column touches every page.

## The design

One language (numbered, mono, editorial) at the three widths. Organise by the visitor's journey. Add; never remove art.

### 1. The Index (the menu, every width)

Groups in the order a visitor moves: **Island → Swap → Pools → Lock → Launch → Check → Records**. Each group is its word (the section's own link) and every destination under it, in tab order; off pages left out, gated ones riding their gate. Island also carries the venue's pages no section claims (Gold Card, History, Lore). Dashboard appears once a wallet connects. Numbering runs through the whole index.

- Phone: groups stacked, their pages two across.
- iPad: two columns of groups.
- Desktop: the groups beside the picture frame; the frame shows the group under the pointer.

### 2. Jump to (the Index's search)

A search field at the top of the Index narrows every group as you type; Enter opens the first match. **Ctrl+K / ⌘K** opens the Index with the cursor in the field, from any page.

### 3. The desktop trigger

The menu button says **Menu** beside its icon from 1,100px, so a desktop knows the Index exists. The four bar words stay (owner, 10-18; five is the ceiling on a phone).

### 4. The Rail (every resident's room)

An index of the room's own page: **Doors · Market · Burn · Held time · Holders · Lore**, numbered, lit as you scroll, one tap to each.

- Desktop from 1,280px: a vertical rail fixed at the left edge.
- Phone and iPad: a strip under the top bar that stays while the cards scroll; 44px targets.

It reads the sections the room actually renders, so a resident without lore gets no Lore entry. It carries no art: a fixed strip is never an art surface (art-system rule).

### 5. The width (the second pull request)

One rule for the column, `page-column` in `index.css`: 1,200px, then 1,360px from 1,536px, 1,600px from 1,920px and 1,800px from 2,560px. The bar, the Index's rows, the footer, every 1,200px host and the first frame's `.ff-wrap` read it, so the bar's logo stays over the page's edge and the hero does not move when React takes over. Under 1,536px nothing changes.

A room with a market lays its cards on a grid from 1,536px: the market and its chart across eight of twelve columns, the burn, the held time and the holders stacked in the other four, the lore across all twelve. The hero stays where it is, at the left of the column with the resident's art composed beside it; the cards were not moved up next to it because the market card would have covered the muse. The market's six stats and the holders' four go fewer abreast in their narrower slots until 1,920px, by a prop the room's page passes, since the same cards render full width on the dashboard panels and the door landing (a container query could not do it: the column's padding changes at the same breakpoints the tiles flip on, so no card width maps to them).

The Rail keeps its breakpoints: each column step leaves its gutter wider than the docked rail, and its words from 1,700px fit in every band.

## Not in this round

- A hall of every room inside the Index.
- The Rail on the venue home (its sections differ).

## How it is checked

Unit tests on navConfig, TopNav, NavDrawer and RoomRail. Playwright screenshots at 390, 810 and 1280 of the Index and of the BAYLA door, looked at, not only asserted.

The width: `src/lib/pageColumn.test.ts` pins the steps, the first frame's copy of them and that no page keeps a column of its own; `e2e/wide-screen.spec.ts` measures the bar, the page, the footer, the room's grid and the rail at each step's first and last pixel, 1,280 to 3,400. Screenshots of the BAYLA door at 1,280, 1,536, 1,920 and 2,560, looked at; the 1,280 one hashes the same before and after.
