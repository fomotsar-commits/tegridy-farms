# Image pipeline + trunk CI — what shipped, what broke, what is left

**2026-09-04 / 05.** Written after a production outage caused by the work in this
sweep. Every number here was measured, and the commands that produce them are
included so the claims can be re-checked rather than believed.

---

## 1. What shipped

| PR | What it did |
|----|-------------|
| #371 | Responsive-image pipeline: generator, `lib/artSrcSet.ts`, committed manifest. Typeface swap. One wallet added. |
| #389 | Wired `artImgProps` into ~24 raw `<img>` art surfaces. avif/webp sources accepted. "A derivative must be smaller than its source" guard. Manifest gained a two-form contract. |
| #391 | The size guard only ran on the WRITE path, so a stale oversized derivative that read as `fresh` was never weighed. Applied on both paths. |
| #392 | Attempted fix for trunk CI cancellation. **Did not work — see §3.** |
| #396 | **Outage fix.** The generator was an npm `prebuild` hook; `.npmrc` sets `ignore-scripts=true`, so it never ran on Vercel. |

Measured result once the derivatives actually deployed: **63,764,269 B → 44,181,782 B
across ten routes (31% fewer image bytes)**, and 0 of 124 images broken.

---

## 2. The outage, in one paragraph

`frontend/.npmrc` sets `ignore-scripts=true` — deliberately, so transitive
dependencies cannot run install hooks next to deploy credentials. npm also skips
**your own** `pre*`/`post*` hooks under that setting. The generator was wired as
`prebuild`, so on Vercel it never ran and `public/_derived` was never created.
The manifest is *committed*, so the bundle advertised `/_derived/…` srcset
candidates for files that were not deployed. Vercel answers an unknown path with
`index.html` at **HTTP 200, `text/html`** — not a 404 — which an `<img>` cannot
decode. Result: **72 of 124 images broken across 8 routes.** Nothing failed
anywhere, because a missing optimisation looks exactly like a working image.

> **Rule: never add a `pre*`/`post*` script in `frontend/package.json`.**
> Call the step explicitly from `build`. `.gitignore`, `.npmrc` and the generator
> header all say so now.

**The guard that catches it** is `scripts/verify-dist-derivatives.mjs`, which runs
last in `build` and asks the only question that could have caught it: *does
`dist/` contain what the manifest claims?* The generator's own self-check could
not — it reads `public/_derived`, and the generator never ran. The vitest checks
could not — they skip when `public/_derived` is absent, which in CI it always is.

---

## 3. Trunk CI has been starved this whole time

`cancel-in-progress` only governs a run that is already **in progress**. A run
queued behind another in the same concurrency group is **pending**, and GitHub
evicts a pending run unconditionally when a newer run joins that group. #392 made
cancellation conditional on `pull_request` and changed nothing.

**It also made detection worse.** A run killed while pending creates **zero jobs**,
so it contributes zero check-runs — a starved commit became indistinguishable from
a verified one:

```bash
gh api .../commits/9b128dc2/check-runs --jq '[.check_runs[].conclusion]'  # pre-#392: 9x cancelled
gh api .../commits/64da51de/check-runs --jq '[.check_runs[].conclusion]'  # post:     5x success
gh api .../actions/runs/33928452677/jobs --jq .total_count                # ...but 0 jobs
```

7 of the last 12 trunk CI runs were cancelled with 0 jobs — including `64da51de`,
the merge of the outage hotfix. The fix is to stop trunk pushes sharing a group at
all (`group: … github.event_name == 'pull_request' && github.ref || github.sha`).

---

## 4. Remaining tasks

Ordered by consequence. Everything here was verified against the live repo,
GitHub, or memetics.finance.

### Open now

- [ ] **Add a monitor asserting trunk CI reached `completed/success` for each new HEAD.**
      A check-runs listing provably **cannot** detect the starvation in §3 — a
      pending-killed run leaves no trace there. This is the only durable
      detection.
      `gh api .../actions/workflows/ci.yml/runs?branch=mvp-launch&event=push`
- [ ] **`mvp-launch` has no branch protection and its only ruleset is disabled.**
      Zero required status checks, so nothing mechanically stops a red or
      unverified commit reaching production.
      `gh api repos/<owner>/<repo>/branches/mvp-launch/protection` → 404
- [ ] **Nothing prevents a `pre*`/`post*` script being re-added to `package.json`.**
      The prohibition is documented in three places and enforced in none. A tiny
      CI assertion over `package.json` keys would close it.
- [ ] **PR #400 is red** — 12 forge test slices plus `all-tests-pass` fail on a
      Solidity compilation error.
- [ ] **The two derivative guards in `artSrcSet.test.ts` skip on every CI run**
      (no build ⇒ no `public/_derived`). They are real locally and inert in CI.
      Either build before that job, or accept that
      `verify-dist-derivatives.mjs` is the only enforcement and say so.

### Known and accepted

- **Art-studio and lightbox surfaces intentionally serve originals.** They are
  curation tools; a downscale there would be a defect, not a saving.
- **Sources under the 80 KB floor get no derivatives.** Deliberate: below that a
  webp re-encode can be larger than the original.
- **`public/tokens/` is excluded from `SOURCE_DIRS`.** All 15 files are under the
  floor, so scanning it would cost a walk and produce nothing.

---

## 5. Invariants — do not break these

1. A srcset candidate that 404s **is a broken image**, not a fallback to `src`.
   The manifest must never advertise a file that is not deployed.
2. **No advertised candidate may be larger than the source it stands in for.**
   With srcset a full-bleed surface picks the smallest candidate wide enough, so
   an oversized candidate is a regression, not a saving.
3. `sizes="auto"` is **only valid on a lazy image**. On an eager one it is ignored
   and falls back to the 100vw default, which selects the original — a srcset that
   saves nothing while reading as correct. Eager surfaces must spell `sizes` out.
4. **Derived paths keep the source extension.** `/splash/new/1.avif` and
   `/splash/new/1.jpg` are separate manifest entries with different natural
   widths; without the extension they resolved to one file and silently shared it.
5. **Never a `pre*`/`post*` npm script.** See §2.
