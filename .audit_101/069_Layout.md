# Agent 069 — Layout / Loader / UI Forensic Audit

Scope: `frontend/src/components/layout/{AppLayout,Background,BottomNav,Footer,TopNav}.tsx` + `frontend/src/components/loader/*` + `frontend/src/components/ui/*` (top-level scan).

## Counts
- HIGH: 4
- MEDIUM: 7
- LOW: 6
- INFO: 4
- Total: 21

---

## HIGH

### H-1 — `OnboardingModal` missing focus trap + initial focus management
**File:** `frontend/src/components/ui/OnboardingModal.tsx:33-164`
Renders a full-screen `role="dialog" aria-modal="true"` overlay but:
- No focus trap on Tab — keyboard users tab past the modal into the page underneath.
- No initial focus into the dialog (the panel root has no `tabIndex={-1}` / `ref.focus()`).
- No body scroll lock — the page behind scrolls via touchmove/wheel while modal is open (background `<Outlet />` keeps full layout flow).
- Focus is never restored to the launching trigger on close.
This auto-launches on every first visit (line 39) so every new user hits a broken a11y experience. Compare to `Modal.tsx` which does have scroll-lock + initial focus (lines 27-49) — `OnboardingModal` was forked before those audits landed and never caught up.

### H-2 — `Modal.tsx` lacks focus trap; only auto-focuses dialog root
**File:** `frontend/src/components/ui/Modal.tsx:18-112`
Auto-focuses the dialog (line 47) and locks scroll, but never installs a Tab/Shift+Tab cycle. Once the user Tabs off the close button they immediately escape into the page behind the backdrop. `TopNav` drawer (line 50-79) and `ArtLightbox` (line 49-65) both implement traps; the shared `Modal` primitive — the most-used overlay — does not. Every consumer of `<Modal>` inherits this regression.

### H-3 — `BottomNav` z-50 collides with global modal layer
**File:** `frontend/src/components/layout/BottomNav.tsx:47`, `frontend/src/components/ui/ArtLightbox.tsx:80`, `frontend/src/components/ui/Modal.tsx:57`
`BottomNav` is `fixed bottom-0 z-50` (always rendered via `AppLayout`). `ArtLightbox` backdrop is also `z-50` (line 80) and `OnboardingModal` is `z-[100]`. With `ArtLightbox` open on mobile, the bottom nav competes for the same stacking context — `NavLink` items remain tap-targets through the dim layer and intercept clicks meant for "Prev/Next/Close" buttons that overlap the bottom 64px. `Modal.tsx` mitigates by escalating to `z-[100]/z-[101]`, but `ArtLightbox` does not, and any other `z-50` overlay inherits the bug.

### H-4 — `OnboardingModal` close-on-outside-click swallows ALL backdrop taps
**File:** `frontend/src/components/ui/OnboardingModal.tsx:67-75`
Outer wrapper has `onClick={close}` and the inner card stops propagation. Acceptable pattern — except the modal auto-opens immediately on first paint (line 39) before the user has a chance to read it. Combined with no scroll lock, on iPhone Safari a scroll fling that starts on the backdrop dismisses the modal and permanently flips the localStorage flag. New users miss the entire onboarding flow on a single accidental tap.

---

## MEDIUM

### M-1 — `TopNav` "More" dropdown not reachable on small screens, primary nav hidden below `md`
**File:** `frontend/src/components/layout/TopNav.tsx:138-201`
Both `<nav className="hidden md:flex">` and the `Tradermigos` NavLink (line 204 `hidden md:block`) are hidden below 768px. On phones (iPhone 14 mini = 375px, iPhone 14+ portrait = 390-430px) the only path to secondary destinations is the hamburger drawer. The `BottomNav` only carries 5 tabs; `Footer` is the only fallback for `/community`, `/leaderboard`, `/tokenomics`, `/treasury`, `/gallery`. iPad portrait (768px) sits at the breakpoint — Safari's iPad mini portrait viewport (744px) loses primary nav entirely until the user rotates.

