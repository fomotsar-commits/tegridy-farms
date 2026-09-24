# Agent 087 — Build Scripts Forensic Audit

**Scope:** `scripts/extract-missing-abis.mjs`, `scripts/diff-addresses.ts`, `scripts/render-og-png.mjs`, `frontend/scripts/migrate-art-imgs.mjs`, `frontend/scripts/csp-hash.mjs`

**Method:** AUDIT-ONLY — read all five scripts; checked for hardcoded backslash paths, execSync injection, dynamic-path writes (traversal), per-build vs one-shot cost, external JSON fetches, missing checksum verification, silent package.json/git mutation, `rm -rf` use, node-engine mismatch handling.

---

## Summary Counts

| Severity | Count |
|----------|-------|
| HIGH     | 0     |
| MEDIUM   | 3     |
| LOW      | 4     |
| INFO     | 3     |
| **Total**| **10**|

Hunt-list result:
- Hardcoded backslash paths: **0** (all scripts use `path.join`/`path.resolve`)
- `execSync`/shell injection: **0** (no `child_process` usage in any of the 5)
- `fs.writeFileSync` to dynamic path: **2** (migrate-art-imgs walks/overwrites all `*.tsx`/`*.jsx`; render-og-png writes 2 fixed paths but `mkdirSync({recursive:true})` on derived dir)
- Per-build vs one-shot: **all 5 are one-shot manual scripts** — none are wired into build steps; no per-build cost
- npm scripts fetching external JSON: **0** (all read local artifacts)
- Missing checksum verification: **1** (render-og-png suggests `npx --yes -p @resvg/resvg-js@2` — no integrity pin)
- Silent package.json/git mutation: **0** (none touch package.json or `.git`)
- `rm -rf`: **0**
- Node engine mismatch handling: **0 of 5** check `process.version` or `engines` field

---

## Findings

### M-087-1 — `migrate-art-imgs.mjs` is a destructive bulk rewrite with no backup or dry-run flag
**File:** `frontend/scripts/migrate-art-imgs.mjs:70`
**Severity:** MEDIUM

The script walks `frontend/src/**/*.{tsx,jsx,ts,js}` (excluding 3 hardcoded names) and calls `fs.writeFileSync(absPath, out, 'utf8')` whenever the regex matches. There is **no `--dry-run` flag, no backup, and no git-clean precondition check**. A buggy regex on a future re-run (e.g. someone tweaking `IMG_RE`) would silently corrupt every matching React file. The walker also silently skips `nakamigos/`, `ArtImg.tsx`, `ArtStudioPage.tsx` via name-equality — fragile if those files move.

**Path traversal note:** input path is fixed (`ROOT = path.resolve(__dirname, '../src')`) so traversal is bounded, but the destination set is unbounded within that tree.

**Recommendation:** add `--dry-run` (print diff, write nothing); refuse to run with a dirty git tree (`git status --porcelain`); replace name-equality skips with a proper ignore list.

---

### M-087-2 — `render-og-png.mjs` recommends unpinned, unchecksummed `npx` install in CI hint
**File:** `scripts/render-og-png.mjs:13,51`
**Severity:** MEDIUM

The header comment and the missing-dep error both tell the user to run:

```
npx --yes -p @resvg/resvg-js@2 node scripts/render-og-png.mjs
```

`npx --yes` auto-accepts the install with no integrity pin beyond the major version `@2`. If `@resvg/resvg-js` (or any of its native binary deps `@resvg/resvg-js-*`) is ever taken over, a CI runner following the docs would silently pull and execute attacker code. There is no `--ignore-scripts`, no `--prefer-offline`, no `package-lock.json` pin path documented.

**Recommendation:** either add `@resvg/resvg-js` as a real `devDependency` so it's covered by the lockfile + npm audit, or pin to a hash (`@resvg/resvg-js@2.6.2` plus `--integrity sha512-…`) in the docs. Drop `--yes` in security-sensitive environments.

---

### M-087-3 — `extract-missing-abis.mjs` overwrites a checked-in TypeScript file with no provenance, no diff gate
**File:** `scripts/extract-missing-abis.mjs:82`
**Severity:** MEDIUM

The script `writeFileSync(OUTPUT_FILE, …)` clobbers `frontend/src/lib/abi-supplement.ts` from raw `forge build` artifacts under `contracts/out/`. Risks:

1. No verification that `forge build` ran against the expected commit — a stale `out/` from a prior branch silently produces a wrong ABI committed by a tired engineer.
2. No diff/preview mode; the file is rewritten in-place.
3. No content-hash on the source artifacts — supply-chain risk if `contracts/out/` is ever cached/restored across branches in CI.
4. Header says "Do NOT hand-edit" but there is nothing in the repo (e.g. a pre-commit hook) that re-runs and checks idempotence.

**Recommendation:** print a diff vs current `abi-supplement.ts` and require `--write` to actually write; embed `solc` version + per-artifact `metadata.bytecodeHash` in the output header for traceability.

---

### L-087-4 — `csp-hash.mjs` only walks `index.html` at the script's `..` directory, breaks if frontend layout changes
**File:** `frontend/scripts/csp-hash.mjs:17`
**Severity:** LOW

`htmlPath = resolve(here, '..', 'index.html')` assumes the script lives at `frontend/scripts/csp-hash.mjs` and the file at `frontend/index.html`. If anyone moves either file, the script silently emits hashes for whatever `index.html` exists at that relative location — including, in a worst case, a stale or empty file producing an apparently-valid CSP that mismatches the deployed bundle. There is no `existsSync` guard before `readFileSync`.

