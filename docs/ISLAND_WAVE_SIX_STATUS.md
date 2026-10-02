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
| C the nav walk | **OPEN — the island's miss, owned** | evidence: pending the walk; `navConfig.ts:105`, `:115`, `:458` read 2026-09-06 | The island offered "walk it if the tab renders, RETIRE it if gated off", **while looking at the very line that forces it on**: `PROMOTE_PENDING` is hardcoded `true` at `navConfig.ts:105`, so `NFT_FINANCE_LIVE` (`:115`) is true regardless of whether any address is deployed and `/nft-finance` renders in the bar (`:458`). Answer two owns this and rules row C **OPEN**, carried by wave seven as the nav walk it always was. **The walk:** open `/nft-finance` live, read the error boundary and the console, and fix by CLASS — a stale lazy chunk gets the one-shot retry; a runtime throw gets its cause. Then either the tab renders a substantive page, **or `PROMOTE_PENDING` goes false until it does**. The island's word: a tab rendering "Not Deployed" placeholders is not worth its weight on the bar, and the honest absence is preferred. |
| D the voice sweep on the pinned paths | RETIRED | wave seven row 07, element F | The pools half is **already landed at HEAD**: `src/pages/PoolsPage.tsx` exists and carries zero `Tegridy` strings (read 2026-09-06). The launch page is element F, still open. The "Venue Score" naming call is the operator's and rides §8.1 of the wave-seven master, untouched until his word. |
| E wave four reconciled | RETIRED | wave seven rows W4-02 and W4-03, element K | `docs/ISLAND_WAVE_FOUR_STATUS.md` is opened in the same commit as this file, with the six phases answer one supplied. W4-02 closed in that commit; W4-03 closes through element K. |
| F the parked domain, re-asked | RETIRED | wave seven §8.4 (master) | `memetics.fun` still on registrar parking at `76.223.67.189` per the island's own read of 2026-09-06. One Vercel click plus a DNS repoint, and **Claude changes no DNS and no account settings**: it is walked one message at a time when the operator asks. |
| G the art runbook | RETIRED | wave seven **row 16** (new, last) | Added to `ISLAND_WAVE_SEVEN_STATUS.md` as row 16, deliberately last: infra and UI first. Five steps, plain words, zero em dashes. The art itself is the owner's lane and nothing in wave seven waits on it. |

## The one correction this file owed the island — sent, and owned

Row C was the only element answer one got wrong, and it was wrong in the direction that
matters: its fallback was "if it is gated off, RETIRED with that line", written while looking
at the line that forces the tab **on**. Sent back with answer one's other correction; **answer
two owns both**:

> "the island wrote 'if gated off, RETIRED' while looking at the very line that forces it on.
> The hollow-tab report from 2026-08-31 therefore stands and row C is OPEN."

So the 2026-08-31 error-page report is unresolved, row C is OPEN rather than retired, and the
walk now has a defined shape and a defined failure branch (hide the tab rather than ship
placeholders). Both corrections this venue sent back were accepted; neither was argued.