### M-2 — `Background` is fine but `ParticleBackground` always loaded on mobile
**File:** `frontend/src/components/layout/AppLayout.tsx:97-100`, `frontend/src/components/ParticleBackground.tsx`
`ParticleBackground` is lazy-loaded (good) and respects `prefers-reduced-motion` (line 70), but it has no viewport gate. iPhone 14 with default settings runs the full particle simulation — battery + jank cost on long sessions. The loader (`AppLoader.tsx:140`) tunes `s.isMobile = window.innerWidth < 768` and halves particles, but `ParticleBackground` does not. Combined with `GlitchTransition` (also lazy, also runs on mobile) this is a meaningful battery hit on phones not advertising reduced-motion.

### M-3 — `AppLoader` mute button at `top:16; right:16` overlaps `Toaster` (top-right)
**File:** `frontend/src/components/loader/AppLoader.tsx:617-641`, `frontend/src/components/layout/AppLayout.tsx:140`
Both anchored top-right. While loader is visible toasts can't yet fire (loader is z=9999 over toaster), but the mute button has `position:absolute` inside the overlay div, so once the cracks/exit phase swaps overlay opacity (line 500), if a toast fires before `setVisible(false)` runs, they collide. Low real-world freq, still a stacking smell.

### M-4 — Footer has 4 hardcoded brand strings + 3 hardcoded social URLs
**File:** `frontend/src/components/layout/Footer.tsx:40-43, 80-82, 86, 165`
Lines 40-43: `https://x.com/junglebayac`, `https://discord.gg/junglebay`, `https://t.me/tegridyfarms` literally inlined. Twitter handle is `junglebayac` (Jungle Bay AC); Discord invite is `/junglebay` — these are leftover from the parent Jungle Bay project, not Tegridy Farms. If the project rebrands or rotates social handles, three layout files (and any dupes) need editing. Same file: `© 2026 Tegridy Farms` hardcoded (line 165), and brand text "TEGRIDY FARMS" duplicated in TopNav (line 133-134) and BottomNav comments. Constants `UNISWAP_BUY_URL/ETHERSCAN_TOKEN/GECKOTERMINAL_URL` are imported correctly — only socials are inlined.

### M-5 — `AppLoader` keydown ESC handler triggers without checking modal layer
**File:** `frontend/src/components/loader/AppLoader.tsx:115-128`
Loader installs a global `keydown` listener that consumes Escape. Loader z-index is 9999 (line 601), so during loader-visible time it's the top layer — but the listener stays attached for the lifetime of `visible` and fires before any other ESC handler. Fine while loader is up, but `visible` is only flipped after `finalize()` runs and the cleanup happens via `setTimeout(...,500)` for audio dispose. Race window for ESC firing into a not-yet-mounted modal.

### M-6 — `TopNav` mobile drawer focus trap doesn't include trigger restoration on Escape path
**File:** `frontend/src/components/layout/TopNav.tsx:50-92`
The `keydown` Escape handler sets `setOpen(false)` (line 54) and the close-effect `else` branch refocuses `menuButtonRef`. But Escape can fire from `document` while focus is in `body` (e.g., user clicked backdrop without the close-effect catching it correctly), and there's no `ref?.current` guard for the case where the menu button has unmounted (e.g., resized to desktop while drawer was open). Also — focus trap walks `[tabindex]:not([tabindex="-1"])` but `<NavLink>` becomes `<a>` with no explicit tabindex; works but is fragile if any item adds a `tabindex={-1}`.

### M-7 — `Modal` `aria-labelledby` references title id even when title prop is omitted only via spread
**File:** `frontend/src/components/ui/Modal.tsx:69`
Conditional spread `{...(title ? { 'aria-labelledby': titleId } : { 'aria-label': 'Dialog' })}` works, but the fallback `aria-label="Dialog"` is the literal word "Dialog" — screen readers will announce that bare string for any titleless modal, which is actively unhelpful (vs no label, which would force AT to read content). Should default to a more meaningful label or require `aria-label` from caller when `title` is absent.

---

## LOW