**Recommendation:** validate `existsSync(htmlPath)` and assert the file contains the expected `<!doctype html>` plus a known marker (e.g. project meta tag) before hashing.

---

### L-087-5 — `diff-addresses.ts` mtime stale-check trusts local clock, no chain-id verification
**File:** `scripts/diff-addresses.ts:32,89`
**Severity:** LOW

`CHAIN_ID = '1'` is a string constant; the script does not read the `chainId` field from the broadcast JSON to verify the broadcast was actually mainnet. A tester who reused `--rpc-url` for Sepolia would still produce a `contracts/broadcast/.../1/run-latest.json` if `--chain` flag was set wrong, and this diff would happily print mainnet replacement lines pulling in testnet addresses. The 1-hour mtime guard relies on local wall clock (NTP skew).

**Recommendation:** parse `parsed.chain` (Foundry includes `"chain": 1` in the file) and compare; include the chain's `block_number` from `receipts[]` in the printed header for a quick sanity check.

---

### L-087-6 — `migrate-art-imgs.mjs` uses a stateful global regex and resets `lastIndex` manually
**File:** `frontend/scripts/migrate-art-imgs.mjs:22,88-89`
**Severity:** LOW

`IMG_RE` is declared with the `g` flag and reused both in `String.prototype.replace` (safe) and `RegExp.prototype.test` (stateful). The code does `IMG_RE.lastIndex = 0` after the test, which works today but is exactly the kind of subtle mutable-global bug that fails when a future refactor adds a worker, async iteration, or any reordering. It is also unnecessary — a non-`g` clone could be used for the test.

**Recommendation:** keep `IMG_RE` `g` only inside `replace`; declare a separate `IMG_TEST_RE = /…/s` (no `g`) for the loop probe.

---

### L-087-7 — `extract-missing-abis.mjs` strips `constructor` only — receive/fallback still leak
**File:** `scripts/extract-missing-abis.mjs:76`
**Severity:** LOW

Comment says "Strip constructor + receive/fallback for cleaner hook generation" but the filter is `(x) => x.type !== 'constructor'`. `receive` and `fallback` ABI entries pass through unchanged. The mismatch between comment and behavior is a small foot-gun for the next maintainer who reads the comment and assumes it works as advertised.

**Recommendation:** filter with `!['constructor','receive','fallback'].includes(x.type)` to match the comment, or fix the comment.

---

### I-087-8 — None of the five scripts check `engines` / `process.version`
**Severity:** INFO

All scripts assume modern Node (ESM `import`, top-level await in render-og-png, regex `/s` flag in migrate-art-imgs which requires Node 16+, `node:fs` namespaced imports requiring Node 14.18+). None do any version probe; an engineer on Node 12 would see cryptic `ERR_UNKNOWN_BUILTIN_MODULE` rather than a friendly "needs Node ≥ 18". Repo-wide `engines.node` field would mitigate (not inspected here).

---

### I-087-9 — `render-og-png.mjs` writes outside `frontend/public` to `docs/banner.png` without doc cross-link
**File:** `scripts/render-og-png.mjs:34,74-79`
**Severity:** INFO

Both output paths are constants (no traversal), but the script writes to two trees (`frontend/public/` and `docs/`) without telling the reader the second path exists in the usage docs. Minor surprise factor for the next maintainer trying to figure out why `docs/banner.png` keeps appearing.

---

### I-087-10 — `csp-hash.mjs` normalizes CRLF→LF for hashing but vercel.json hashes are not regenerated automatically
**File:** `frontend/scripts/csp-hash.mjs:22-23`
**Severity:** INFO

Correct behavior — Linux serves LF — but the script is purely advisory ("Paste the above hashes into the script-src directive in vercel.json"). There is no programmatic check that the hashes in `vercel.json` actually match what's in `index.html` at deploy time. If `index.html` changes between a developer running the script and the deploy, the live CSP will silently break inline scripts. **No CI gate exists in any of these 5 scripts to catch the drift.**

**Recommendation:** add a `--check` mode that reads `vercel.json`, finds `script-src`, and exits non-zero on mismatch. Wire that into CI.

---

## Cross-Script Observations

1. **All 5 scripts are one-shot operator-run helpers, not part of the build.** They are NOT triggered per-build, so the per-build cost concern is moot. Search for any wiring (`package.json scripts`, `vite.config`, GH Actions) to confirm — out of scope for this agent.
2. **No script touches `package.json` or git state.** No `rm -rf`. No external HTTP fetch. The supply-chain surface is limited to `@resvg/resvg-js` (M-087-2).
3. **Path handling is uniformly correct** (`path.join`/`resolve`, `fileURLToPath`, no raw backslashes).
4. **None of the destructive writers (`migrate-art-imgs`, `extract-missing-abis`) gate on a clean git tree.** A pre-write `git diff --quiet -- <target>` check would prevent silent overwrite of in-progress work.

---

## Top 3 (by reviewer-priority)

1. **M-087-1** — `migrate-art-imgs.mjs` is a silent bulk-rewriter with no dry-run, no backup, no git-clean check. Highest blast radius if regex regresses.
2. **M-087-2** — `render-og-png.mjs` documents `npx --yes` install of `@resvg/resvg-js` with no integrity pin — supply-chain foothold for any CI runner that follows the docs.
3. **M-087-3** — `extract-missing-abis.mjs` blindly overwrites `abi-supplement.ts` from `contracts/out/` with no provenance, no diff gate, no compiler-version trace; stale `out/` ⇒ wrong ABI committed.

---

*Agent 087 — AUDIT-ONLY. No source files modified.*
