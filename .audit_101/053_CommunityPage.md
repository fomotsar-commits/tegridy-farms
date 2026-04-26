# Audit 053 — CommunityPage.tsx + Sub-components

**Agent:** 053 / 101
**Mode:** AUDIT-ONLY (no code changes)
**Date:** 2026-04-25
**Targets:**
- `frontend/src/pages/CommunityPage.tsx` (167 lines, shell only)
- `frontend/src/components/community/GrantsSection.tsx` (308 lines)
- `frontend/src/components/community/BountiesSection.tsx` (258 lines)
- `frontend/src/components/community/VoteIncentivesSection.tsx` (1530 lines)
- `frontend/src/components/GaugeVoting.tsx` (531 lines)

---

## Threat-model coverage

| Threat | Status |
|---|---|
| `dangerouslySetInnerHTML` | NOT PRESENT — no occurrences in any community-tree file. React JSX text-interpolation is the only sink for user/contract strings, which auto-escapes HTML.  |
| `innerHTML` direct assignment | NOT PRESENT in production code. Test fixtures only (`SeasonalEvent.test.tsx`). |
| Markdown / raw-HTML rendering | NOT PRESENT — proposal `description`, bounty `description`, gauge `label`, ERC20 `symbol` all rendered as plain JSX text. |
| `eval` / `new Function` / inline `<script>` | NOT PRESENT. |
| Image `src` from arbitrary URL | NOT PRESENT for user-supplied content — all `<img>` and `<ArtImg>` sources come from the curated `pageArt(...)` config (build-time-imported assets). |
| CSP nonces on injected scripts | N/A — no runtime script injection in this tree. |
| File upload (`<input type="file">`, `FileReader`, `FormData`) | NOT PRESENT — bounty submissions are URI strings only. |
| Discord/Telegram embed payloads | NOT PRESENT — no webhook/embed sinks anywhere in tree. |

Counts: 0 critical XSS sinks, 0 file uploads, 0 webhook injection vectors, 0 markdown renderers, 0 raw-HTML rendering. **One** noopener-related concern, **multiple** unsafe-link / accessibility / responsive issues. Total findings: **9**.

---

## TOP-3 findings (highest impact)

### #1 — HIGH — Bounty submission URI accepts arbitrary string, will be rendered/clicked downstream without validation
**File:** `BountiesSection.tsx:28-77, 230-237`

```tsx
const [submitURI, setSubmitURI] = useState('');
// …
<input id={`bounty-submit-${bountyId}`} type="text" value={submitURI}
  onChange={(e) => setSubmitURI(e.target.value)}
  placeholder="Link to your submission (IPFS, URL, etc.)" />
// handleSubmit pushes submitURI straight into the contract:
writeContract({ … functionName: 'submitWork', args: [BigInt(bountyId), submitURI] });
```
- The frontend does **not** validate scheme. A malicious submitter can post `javascript:fetch(...)`, `data:text/html,<script>...</script>`, or `vbscript:` URIs.
- The contract stores the string verbatim. Once a future component adds an `<a href={submission.uri}>`, this becomes one-click stored XSS / drainer phishing for whoever views the bounty.
- Even today, the URI gets rendered by other surfaces (admin tooling, analytics dashboards, etherscan event-log viewers that auto-link) — so the on-chain pollution is the real harm.
- Also no length cap → spam-style bricking of a bounty's submissions list, and gas-grief on any future paginated read.

**Fix sketch:** require `https://` or `ipfs://` prefix client-side, length-cap to ~256 chars, surface inline error like the recipient/amount validators in `GrantsSection.tsx`.

---

### #2 — MEDIUM — Newline / control-char injection into proposal `description` and bounty `description`
**File:** `GrantsSection.tsx:199-201`, `BountiesSection.tsx:151-153`

