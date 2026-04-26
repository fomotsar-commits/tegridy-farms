# 072 — Launchpad Components Forensic Audit

**Scope:** `frontend/src/components/launchpad/{CollectionDetail,CollectionDetailV2,OwnerAdminPanel,OwnerAdminPanelV2,launchpadConstants,launchpadShared}.{ts,tsx}` + `wizard/*`
**Mode:** AUDIT-ONLY — no code edits.
**Counts:** 1 CRITICAL · 3 HIGH · 5 MEDIUM · 4 LOW · 2 INFO · 1 DEAD-V1.

---

## CRITICAL

### C-1 — `OwnerAdminPanel.tsx` (V1) reads V2 ABI but uses V1 phase-enum literal `5` for CANCELLED → owner UX wrongly drives a V2 contract

**File:** `frontend/src/components/launchpad/OwnerAdminPanel.tsx:23-30`
**Evidence:**
```ts
const { data: onchainPhase, refetch: refetchPhase } = useReadContract({
  address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'mintPhase', ...
});
const currentPhaseNum = onchainPhase !== undefined ? Number(onchainPhase) : -1;
const isCancelled = currentPhaseNum === 5; // V1 enum had CANCELLED=5; V2 has CANCELLED=4
```
**Cross-reference:** `contracts/src/TegridyDropV2.sol:26-32`
```sol
enum MintPhase { CLOSED, ALLOWLIST, PUBLIC, DUTCH_AUCTION, CANCELLED } // CANCELLED = 4
```
**Comment in `useNFTDrop.ts:41-42` claims phase 5 = Cancelled, also wrong for V2.**

**Impact:** if a V1 detail page (still shipped in the bundle) opens a V2 drop:
- "Cancelled" badge never shows even after `cancelSale()` lands.
- `disabled={busy || isCancelled}` evaluates to `false` on a cancelled V2 sale → owner can click `setMintPhase`, `setMerkleRoot`, `reveal`, `withdraw`, `cancelSale` and submit the tx, eats gas on certain revert (UX regression + potential DoS for tooling).
- Worse: phase index 4 (V2 CANCELLED) gets labelled as "Dutch auction" by `useNFTDrop.ts:48` because that comment thinks phase 4 = Closed.

**This is the first item to fix** — even if V1 is deleted, the V1 hook bug survives in `useNFTDrop.test.ts` snapshots and any leftover routing.

---

## V1 DEAD-CODE SCAN (per memory: V1 Launchpad/Drop SHOULD be deleted)

| File | Imports referencing it (production) | Status |
|------|--------------------------------------|--------|
| `frontend/src/components/launchpad/CollectionDetail.tsx` | only self-references; **no production importer** | DEAD — only `LaunchpadSection.tsx` is the production consumer and it imports `CollectionDetailV2` (line 9). |
| `frontend/src/components/launchpad/OwnerAdminPanel.tsx` | only `CollectionDetail.tsx` (also dead) | DEAD |
| `frontend/src/hooks/useNFTDrop.ts` | only `CollectionDetail.tsx` + own test | DEAD (test alone keeps it linked) |
| `frontend/src/hooks/useNFTDrop.test.ts` | n/a | DEAD test |
| Etherscan-linked V1 factory `0x5d59…F3C2` | mentioned in `LaunchpadSection.tsx:16` for users to browse | RUNTIME OK — purely informational link, no contract calls. |

`grep` confirms zero non-test imports of `CollectionDetail` or `OwnerAdminPanel` (V1) outside the launchpad folder. Per memory `project_scope_decision.md` ("delete V1 duplicates"), these four files are dead weight and **should be removed in the bulletproofing pass**. Their continued presence ships a panel with the C-1 enum-drift bug to disk.

---

## HIGH

### H-1 — `PHASE_LABELS` drift between V1 (3 phases) and V2 admin grid