### L-1 — Footer external links open in new tab without explaining truncation
**File:** `frontend/src/components/layout/Footer.tsx:118-141`
Uses `target="_blank" rel="noopener noreferrer"` — good. `aria-label` says "(opens in new tab)" — also good. But the visual indicator is `<span className="text-white/40">↗</span>` outside the accessible name region; SR users hear "opens in new tab", sighted users see arrow, `↗` itself isn't announced (text-only fallback would be `aria-hidden`). Cosmetic, but inconsistent with the rest of the icon hygiene in the codebase.

### L-2 — `Footer` external links lack URL validation
**File:** `frontend/src/components/layout/Footer.tsx:33-43`
`UNISWAP_BUY_URL`, `ETHERSCAN_TOKEN`, `GECKOTERMINAL_URL` are imported from constants — if those export `undefined` the `<a href={undefined}>` resolves to the current page URL on click. No defensive `if (!l.href) return null`.

### L-3 — `AppLoader` skip-link mismatch
**File:** `frontend/src/components/layout/AppLayout.tsx:96`
Skip link points to `#main-content` (line 124) — correct. But `AppLoader` wraps the entire layout (line 91) and is `z-9999` on first visit, so the skip link is never reachable until after the loader finishes. Keyboard-only first-visit users have to wait through the splash even though it's supposedly skippable via Escape. Add focus trap into the loader so Tab actually reaches the mute button + ESC indicator.

### L-4 — `BottomNav` no `aria-current` for the active route
**File:** `frontend/src/components/layout/BottomNav.tsx:55-65`
NavLink supplies `isActive` via render prop and the active pill gets a color class, but the rendered `<a>` has no `aria-current="page"`. React-Router's `<NavLink>` does inject `aria-current` by default, so this is actually fine — confirmed by React Router v6+ behavior. Marking INFO not LOW.  *(downgraded — see I-2)*

### L-5 — `Skeleton` no `aria-busy` / `role="status"`
**File:** `frontend/src/components/ui/Skeleton.tsx:1-13`
`<span className="skeleton">` is decorative — no `role="status"`, no `aria-live="polite"`, no `aria-label="Loading"`. Screen readers see nothing while content loads; sighted users see the shimmer. Add `role="status"` + `aria-label="Loading"` (or accept a label prop).

### L-6 — `OnboardingModal` Skip→Storage on close is irreversible without devtools
**File:** `frontend/src/components/ui/OnboardingModal.tsx:52-55`
Once a user closes via backdrop tap or X, `localStorage[tegridy-onboarding-seen] = '1'` and the modal never returns. There's no "?" / Help re-trigger anywhere in the UI to re-open onboarding. Footer / Help menu should expose a "Show intro again" link for users who closed it accidentally. Also relevant to H-4.

---

## INFO

### I-1 — `Background` is one line; effectively a CSS color reset
`frontend/src/components/layout/Background.tsx:1-6` — fine. No mobile concern; pure DOM.

### I-2 — `BottomNav` does set `aria-current` via NavLink default
React Router v6 `<NavLink>` injects `aria-current="page"` automatically when active. Confirmed safe.

### I-3 — `WrongChainGuard` properly gates on `isConnected`
`frontend/src/components/ui/WrongChainGuard.tsx:35-39` — correct (avoids the wagmi quirk where `useChainId` returns the configured default when disconnected).

### I-4 — `ErrorBoundary` resetKeys works correctly across route changes
`frontend/src/components/ui/ErrorBoundary.tsx:24-34` — `componentDidUpdate` clears `hasError` when `resetKeys` differ. AppLayout passes `[location.pathname]` (line 126). Good.

---

## Top-3 Findings (priority)

1. **H-1: OnboardingModal missing focus trap + scroll lock + focus restoration.** Auto-opens on first visit, every first-visit keyboard user gets broken a11y. (also H-4 backdrop-tap dismissal makes it worse on mobile)
2. **H-2: Base `Modal` primitive has no focus trap.** Every consumer (any `<Modal>` import in the app) silently inherits this. Compare against `ArtLightbox` and `TopNav` drawer which DO trap correctly.
3. **H-3 / M-1: `BottomNav` z-50 stacking + `TopNav` primary nav `hidden md:*`.** Mobile users (iPhone 14+, iPad portrait at 744px) lose primary destinations entirely; `ArtLightbox` competes with bottom nav for clicks. Combined IA failure on the smallest viewports.