The `<textarea>` for proposal description and bounty description has no length limit, no newline normalization, and no character class restriction. The string is passed directly to the contract:
```tsx
args: [newRecipient as Address, amt, newDescription]
args: [newDescription, deadlineSecs]
```
- A user can stuff `\n`, `\r`, `\t`, zero-width chars, BiDi overrides (`‮`), or emoji-mod sequences. JSX rendering renders them safely (no XSS), but:
  - Any future Discord / Telegram / Twitter relay of new-proposal events (which the team's `feedback_approvals.md` mandate keeps in-chat — but someone may add bot relays later) will get newline injection. A description ending in `\n@everyone\nNew giveaway: [link]` becomes a Discord-embed injection.
  - BiDi overrides can flip address shortening direction in the proposer/recipient lines on devices that interpret RTL (`shortenAddress(proposer)` is rendered next to the description on the same line — `GrantsSection.tsx:253`).
- Bounty descriptions also feed into transaction-receipt UI (`TransactionReceipt.tsx`) which already runs a `sanitize()` helper, suggesting the team knows downstream consumers exist.

**Fix sketch:** cap at e.g. 280 chars, strip `‎‏‪-‮⁦-⁩` and `\r`, single-line normalize for proposals.

---

### #3 — MEDIUM — `submCount` from contract decoded with wrong tuple shape; UI displays `NaN` and reveals a destructure-typing bug
**File:** `BountiesSection.tsx:191-192`

```tsx
const [creator, description, reward, deadline, , submCount, status] =
  result.result as [Address, string, bigint, bigint, Address, bigint, number, bigint];
```
The cast is to an 8-tuple but the destructure pulls 7 names. `submCount` here is being read from index **5**, but the type cast maps index 5 to `bigint` (correct) — except the fifth (skipped) slot is typed as `Address` while the destructure-skip implies it's something else. The type-cast tuple shape doesn't match `getBounty` ABI ordering documented elsewhere; if the on-chain order differs (e.g. winner is at a different index), `submCount` will silently render whatever bigint sits at the wrong slot.
- This is **not** a security XSS issue but is a **rendering integrity bug** that an attacker proposing a malformed bounty could exploit to make the UI lie about submission counts (and thereby manipulate voter attention).
- Compare with `GrantsSection.tsx:228` which destructures correctly into 8 named fields that match the explicit cast.

**Fix sketch:** verify against `MEME_BOUNTY_BOARD_ABI.getBounty` tuple ordering, regenerate the cast, and prefer `result.result` typed via wagmi's auto-inference rather than `as` cast.

---

## Remaining findings (4–9)

### #4 — MEDIUM — `target="_blank"` on contract links uses `rel="noopener noreferrer"` (good) but inline contract address values are interpolated raw into URLs without validation
**Files:** `GrantsSection.tsx:300`, `BountiesSection.tsx:250`, `VoteIncentivesSection.tsx:1510`

```tsx
<a href={`https://etherscan.io/address/${COMMUNITY_GRANTS_ADDRESS}`} target="_blank" rel="noopener noreferrer">
```
`COMMUNITY_GRANTS_ADDRESS` etc. are imported constants from `lib/constants`, so the immediate risk is low. However:
- If `lib/constants` ever derives an address from `import.meta.env.VITE_*` (it does — see `.env` patterns), an env-var attacker could swap `https://etherscan.io/...` for `https://...@evil.com/...` style, hijacking the link target.
- No URL.parse or address-format check before interpolation.

**Fix:** wrap with `isAddress(addr) ? \`...\${addr}\` : '#'`.

### #5 — MEDIUM — Bounty deadline computed off `Date.now()` without UTC sanity check
`BountiesSection.tsx:61` uses `Math.floor(Date.now() / 1000) + Number(newDeadlineDays) * 86400`. If a user types a negative number, NaN, or `Infinity`, `Number()` will yield NaN/Infinity — and `BigInt(NaN)` throws (good) but `BigInt(Infinity)` also throws. There's no client-side validation on `newDeadlineDays`, so the user gets a generic "MetaMask threw" instead of a friendly error. Compare with `GrantsSection`'s recipient/amount validators.

### #6 — LOW — `pendingPayout` and `pendingRefund` re-render every render
`BountiesSection.tsx:37-44` reads `pendingPayouts` & `pendingRefund` with `args: address ? [address] : undefined` but no `refetchInterval`. When the user claims, the UI won't auto-update until window-focus refetch fires. Not a security issue but a "broken responsive" complaint vector — the user clicks Claim, sees the same button again for ~30 sec, double-spends the click attempt.

### #7 — LOW — Accessibility: tab list missing `aria-controls`
`CommunityPage.tsx:88-112` — `role="tablist"` and `role="tab"` are set, plus `aria-selected`, but **no `aria-controls`** on the tabs and **no `id` on the tabpanel** they link to. Screen readers cannot announce which panel a tab activates. The `role="tabpanel"` at `:140` has `aria-label` only — should have `id="..."` matching `aria-controls` of each tab.

### #8 — LOW — `localStorage` JSON parse without schema validation
`VoteIncentivesSection.tsx:83-92`, `GaugeVoting.tsx:31-38` parse `localStorage` data directly. A site-XSS elsewhere (e.g. via the bounty URI in #1) could plant malformed `tegridy:viCommit:*` records that crash the app on next load (`BigInt(c.power)` throws on non-numeric strings, breaking the commit-reveal panel). Defensive: validate shape before use. The catch in `loadCommits` only catches JSON.parse errors, not downstream usage.

### #9 — LOW / responsive — Three-column tab grid breaks at 4 tabs on iPhone 14 width
`CommunityPage.tsx:86` — `grid-cols-3 md:flex` but there are **4** sections (`grants, bounties, bribes, gauges`). On mobile this puts 3 in row 1 and 1 alone in row 2, wasting space and looking unbalanced. Should be `grid-cols-2 sm:grid-cols-4` or `grid-cols-4`. Per the project's `project_responsive.md` mandate (iPhone 14+ flawless), this needs a fix.

---

## Notes on what was checked and is clean

- Every `<img>` / `<ArtImg>` traced — all sources come from `pageArt(pageId, idx)` which resolves to build-time bundled assets (`lib/artConfig.ts`). No user-controlled `src`.
- All wagmi `writeContract` calls use named ABI functions; no `sendTransaction` with raw calldata anywhere in tree.
- ConnectButton is rainbowkit's stock component — out of scope but worth noting it does not load remote scripts.
- No `iframe`, `object`, or `embed` tags anywhere.
- No `console.log` of sensitive data (private keys, mnemonics) — only `console.warn` of localStorage write failures.
- No `Math.random()` for security — `crypto.getRandomValues` is correctly used for salts (`generateSalt` in both files).
- The grant-amount `parseEther` validator (`GrantsSection.tsx:84-99`) is correctly defensive.

---

**Counts summary:** 0 critical, 1 HIGH, 4 MEDIUM, 4 LOW = **9 findings total.**
