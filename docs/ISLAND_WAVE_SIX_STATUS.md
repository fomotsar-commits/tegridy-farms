# Island — Wave Six status

The island reads this file from the repo. It is the only "done" the island accepts.

One row per phase. `status` is one of NOT-STARTED · IN-PROGRESS · DONE · BLOCKED · RETIRED.
`evidence` is a commit sha plus the test name that proves the done-means.
BLOCKED rows name exactly what is needed, and from whom.

Opened 2026-09-06 from **wave seven, answer one**, which supplied wave six's phase list for
the first time. Wave six never landed as its own shipment; every element is carried by a
wave-seven row, so this file exists to record WHERE each one went rather than to track work
of its own. Six of the seven are RETIRED into wave seven. **One is not**, and the exception
is the point of this file: see row C.

Read `docs/ISLAND_WAVE_SEVEN_STATUS.md` for the live work.

| phase | status | carried by | notes |
|---|---|---|---|
| A the three paths | RETIRED | wave seven row 04, element C | LANDED. `ThreePaths.tsx` is built and mounted on the venue arrival directly after the hall: HOLD / PROVIDE LP / LAUNCH, one line each, requirement at the point of intent. The floor is read from `heatLaunchFloor()` at render, never typed, and the test moves the dial to 123 to prove it. |
| B em-dash zero, the guard | RETIRED | wave seven row 09, element I | Both legs still open in wave seven, and the element is **no longer a straight port**: the rendered leg as originally specified collides with this repo's degraded-read law, because the em dash IS the venue's "unreadable" placeholder (`usePoolMarket.ts:13`). Ruled 2026-09-06: the assertion scopes to venue-voice text nodes. See wave seven's decisions section. |
| C the nav walk | **NOT RETIRED — needs the walk** | wave seven row 04's walk | The island offered two branches: walk it if the tab renders, RETIRE it if the tab is gated off. **It is not gated off.** `navConfig.ts:115` reads `NFT_FINANCE_LIVE = PROMOTE_PENDING \|\| NFT_FINANCE_ADDRESSES_LIVE`, and `PROMOTE_PENDING` is hardcoded `true` at `:105`, so the flag is true **regardless of whether any address is deployed** and `/nft-finance` renders in the bar (`:458`). The 2026-08-31 finding (the tab landing on an error page) is therefore still live until somebody walks it. Folded into row 04's cold walk, not closed here. |
| D the voice sweep on the pinned paths | RETIRED | wave seven row 07, element F | The pools half is **already landed at HEAD**: `src/pages/PoolsPage.tsx` exists and carries zero `Tegridy` strings (read 2026-09-06). The launch page is element F, still open. The "Venue Score" naming call is the operator's and rides §8.1 of the wave-seven master, untouched until his word. |
| E wave four reconciled | RETIRED | wave seven rows W4-02 and W4-03, element K | `docs/ISLAND_WAVE_FOUR_STATUS.md` is opened in the same commit as this file, with the six phases answer one supplied. W4-02 closed in that commit; W4-03 closes through element K. |
| F the parked domain, re-asked | RETIRED | wave seven §8.4 (master) | `memetics.fun` still on registrar parking at `76.223.67.189` per the island's own read of 2026-09-06. One Vercel click plus a DNS repoint, and **Claude changes no DNS and no account settings**: it is walked one message at a time when the operator asks. |
| G the art runbook | RETIRED | wave seven **row 16** (new, last) | Added to `ISLAND_WAVE_SEVEN_STATUS.md` as row 16, deliberately last: infra and UI first. Five steps, plain words, zero em dashes. The art itself is the owner's lane and nothing in wave seven waits on it. |

## The one correction this file owes the island

Row C is the only element answer one got wrong, and it is wrong in the direction that
matters: the island's fallback was "if it is gated off, RETIRED with that line". The tab is
**not** gated off, because `PROMOTE_PENDING` forces it visible independently of the address
wiring, which is exactly the condition under which a tab can render hollow. The 2026-08-31
error-page report stands unresolved and is now attached to row 04's walk.
