# Island — Wave Four status

The island reads this file from the repo. It is the only "done" the island accepts.

One row per phase. `status` is one of NOT-STARTED · IN-PROGRESS · DONE · BLOCKED · RETIRED.
`evidence` is a commit sha plus the test name that proves the done-means.
BLOCKED rows name exactly what is needed, and from whom.

Opened 2026-09-06 from **wave seven, answer one**, which quoted wave four's six phases from
the island's master. This closes a standing ask: `ISLAND_WAVE_FIVE_STATUS.md:147-150` recorded
that there was **no wave-four directive anywhere in this repo**, and asked for the phase list
so the rows could be filled against the island's own contract rather than a guess. That is
what this file is.

Wave seven carries two of these six. The other four are island-side or already lived.

| phase | status | evidence | notes |
|---|---|---|---|
| 01 the answers, filed | RETIRED — island-side | answer one, §1.2 | The rail is the venue's call (wave three phase 02 RETIRED); the averaging period is published as GRAMMAR, TWAB over the whole held time, never a calendar number; the fee constitution published plainly; certification is island-origin only; the voucher clock is the verifier's. Nothing here is a venue deliverable. The venue's obligation is only to quote it, which element K does. |
| 02 the arrival judgment is ninety days now | **DONE** | this commit · `heatOracle.ts` + `BirthQueuePanel.tsx` | The island re-cut its enrollment judgment on 2026-08-24: an arriving token anchors at least ninety days past launch, then stands a measured ninety days. The half-year figure is retired. Grammar, verbatim: **"Arrivals prove ninety days. Births don't."** Two sites corrected, not one — see below. |
| 03 the whole law, published | NOT-STARTED | | Wave seven element K, row W4-03. Unblocked: the island's `/heat` page is up and its sentences were read 2026-09-06. Retires `HeatCard.tsx`'s computed size-term table and single-token-share sentence, and `heatOracle.ts`'s caps-at-100 and single-position claims. The window and decay guards STAY exactly as written. |
| 04 the citable set | RETIRED — island-side | answer one, §1.2 | Twenty five persons at Observer or better and seven at Resident or better over the island's rolling ninety-day window; counted, never summed; two windows never confused; PERSONS not wallets. The venue never self-declares certification and never prints the stamp, so this is a law the venue obeys rather than a surface it builds. Verified venue-side: no surface states what certification takes (`GardenLane.tsx:78-79`, `certification.ts:12-13` state no criteria at all). |
| 05 maturity rides inside the number, later | RETIRED — logs only | answer one, §1.2 | A newly added bungalow's contribution starts below full weight and grows with time in the set. Explicitly **not** for public surfaces: no step numbers anywhere on a venue surface until the island publishes them. Recorded here so a future reader does not build it. |
| 06 the bungalow doors, seen | RETIRED — already lived | `bungalows.test.ts` (26) | The island read the bungalow build and the registry-verbatim discipline with its tests, and said keep it. Already true at HEAD; no work owed. |

## W4-02, and the one thing answer one got wrong

Answer one said: *"no rendered venue surface states the old figure any more; one source comment
still does, `frontend/src/lib/heat/heatOracle.ts:87`."*

The comment was there and is corrected. **But the rendered half of that claim is false.**
`src/components/BirthQueuePanel.tsx:67` is JSX, not a comment, and it told every reader of the
birth-queue panel that a token's Heat is measured from birth *"rather than after a half-year
wait"*. Checked before patching: zero comment lines in that range; it is copy on a surface.

So W4-02 needed **two** corrections, and the one the island missed is the one an actual person
reads. Both landed in this commit:

- `heatOracle.ts` — the island attribution now quotes the ninety-day grammar verbatim, and
  records that it read "half a year" for a fortnight so the drift is legible rather than
  silently rewritten.
- `BirthQueuePanel.tsx:67` — "a half-year wait" is now "a ninety-day wait". The sentence's
  point is unchanged (births are measured from birth, not after a wait); only the figure the
  island retired has moved.

Nothing else in either file moves for W4-02, per the island's instruction.