**File:** `frontend/src/components/launchpad/launchpadConstants.ts:11`
```ts
export const PHASE_LABELS = ['Paused', 'Allowlist', 'Public'] as const;
```
**Used by:** `OwnerAdminPanel.tsx:117`, `OwnerAdminPanelV2.tsx:143` to render a button grid where the index → `setMintPhase(Number(phase))`. V2 enum has 5 phases (CLOSED, ALLOWLIST, PUBLIC, DUTCH_AUCTION, CANCELLED). The grid silently omits DUTCH_AUCTION even though `OwnerAdminPanelV2` later exposes a Dutch-auction config builder. Owner cannot transition into DUTCH_AUCTION via the same panel they use for other transitions — must call `setMintPhase(3)` from a separate path.

Also: V1 panel labels phase=0 as "Paused" but V2 contract defines phase=0 as "CLOSED" (no separate paused — that's `Pausable.paused()`). Misleading owner.

### H-2 — `OwnerAdminPanelV2.tsx:75` — wrong `isCancelled` index

```ts
const currentPhaseNum = onchainPhase !== undefined ? Number(onchainPhase) : -1;
const isCancelled = currentPhaseNum === 4; // matches V2 (correct)
```
This one is correct, but it documents the drift: the V1 file says `=== 5` and the V2 file says `=== 4`. There is **no shared constant**, so the next refactor will desync again. Recommend `MINT_PHASE_CANCELLED_V2 = 4` exported from `launchpadConstants.ts`.

### H-3 — Wizard persists `deployedAddress` / `deployTxHash` to `localStorage` and re-hydrates them on mount

**File:** `frontend/src/hooks/useWizardPersist.ts:33-34` + `CreateWizard.tsx:60-61`
After a successful deploy the user has to click "Create another collection" to fire `RESET`. If they refresh first, `useDraftBanner` shows "Resume" → `handleResume` re-hydrates `deployedAddress`, taking the wizard to the post-deploy "Deployed" success card with **the previous deploy's address**. Step5 does `if (isSuccess && deployedCollection && !state.deployedAddress) dispatch(DEPLOY_SUCCESS …)` — guarded — but the persisted `deployedAddress` from an unrelated old deploy will still render as a "success" panel for the *new* draft because Step5 reads `state.deployedAddress` directly (line 87, 137). This leaks state across launches.

---

## MEDIUM

### M-1 — `Step5_Deploy.tsx:47` — `BigInt(state.maxSupply || '0')` throws on non-numeric draft input
No try/catch around `BigInt()` / `parseEther()`. A restored draft with `maxSupply = "10,000"` (comma) or `mintPrice = "0.05 eth"` (suffix) crashes the wizard during deploy click rather than surfacing a friendly error.

### M-2 — `Step2_Upload.tsx:115-147` — no client-side validation against contract caps

- `maxSupply` text input — no upper bound, contract has none either but UI shows nothing if user enters `0` (would deploy 0-supply collection). `Step5` will pass `BigInt(state.maxSupply || '0')` → contract reverts with `InvalidMaxSupply()` only after the user signs.
- `royaltyBps` slider correctly bounded `0..1000` (matches contract's `MAX_ROYALTY_BPS = 1000`, line 163 of `TegridyDropV2.sol`). OK.
- `maxPerWallet` text input — no validation; `0` reads as "unlimited" on the contract side which contradicts the on-chain semantic the panel implies.

### M-3 — `CollectionDetailV2.tsx:188` — owner-supplied `external_link` rendered as `<a href>` with no protocol allow-list

```tsx
<a href={externalLink} target="_blank" rel="noopener noreferrer">…</a>
```
`externalLink` comes from `drop.collectionMetadata?.external_link`, which is fetched off-chain from the contractURI JSON the *creator* uploaded to Arweave. A malicious creator can set `external_link: "javascript:alert(1)"` — modern browsers strip `javascript:` from `<a target="_blank">` clicks but Safari historically permitted same-tab navigation. Add an `https?://` allow-list check before rendering.

### M-4 — `Step3_Preview.tsx:22-31` — initial `useEffect` parses `csvText` but mutes parse errors with empty deps

```ts
useEffect(() => {
  try { … } catch (e) {
    dispatch({ type: 'VALIDATION_ERRORS', errors: [(e as Error).message] });
  }
}, []); // [] disables re-parse if user goes back to Step 2 and edits csvText
```
On Step3 → Step2 → Step3 round-trip, the `state.rows` reflect Step2's most recent edits (Step2 also re-parses on the fly), so this is mostly harmless, but the `// eslint-disable-next-line react-hooks/exhaustive-deps` suppresses a real bug class.

### M-5 — `OwnerAdminPanelV2.tsx:211-212` — Dutch-auction validation gap

```tsx
disabled={isCancelled || !dutchStartPrice || !dutchEndPrice || !dutchStartTime || !dutchDuration}
onClick={() => exec('configureDutchAuction', [parseEther(...), parseEther(...), BigInt(...), BigInt(...)])}
```
Contract requires `startPrice > endPrice` and `startPrice - endPrice >= duration` (`TegridyDropV2.sol:388-391`). UI doesn't enforce → owner submits invalid config, contract reverts, gas wasted.

---

## LOW

### L-1 — `Step5_Deploy.tsx:80-84` — log decoding doesn't validate `topics[2]` length

```ts
return `0x${log.topics[2]!.slice(26)}` as `0x${string}`;
```
If a future ABI change moves the event sig, `topics[2]` could be a non-address topic. Bang-assertion masks the error. Cosmetic unless the ABI drifts.

### L-2 — `CreateWizard.tsx:64-66` — `handleResume` calls `dispatch(HYDRATE)` then `setRestored(true)` — race
`hasDraft && !restored` gates the banner, but a user clicking Resume twice in <100 ms can fire two hydrates. Idempotent today (HYDRATE just merges), but flagging.

### L-3 — `OwnerAdminPanel.tsx:49` — calls `void refetchPhase()` from render path
```ts
if (isSuccess) { void refetchPhase(); }
```
Outside `useEffect`. React 18 re-runs render twice in StrictMode → double refetch each render. Same anti-pattern in `OwnerAdminPanelV2.tsx:83-87`. Move into `useEffect([isSuccess])`.

### L-4 — `Step4_FundUpload.tsx:39-42` — magic numbers
`state.rows.length * 512 + 2048` for metadata JSON byte estimate is OK but not commented for future maintainers.

---

## INFO

### I-1 — `launchpadShared.tsx:108-133` — `CreatorRevenueDashboard` uses `drop.mintPrice` × `totalMinted` to estimate revenue
Wrong for Dutch-auction collections (each mint paid different price). Only correct for fixed-price phases. Comment to that effect.

### I-2 — Wizard does not enforce contract's `InvalidInitialPhase` rule
`TegridyDropV2.sol:174` — `if (uint8(p.initialPhase) > uint8(MintPhase.DUTCH_AUCTION)) revert`. Wizard hard-codes `initialPhase: 0` (line 60 of Step5_Deploy.tsx) so this is fine today; just noting for future feature work.

---

## Top-5 Fix Priority

1. **C-1** Patch V1 panel/hook enum drift OR delete V1 files (preferred, per bulletproofing memo).
2. **H-3** Add `RESET` on `DEPLOY_SUCCESS` reducer path or scrub `deployedAddress` from persisted draft.
3. **H-1** Replace `PHASE_LABELS` with V2-aware enum array and add Dutch-auction button.
4. **M-3** Validate `external_link` protocol (`https?://` only) before rendering anchor.
5. **M-5** Add client-side guard for `configureDutchAuction` (startPrice > endPrice && startPrice−endPrice ≥ duration).

---

*Agent 072 · 101-agent forensic sweep · 2026-04-25*
