# Remediation Plan — g05_nftfinance (NFT-Finance hub: lending + launchpad + AMM + restake)

Surface: `/nft-finance` (`src/pages/LendingPage.tsx`) and its four sections — Token Lending (`LendingSection.tsx`), NFT Lending (`NFTLendingSection.tsx`), NFT AMM (`AMMSection.tsx`), Launchpad (`LaunchpadSection.tsx` + `launchpad/*`).

All paths below are absolute under `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend`. Every finding was opened and confirmed at HEAD of `mvp-launch` (2026-06-13). 66 findings: many cluster onto a handful of shared fixes (logged-out read-only render, `text-black` token regression, shared `safeParseEther`/revert-decoder routing, dispatch-in-render, NFT metadata resolver). Fixing those causes once closes large groups.

Key cross-cutting context confirmed in code:
- All four section contracts are zeroed in `src/lib/constants.ts` (`TEGRIDY_LENDING_ADDRESS` L47, `TEGRIDY_NFT_LENDING_ADDRESS` L54, `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` L50, `TEGRIDY_LAUNCHPAD_V2_ADDRESS` L67). So most "wrong write" findings are latent until the un-gate, but they ship with it and must be fixed before deploy.
- `src/lib/safeParseEther.ts`, `src/lib/revertDecoder.ts`, `src/lib/nftMetadata.ts`, `src/components/ui/FeatureNotDeployed.tsx` already exist and are the canonical helpers to reuse.

---

## Batch: logged-out-readonly  (F280, F287, F300, F299, F302, F313)
Summary: The whole page is wallet-gated (`LendingPage.tsx:219` `!isConnected ? <ConnectPrompt/> : <sections>`), so every read-only surface (offer book, pool explorer, collection list, stats, HowItWorks) is hidden and the honest "being audited / not deployed" messaging only renders post-connect — a bait-and-switch. The single underlying fix: render sections read-only when disconnected and gate only the action buttons. The sections already take a `deployed` prop and most action buttons already handle `!address`. Do this once and the connect-wall honesty + ultrawide-density findings largely resolve.

### F299  (high · standalone within batch)
- verdict: fix-now
- rootCause: T7
- approach: In `LendingPage.tsx` stop early-returning `<ConnectPrompt>` for the whole panel; render the section (or its pre-deploy `FeatureNotDeployed`/amber banner) for disconnected users too, so the "being audited, deploying soon" status shows before connect. Add a small `SOON` badge to the tab pills and to `SECTION_PROMPTS` headers. Keep the Connect CTA inside each section's action area.
- files: `src/pages/LendingPage.tsx:219-242`, `src/pages/LendingPage.tsx:28-49`, `src/pages/LendingPage.tsx:194-216`
- effort: M
- risk: med
- test: Manual: disconnect wallet, visit each tab — confirm pre-deploy status + read-only UI render, no transactional button fires. Extend `ConnectPrompt.test.tsx` pattern with a disconnected-render test for `LendingPage`.
- deps: []
- batchHint: logged-out-readonly

### F300  (high)
- verdict: fix-now
- rootCause: T7
- approach: Same un-gate as F299 — render each section's `StatsBar`/`HowItWorks`/offer tables/`BondingCurveChart` explainer/collection list for disconnected users (reads need no account). The blurred mock-offer `ComingSoonState`/`ComingSoon` dead exports can stay as-is (additive). Gate only Lend/Borrow/Accept/Repay/Deploy buttons behind connect using the existing `!address` button states.
- files: `src/pages/LendingPage.tsx:219-242`, `src/components/nftfinance/LendingSection.tsx:1852-1889`, `src/components/nftfinance/AMMSection.tsx:2659-2697`, `src/components/nftfinance/LaunchpadSection.tsx:122-221`
- effort: M
- risk: med
- test: Disconnected, confirm offer book / pool explorer / collection list / stats visible; connect, confirm action buttons enable. No new RPC against zero addresses (reads stay gated on `deployed`).
- deps: [F255]
- batchHint: logged-out-readonly

### F287  (low)
- verdict: duplicate
- rootCause: T7
- approach: Same fix as F299/F300 (missing-vs-best-in-class restatement of the logged-out browsing gap). No separate work — closes when the un-gate lands.
- files: `src/pages/LendingPage.tsx:219-242`
- effort: S
- risk: low
- test: Covered by F300 verification.
- deps: [F300]
- batchHint: logged-out-readonly

### F280  (medium)
- verdict: duplicate
- rootCause: T7
- approach: Same underlying fix as F299/F300 (this is the code-side framing of the same wallet-gate). Track under the un-gate; no independent change.
- files: `src/pages/LendingPage.tsx:219-224`
- effort: S
- risk: low
- test: Covered by F300.
- deps: [F300]
- batchHint: logged-out-readonly

### F302  (medium)
- verdict: fix-now
- rootCause: T4
- approach: Correct the lending gate copy to match the actual mechanic. In `LendingPage.tsx` `SECTION_PROMPTS.lending` change "lend & borrow TOWELI"/"Supply TOWELI for yield" to "lend ETH against staked-TOWELI position NFTs; restake for bonus rewards". In `ConnectPrompt.tsx` `DEFAULTS.lending` (L38-43) drop the stray "JBAY Gold NFTs" mention (the page set is JBAC/Nakamigos/GNSS). Aligns with the already-correct `INTRO_CARDS` lending desc (`LendingPage.tsx:55`).
- files: `src/pages/LendingPage.tsx:29-33`, `src/components/ui/ConnectPrompt.tsx:38-43`
- effort: S
- risk: low
- test: Manual copy review on the Token Lending gate + ConnectPrompt fallback.
- deps: []
- batchHint: logged-out-readonly

### F313  (polish)
- verdict: fix-now
- rootCause: T7
- approach: On wide viewports, flank the connect card additively with the existing `HowItWorks` steps and a stats/preview column (already present in code as `StatsBar` + blurred mock-offer table). Largely free once F300 renders read-only sections beside the connect CTA. Keep the museum art backdrop.
- files: `src/pages/LendingPage.tsx:219-242`, `src/components/ui/ConnectPrompt.tsx:63-68`
- effort: M
- risk: low
- test: Manual on 1710px viewport — confirm side space carries stats/HowItWorks, no stretched gutters, art preserved.
- deps: [F300]
- batchHint: logged-out-readonly

---

## Batch: text-black-token-restore  (F256)
Summary: A find/replace regression left `text-black` tokens on dark surfaces across `LendingSection.tsx` (LTV "safe" color, repaid badge, APR cells, Estimated Earnings, EmptyState icon, P&L figures). The sibling `NFTLendingSection.tsx` already uses `text-emerald-400` for the same semantics. One sweep restores readable tokens — additive, no art touched.

### F256  (medium)
- verdict: fix-now
- rootCause: standalone
- approach: Replace the regressed `text-black` semantic tokens with the emerald/status colors that match the bars and the sibling section: LTV-safe → `text-emerald-400` (matches `#34d399` bar at L1215), `STATUS_COLORS.repaid.text` → `text-emerald-400`, APR cells → `text-emerald-400`/`text-white`, Estimated Earnings + P&L Interest-Earned/Net-positive → `text-emerald-400`, `EmptyState` icon → a visible token. Leave genuinely-on-light pills (e.g. emerald-button labels) alone — only fix black-on-dark. Confirmed instances: L168, L249, L310, L387, L411, L424, L434, L822, L900, L1068, L1124, L1445, L1453, L1466, L1599.
- files: `src/components/nftfinance/LendingSection.tsx:168`, `src/components/nftfinance/LendingSection.tsx:249`, `src/components/nftfinance/LendingSection.tsx:310`, `src/components/nftfinance/LendingSection.tsx:822`, `src/components/nftfinance/LendingSection.tsx:900`, `src/components/nftfinance/LendingSection.tsx:1068`, `src/components/nftfinance/LendingSection.tsx:1124`, `src/components/nftfinance/LendingSection.tsx:1445`, `src/components/nftfinance/LendingSection.tsx:1453`, `src/components/nftfinance/LendingSection.tsx:1466`, `src/components/nftfinance/LendingSection.tsx:1599`
- effort: S
- risk: low
- test: Manual visual pass on Token Lending in both themes — LTV-safe text now matches its green bar; repaid badge / APR cells / earnings legible. Optional: snapshot test asserting no `text-black` remains in `LendingSection.tsx`.
- deps: []
- batchHint: text-black-token-restore

---

## Batch: read-enable-gates  (F255)
Summary: `LendingSection.tsx` is the one section that fires contract reads against the zeroed `TEGRIDY_LENDING_ADDRESS` with no `enabled` gate (protocolFeeBps, offerCount, loanCount) — eth_call to 0x0 returns `0x`, decode fails, react-query retries. `NFTLendingSection`/`LaunchpadSection` already gate the identical reads.

### F255  (medium)
- verdict: fix-now
- rootCause: T9
- approach: Add `query: { enabled: isDeployed(TEGRIDY_LENDING_ADDRESS) }` (helper already imported, L11) to the three reads. Note `useAllOffers`/`useAllLoans` are module-level hooks so compute `deployed` inline via `isDeployed(...)` rather than threading the prop. Mirrors `NFTLendingSection.tsx:110/116/122`.
- files: `src/components/nftfinance/LendingSection.tsx:457-461`, `src/components/nftfinance/LendingSection.tsx:1743-1747`, `src/components/nftfinance/LendingSection.tsx:1794-1798`
- effort: S
- risk: low
- test: Disconnected/zero-address, open devtools network — confirm no eth_call to `0x0000...` and no retry churn from this section.
- deps: []
- batchHint: read-enable-gates

---

## Batch: refetch-after-write  (F257)
Summary: Create/accept success handlers in both lending sections only toast + clear/collapse; the offer & loan batch reads (`useAllOffers`/`useAllLoans`, `BorrowTab`/`MyLoansTab` reads) have no watch/refetchInterval and are never invalidated, so the market and My Loans stay stale until a full reload.

### F257  (medium)
- verdict: fix-now
- rootCause: T5
- approach: On each `isSuccess`, invalidate the offer/loan reads. Cleanest: have `useAllOffers`/`useAllLoans` expose their `refetch` (wagmi returns it from `useReadContract`/`useReadContracts`) up to `LendingSection`, pass down to the create/accept/repay handlers, and call after success — or use a `queryClient.invalidateQueries` keyed on the wagmi read query keys. Mirror in `NFTLendingSection` (`LendTab` success L253-261, `OfferCard` accept L682-686, `LoanCard` repay L960-966).
- files: `src/components/nftfinance/LendingSection.tsx:715-723`, `src/components/nftfinance/LendingSection.tsx:1003-1012`, `src/components/nftfinance/LendingSection.tsx:1742-1842`, `src/components/nftfinance/NFTLendingSection.tsx:253-261`, `src/components/nftfinance/NFTLendingSection.tsx:682-686`
- effort: M
- risk: med
- test: With a deployed/testnet contract (or mocked reads): create an offer → confirm it appears in Borrow without reload; accept → confirm it leaves the available list and appears under My Loans.
- deps: []
- batchHint: refetch-after-write

---

## Batch: grace-period-loan-states  (F253, F254)
Summary: Both lending UIs derive loan status from the local wall clock (`Date.now() > deadline`) and key affordances off it, contradicting the on-chain grace period. Borrowers lose the Repay button the instant the clock passes (F253); lenders see Claim during grace when the claim would revert (F254). The contract exposes `isDefaulted`/grace state — drive the buttons off that.

### F253  (medium)
- verdict: fix-now
- rootCause: standalone
- approach: In `NFTLendingSection` `LoanCard`, keep Repay (and the `getRepaymentAmount` read) enabled while `status === 'overdue'` until `defaultClaimed`, mirroring `LendingSection.tsx:1629` (`status === 'active' || status === 'overdue'`). Change the read `enabled` at L948 and the button guard at L1091 accordingly. Ideally read the contract's grace/`isDefaulted` flag rather than the local clock.
- files: `src/components/nftfinance/NFTLendingSection.tsx:948`, `src/components/nftfinance/NFTLendingSection.tsx:1091`
- effort: S
- risk: med
- test: With a loan seconds past deadline (still in 1h grace), confirm Repay still renders and `getRepaymentAmount` is fetched; a repay tx succeeds in grace.
- deps: []
- batchHint: grace-period-loan-states

### F254  (medium)
- verdict: fix-now
- rootCause: standalone
- approach: In `LendingSection` `LoanRow`, require `defaulted === true` to enable Claim Collateral instead of OR-ing with local `status === 'overdue'` (L1640). The `isDefaulted` read already exists (L1526-1532). While overdue-but-in-grace, render a disabled state with a "grace period — claimable in Xm" countdown (reuse `useCountdown`).
- files: `src/components/nftfinance/LendingSection.tsx:1640`, `src/components/nftfinance/LendingSection.tsx:1526-1532`
- effort: S
- risk: med
- test: Loan in grace (defaulted=false, overdue=true) → Claim disabled w/ countdown; once `isDefaulted` true → Claim enabled and succeeds.
- deps: []
- batchHint: grace-period-loan-states

---

## Batch: price-unavailable-ltv  (F260)
Summary: `LendingSection` Borrow computes `positionEthValue` from `useTOWELIPrice().priceInEth` without checking `priceUnavailable`/`oracleStale` (both exposed by `PriceContext`), so when the TOWELI/WETH pool is empty (the current live state) Position Value shows `0 ETH` and LTV `0.0%` — reading as zero-risk instead of "price unavailable".

### F260  (medium)
- verdict: fix-now
- rootCause: T6
- approach: Destructure `priceUnavailable`/`oracleStale` from `useTOWELIPrice()` (already consumed at L1047). When either is set, render "price unavailable" for Position Value and suppress the LTV number + bar (don't show `0.0%`). `computeLTV` already returns `{ratio:0}` for non-finite/≤0 — branch the render on the flag rather than on the zero.
- files: `src/components/nftfinance/LendingSection.tsx:1047-1055`, `src/components/nftfinance/LendingSection.tsx:1189-1219`, `src/contexts/PriceContext.tsx:23-24`
- effort: S
- risk: low
- test: Force `priceUnavailable` (empty pool) — confirm Position Value/LTV show "price unavailable", not 0.
- deps: []
- batchHint: price-unavailable-ltv

---

## Batch: safe-input-parsing  (F267)
Summary: Several click handlers call `parseEther`/`BigInt` directly on number-input strings (`1e-19`, `1.5`, `1e4`) that viem/BigInt reject by throwing — the handler dies silently with no toast. The repo's `lib/safeParseEther.ts` exists for exactly this and is used elsewhere.

### F267  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Route the raw conversions through `safeParseEther` (and a safe-BigInt wrapper) with a toast on invalid input. Sites: `LendingSection` create-offer (`parseEther(principal)` L746, `parseEther(minCollateral)`/`parseEther(minCollateralETH||'0')` L765-767); `OwnerAdminPanelV2` `parseEther(mintPrice)` L267 and `BigInt(maxPerWallet)` L280.
- files: `src/components/nftfinance/LendingSection.tsx:746`, `src/components/nftfinance/LendingSection.tsx:765-767`, `src/components/launchpad/OwnerAdminPanelV2.tsx:267`, `src/components/launchpad/OwnerAdminPanelV2.tsx:280`, `src/lib/safeParseEther.ts`
- effort: S
- risk: low
- test: Extend `safeParseEther.test.ts` if needed; manually type `1e-19`/`1.5` and confirm a toast appears instead of a dead button.
- deps: []
- batchHint: safe-input-parsing

---

## Batch: launchpad-wizard-fixes  (F251, F252, F262, F266)
Summary: The create-collection wizard has four independent defects — draft auto-save clobbers the saved draft (F251), Step5 dispatches in render + builds tx config outside try/catch with no maxSupply validation (F252), Step4 reuses a stale Arweave quote after the image set grows (F262), and Step2 computes validation warnings then throws them away (F266). Grouped since they touch the same wizard tree and ship together.

### F251  (high)
- verdict: fix-now
- rootCause: T5
- approach: Gate the first persist behind a "dirty" flag. In `useWizardPersist`, skip writing while `state` deep-equals `initialState` (or set a `dirty` ref on the first non-HYDRATE action and only persist when dirty). This stops the 500ms throttled effect (`useWizardPersist.ts:74-91`) from overwriting a restored draft with `initialState` before the user clicks Resume (`CreateWizard.tsx:38` reads at click time).
- files: `src/hooks/useWizardPersist.ts:71-92`, `src/components/launchpad/wizard/CreateWizard.tsx:33-67`
- effort: S
- risk: med
- test: Open wizard, fill fields, reload, wait >1s, click Resume — confirm fields/manifest IDs/step restore (not an empty step-1 wizard). Add a unit test on `useWizardPersist` asserting no write occurs for `initialState`.
- deps: []
- batchHint: launchpad-wizard-fixes

### F252  (medium)
- verdict: fix-now
- rootCause: standalone
- approach: Move the `DEPLOY_SUCCESS` dispatch (`Step5_Deploy.tsx:95-101`) into `useEffect(()=>{...},[isSuccess, deployedCollection])`. Move `cfg` construction (L51-68) inside the `try` so a bad `parseEther`/`BigInt` is caught and surfaced via `setLocalErr`. Add validation: `maxSupply >= 1`, `maxPerWallet <= maxSupply`, before enabling Deploy (the button at L170-173 / `handleDeploy` L31).
- files: `src/components/launchpad/wizard/Step5_Deploy.tsx:51-101`, `src/components/launchpad/wizard/Step5_Deploy.tsx:170-173`
- effort: S
- risk: low
- test: Type `1e4`/`0.0.5` into mint price and clear maxSupply — confirm Deploy disabled / error toast, no React "update during render" warning in console.
- deps: []
- batchHint: launchpad-wizard-fixes

### F262  (medium)
- verdict: fix-now
- rootCause: T5
- approach: Store the byte total alongside `quoteWei` (in wizard state) and re-quote when `bytesToPay` differs from the quoted byte count — or simply always re-quote on Step 4 entry (quoting is free). Currently `Step4_FundUpload.tsx:57-59` short-circuits to `quoted` whenever a quote exists, ignoring a now-larger `bytesToPay` (L39-42).
- files: `src/components/launchpad/wizard/Step4_FundUpload.tsx:39-62`, `src/components/launchpad/wizard/wizardReducer.ts`
- effort: S
- risk: med
- test: Quote in Step 4, go back to Step 2, add images, return — confirm a fresh quote covering the larger folder (buffered 20%), not the stale one.
- deps: []
- batchHint: launchpad-wizard-fixes

### F266  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Dispatch the merged `warnings` from Step 2, not just `errors`. Extend the `VALIDATION_ERRORS` payload (or add a `VALIDATION_WARNINGS` action) so the "N uploaded file(s) not referenced in CSV" warning built at `Step2_Upload.tsx:27-44` reaches `state.validationWarnings` and the warning surface (currently only Step 3's CSV_PARSED sets it).
- files: `src/components/launchpad/wizard/Step2_Upload.tsx:26-53`, `src/components/launchpad/wizard/wizardReducer.ts`
- effort: S
- risk: low
- test: Upload more images than CSV rows — confirm the "not referenced in CSV" warning renders in Step 2.
- deps: []
- batchHint: launchpad-wizard-fixes

---

## Batch: admin-panel-fixes  (F250, F276)
Summary: `OwnerAdminPanelV2` fires refetches in the render body (render/refetch loop, F250) and uses dev-grade inputs for money-critical admin actions (raw unix timestamp, no on-chain phase highlight, native `window.confirm` instead of the app's `TypedConfirmation`, F276). Latent while the launchpad is zeroed but ships with the un-gate.

### F250  (high)
- verdict: fix-now
- rootCause: T5
- approach: Move the post-tx refetches into `useEffect(()=>{ if(isSuccess){refetchPhase();refetchContractURI();refetchPaused();} },[isSuccess])`. Currently `OwnerAdminPanelV2.tsx:84-88` sits in the render body; `isSuccess` stays true so each refetch → re-render → refetch indefinitely. Matches the sibling pattern (`LendingSection.tsx:715`, `AMMSection.tsx:1471`).
- files: `src/components/launchpad/OwnerAdminPanelV2.tsx:84-88`
- effort: S
- risk: low
- test: With a deployed drop, run any admin tx — confirm a single refetch burst (network panel), not a loop.
- deps: []
- batchHint: admin-panel-fixes

### F276  (low)
- verdict: fix-now
- rootCause: T10
- approach: Replace the bare `Start (unix)` field with a `datetime-local` input converted to unix on submit (add a "now + 1h" hint). In the phase grid (L181-194) pre-select/highlight `currentPhaseNum` (already fetched at L75) so a stray "Set Phase" click can't silently close a live mint. Swap the `window.confirm` cancelSale (L407-411) for `src/components/ui/TypedConfirmation.tsx`.
- files: `src/components/launchpad/OwnerAdminPanelV2.tsx:181-194`, `src/components/launchpad/OwnerAdminPanelV2.tsx:303-309`, `src/components/launchpad/OwnerAdminPanelV2.tsx:399-415`, `src/components/ui/TypedConfirmation.tsx`
- effort: M
- risk: med
- test: Dutch start accepts a datetime and submits correct unix; phase grid highlights on-chain phase on open; cancelSale requires typed confirmation.
- deps: []
- batchHint: admin-panel-fixes

---

## Batch: amm-pool-safety  (F249, F259, F263)
Summary: AMM My Pools / pool cards have three real defects: My Pools bypasses the deploy gate and forces `isOwner` for any tracked address while claiming "ownership verified on-chain" (F249); a pool that fails `getPoolInfo` (e.g. tracked against a dead pre-relaunch factory) pulses forever with no error state (F259); and `autoTracked` never resets so a 2nd pool in a session isn't auto-tracked (F263).

### F249  (high)
- verdict: fix-now
- rootCause: standalone
- approach: Three changes in `AMMSection.tsx`: (1) respect the discarded `deployed` flag in `MyPoolsTab` (L2466) — disable Track + render `FeatureNotDeployed` (or read-only cards) when not deployed. (2) Stop forcing `isOwner` on `PoolCard` (L2557) — derive `showOwnerControls` from `poolInfo.owner === address` only (drop the unconditional `isOwner` prop; `poolOwnerIsUser` at L1495 already does the correct check). (3) Before tracking (`handleAddPool` L2471), verify `getBytecode(addr) !== '0x'` and `factory.isPool(addr)` (or that `getPoolInfo` decodes) so the "Pool ownership is verified on-chain" copy (L2518) becomes true. This also closes the latent value-write path (`addLiquidity` with `value: parseEther(liqEth)` at L1511) firing against an unverified/non-pool address.
- files: `src/components/nftfinance/AMMSection.tsx:2466`, `src/components/nftfinance/AMMSection.tsx:2471-2476`, `src/components/nftfinance/AMMSection.tsx:2518`, `src/components/nftfinance/AMMSection.tsx:2557`, `src/components/nftfinance/AMMSection.tsx:1495-1496`
- effort: M
- risk: med
- test: Track a pool whose `owner` ≠ connected wallet → confirm no owner controls (Manage Liquidity / Pool Settings / Emergency Drain) appear. Track a non-pool/EOA address → rejected with "not a verified pool". When factory zeroed → Track disabled.
- deps: []
- batchHint: amm-pool-safety

### F259  (medium)
- verdict: fix-now
- rootCause: T11
- approach: In `PoolCard`, consume `useReadContract` `isError`. Branch: `isError` → compact "Pool unreachable (old deployment?) — remove from tracking" card with the existing remove affordance, instead of the only-non-data `!poolInfo` infinite skeleton at `AMMSection.tsx:1483-1490`. Pre-relaunch pools in `localStorage` ('tegridy-amm-tracked-pools') currently pulse forever.
- files: `src/components/nftfinance/AMMSection.tsx:1452-1490`
- effort: S
- risk: low
- test: Track a dead/old factory pool address → confirm an error card (not endless pulse) with a working remove button.
- deps: []
- batchHint: amm-pool-safety

### F263  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Reset/replace the one-shot `autoTracked` boolean so a second deploy in the same session still auto-tracks. Either add an effect that clears `autoTracked` when a new `deployTx` hash appears, or key the guard on `deployReceipt.transactionHash` instead of a boolean (the early-return at `AMMSection.tsx:1959` currently never re-arms).
- files: `src/components/nftfinance/AMMSection.tsx:1917`, `src/components/nftfinance/AMMSection.tsx:1958-1983`
- effort: S
- risk: low
- test: Deploy two pools in one session — confirm both auto-track + toast.
- deps: []
- batchHint: amm-pool-safety

---

## Batch: stat-label-accuracy  (F264)
Summary: Stat labels/tooltips disagree with their numbers — Token Lending "Total Offers" = `allOffers.length` (includes inactive) under a tooltip claiming "active" offers; NFT Lending "Active Loans" = total `loanCount` (includes repaid/defaulted).

### F264  (low)
- verdict: fix-now
- rootCause: standalone
- approach: In `LendingSection` `StatsBar`, count `allOffers.filter(o=>o.active).length` for the offer stat (or relabel to "Total Offers (incl. inactive)"). In `NFTLendingSection`, either relabel `loanCount` to "Total Loans" or filter parsed loans by `getLoanStatus` for an "Active Loans" count.
- files: `src/components/nftfinance/LendingSection.tsx:451`, `src/components/nftfinance/LendingSection.tsx:478-480`, `src/components/nftfinance/NFTLendingSection.tsx:160`
- effort: S
- risk: low
- test: With mixed active/inactive offers + repaid loans, confirm the numbers match their labels.
- deps: []
- batchHint: stat-label-accuracy

---

## Batch: refund-toast-wording  (F265)
Summary: `useNFTDropV2`'s single tx-result effect toasts "Mint confirmed!"/"Mint failed" for every write through the hook, including `refund()` — a user pulling funds from a cancelled sale sees "Mint confirmed!".

### F265  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Track the last action in a ref (`'mint' | 'refund'`) set in `mint()`/`refund()`, and word the success/error toasts in the effect (`useNFTDropV2.ts:225-236`) off that ref.
- files: `src/hooks/useNFTDropV2.ts:184-236`
- effort: S
- risk: low
- test: Trigger a refund on a cancelled sale → toast says "Refund confirmed", not "Mint confirmed!".
- deps: []
- batchHint: refund-toast-wording

---

## Batch: lender-earnings-accuracy  (F268, F270)
Summary: Two preview/figure overstatements: lender earnings ignore the protocol fee the same card advertises and PnL assumes full-term interest for early repayments (F268); launchpad "Total Revenue" = `mintPrice × totalMinted`, wrong for Dutch-auction/repriced drops (F270).

### F268  (low)
- verdict: fix-now
- rootCause: T3
- approach: Net `estimatedEarnings` (`LendingSection.tsx:726-732`) by `protocolFeeBps` (already fetched in `StatsBar`; thread it down or read in `LendTab`). Label `PnlSummaryCard` figures (L1417-1437) as "max (full-term) estimate" since they use `deadline - startTime` rather than actual pro-rata repayment, or derive realized interest from repayment events when available.
- files: `src/components/nftfinance/LendingSection.tsx:726-732`, `src/components/nftfinance/LendingSection.tsx:1417-1437`, `src/components/nftfinance/LendingSection.tsx:907-911`
- effort: M
- risk: low
- test: Create an offer and verify the preview earnings = gross − protocol fee; PnL labelled as full-term estimate.
- deps: []
- batchHint: lender-earnings-accuracy

### F270  (low)
- verdict: fix-now
- rootCause: T3
- approach: In `launchpadShared.tsx` `CreatorRevenueDashboard`, relabel the figure "Est. revenue (flat-price)" (the `mintPrice * totalMinted` computation at L272) — or compute from the contract's actual proceeds/`paidPerWallet` sums when the ABI exposes them. Don't present it unqualified.
- files: `src/components/launchpad/launchpadShared.tsx:272`, `src/components/launchpad/launchpadShared.tsx:286-287`
- effort: S
- risk: low
- test: For a repriced/Dutch drop, confirm the label reads as an estimate, not authoritative revenue.
- deps: []
- batchHint: lender-earnings-accuracy

---

## Batch: amm-fee-and-placeholders  (F269)
Summary: AMM hardcodes a `'0.5%'` protocol fee (never read on-chain, drift risk) and ships permanent "after launch"/"once the protocol is live" placeholder copy that renders even when `deployed` is true.

### F269  (low)
- verdict: fix-now
- rootCause: T3
- approach: Read `protocolFeeBps` from the factory for the AMM stats bar (`AMMSection.tsx:421`) like `LendingSection` does, instead of the literal `'0.5%'`. Gate the placeholder copy on `deployed`: the `TradeHistory` placeholder (L997-998) and the "Cumulative LP fees (available after launch)" line (L2503) should change once live. Wiring real trade history can reuse the proven `PoolTradeHistory` getLogs pattern (already in this file).
- files: `src/components/nftfinance/AMMSection.tsx:417-422`, `src/components/nftfinance/AMMSection.tsx:985-1003`, `src/components/nftfinance/AMMSection.tsx:2503`
- effort: M
- risk: low
- test: With factory deployed, confirm the fee reflects on-chain `protocolFeeBps` and "after launch" copy no longer shows.
- deps: []
- batchHint: amm-fee-and-placeholders

---

## Batch: launchpad-phase-labels  (F261)
Summary: `PhaseBadge` still maps every phase other than 1/2 to `label: 'Paused'`, so a live Dutch auction (phase 3) badges as "Paused" and CLOSED/CANCELLED collapse into the same word — the exact mislabel the launchpadConstants R071 note says was fixed (it fixed only the admin grid, not the badge). `CollectionDetailV2` also labels CLOSED (phase 0) as "Minting Paused", colliding with the separate genuine-pause banner.

### F261  (medium)
- verdict: fix-now
- rootCause: T3
- approach: Derive `PhaseBadge` from `PHASE_LABELS` (`launchpadConstants.ts:18` already has Closed/Allowlist/Public/Dutch Auction/Cancelled) with per-phase color configs, replacing the 3-branch ternary at `launchpadShared.tsx:48-54`. In `CollectionDetailV2`, change `mintLabel`'s phase-0 string (L54) and the body copy (L362) from "Minting Paused"/"paused" to "Minting closed — the creator hasn't opened the sale" so it doesn't collide with the genuine pause banner (L296-308).
- files: `src/components/launchpad/launchpadShared.tsx:48-69`, `src/components/launchpad/CollectionDetailV2.tsx:46-56`, `src/components/launchpad/CollectionDetailV2.tsx:362`
- effort: S
- risk: low
- test: Render a phase-3 drop → badge "Dutch Auction"; phase-0 → "Closed", distinct from a paused-contract banner.
- deps: []
- batchHint: launchpad-phase-labels

---

## Batch: restake-link-routing  (F258)
Summary: The page's copy and two in-app "Restake for bonus yield" links promise restaking, but no restake UI exists in any of the four sections — restaking lives on `FarmPage`. The `/restake` route redirects to `/nft-finance`, landing users on the P2P loan market.

### F258  (medium)
- verdict: fix-now
- rootCause: standalone
- approach: Point the `/restake` redirect (`App.tsx:151`) and the two links (`StakingCard.tsx:322`, `DashboardPage.tsx:428`) at `/farm` (restake UI confirmed at `FarmPage.tsx:284-331`). Correct `LendingPage.tsx` lending copy ("lend ETH against staking NFTs", not "lend/supply TOWELI") — overlaps F302. Keep all sections/art as-is.
- files: `src/App.tsx:151`, `src/components/farm/StakingCard.tsx:322`, `src/pages/DashboardPage.tsx:428`, `src/pages/LendingPage.tsx:19`, `src/pages/LendingPage.tsx:30-32`
- effort: S
- risk: low
- test: Click "Restake for bonus yield" from Dashboard/Farm card and visit `/restake` — all land on `/farm` restake controls.
- deps: []
- batchHint: restake-link-routing

---

## Batch: nested-tab-urls  (F274)
Summary: Inner tabs (lend/borrow/myloans, trade/create/pools, NFT lending tabs) are component `useState`, so Dashboard deep-links like `/nft-finance?section=nftlending → view your loan` reset to the default sub-tab and the user must find their loan manually.

### F274  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Add a `?tab=` param (and optional `?offer=`/`#loan-id` anchor) derived the same R007 Pattern-A way `section` already is in `LendingPage.tsx:91`. Thread an initial-tab prop into each section so `LendingSection` (L1845), `AMMSection` (L2650) and `NFTLendingSection` (L103) seed `useState` from the URL.
- files: `src/pages/LendingPage.tsx:84-98`, `src/components/nftfinance/LendingSection.tsx:1845`, `src/components/nftfinance/AMMSection.tsx:2650`, `src/components/nftfinance/NFTLendingSection.tsx:103`, `src/pages/DashboardPage.tsx:731`
- effort: M
- risk: med
- test: `/nft-finance?section=nftlending&tab=My%20Loans` lands directly on My Loans; Dashboard loan link deep-links to the right sub-tab.
- deps: []
- batchHint: nested-tab-urls

---

## Batch: a11y-forms-tabs  (F275, F303, F312)
Summary: Accessibility gaps across the page: form labels not associated with inputs, clickable `<th>`/`<tr>` rows with no keyboard support, inner tab bars lacking `role=tablist/tab`, unlabeled steppers, `TraitEditor` with no focus trap (F275); page-level tabs reference non-existent tabpanels when disconnected + no arrow-key roving tabindex (F303); intro overview card buttons have no accessible name (F312).

### F275  (low)
- verdict: fix-now
- rootCause: T10
- approach: `id`/`htmlFor` every `<label>`/input pair (pattern already correct in `CollectionDetailV2.tsx:380/394`); wrap `SortHeader` clickable `<th>` content in a `<button>` (`LendingSection.tsx:94-98`); add `role=button`+`tabIndex=0`+Enter/Space handling to expandable `OfferRow`/`OfferCard` rows; give inner `TabNav`s `role=tablist/tab` + `aria-selected` (`LendingSection.tsx:563`, `AMMSection.tsx:452`, `NFTLendingSection.tsx:195`); `aria-label` the qty steppers (`AMMSection.tsx`, `CollectionDetailV2.tsx:416-430`); add initial-focus + focus-trap to `TraitEditor` (it has `role=dialog`/`aria-modal` but no trap, L60-80).
- files: `src/components/nftfinance/LendingSection.tsx:94-98`, `src/components/nftfinance/LendingSection.tsx:563`, `src/components/nftfinance/AMMSection.tsx:452`, `src/components/nftfinance/AMMSection.tsx:1686-1732`, `src/components/nftfinance/NFTLendingSection.tsx:195-214`, `src/components/launchpad/wizard/TraitEditor.tsx:60-80`, `src/components/launchpad/CollectionDetailV2.tsx:416-430`
- effort: L
- risk: low
- test: Keyboard-only pass: tab through forms (labels read), Enter on sort headers/rows toggles, arrow-keys move tabs, Esc/focus-trap work in TraitEditor. Optional axe scan.
- deps: []
- batchHint: a11y-forms-tabs

### F303  (medium)
- verdict: fix-now
- rootCause: T10
- approach: Give the disconnected wrapper (`ConnectPrompt` branch) the `role='tabpanel'` + `id={nft-finance-panel-${section}}` so the page tabs' `aria-controls` (`LendingPage.tsx:199`) resolves. Add roving-tabindex + ArrowLeft/Right handling to the tablist (L194-217). Note: F299/F300's un-gate (rendering a real panel when disconnected) also resolves the dangling `aria-controls`, so coordinate.
- files: `src/pages/LendingPage.tsx:185-242`
- effort: M
- risk: low
- test: Disconnected, `document.querySelectorAll('[role=tabpanel]').length === 1`; ArrowRight on a focused tab moves selection.
- deps: [F300]
- batchHint: a11y-forms-tabs

### F312  (polish)
- verdict: fix-now
- rootCause: T10
- approach: Add `aria-label={`Open ${card.title}`}` to the three intro `m.button`s (`LendingPage.tsx:140-169`) so the accessibility tree picks up a name (currently anonymous because the button wraps only art+text divs).
- files: `src/pages/LendingPage.tsx:140-169`
- effort: S
- risk: low
- test: read_page / axe shows named buttons ("Open Token Lending", etc.).
- deps: []
- batchHint: a11y-forms-tabs

---

## Batch: tab-history-semantics  (F278, F310)
Summary: `LendingPage` uses `setSearchParams(..., {replace:true})` under a comment claiming Back/Forward stay correct (Back actually skips tab changes — defensible but the comment overclaims), F278; inactive tab pills have `text-white hover:text-white` so hover gives no feedback, F310.

### F278  (polish)
- verdict: fix-now
- rootCause: standalone
- approach: Either drop `replace` for explicit tab clicks (so Back steps through tabs) or correct the comment at `LendingPage.tsx:88-90` to state tab changes are replace-not-push. Also render the tabpanel id on the ConnectPrompt wrapper (overlaps F303) so `aria-controls` resolves when disconnected.
- files: `src/pages/LendingPage.tsx:88-98`, `src/pages/LendingPage.tsx:219-224`
- effort: S
- risk: low
- test: Decide push vs replace; verify Back behavior matches the (corrected) comment.
- deps: [F303]
- batchHint: tab-history-semantics

### F310  (polish)
- verdict: fix-now
- rootCause: standalone
- approach: Give inactive tab pills a real hover treatment — change `text-white hover:text-white` (`LendingPage.tsx:203`) to e.g. `text-white/70 hover:text-white` or add `hover:bg-white/5`.
- files: `src/pages/LendingPage.tsx:200-204`
- effort: S
- risk: low
- test: Hover an inactive pill — confirm a visible state change.
- deps: []
- batchHint: tab-history-semantics

---

## Batch: overview-cards  (F309, F311)
Summary: The intro overview has 3 cards but the page has 4 sections (Launchpad omitted), and the `SECTIONS` subtitles ("Staking + Restake" etc.) are defined but never rendered — so the only hint that restaking lives under Token Lending is invisible (F309). The "Dismiss overview" control is 10px at 30% white over busy art (F311).

### F309  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Add a 4th `INTRO_CARDS` entry for Launchpad (`LendingPage.tsx:51-73`), and render the existing `SECTIONS[].subtitle` under each tab label in the toggle (L194-216) — desktop has the room. Surfaces "Staking + Restake" so restaking is discoverable (complements F258 routing).
- files: `src/pages/LendingPage.tsx:18-23`, `src/pages/LendingPage.tsx:51-73`, `src/pages/LendingPage.tsx:194-216`
- effort: S
- risk: low
- test: Overview shows 4 cards; tab pills show subtitles on desktop.
- deps: []
- batchHint: overview-cards

### F311  (polish)
- verdict: fix-now
- rootCause: standalone
- approach: Bump the dismiss control to ~12px at `text-white/60` with a subtle pill background, or move it to the overview block's corner as an × button (`LendingPage.tsx:173-178`). Functionality (localStorage persist) is fine — purely contrast/affordance.
- files: `src/pages/LendingPage.tsx:172-179`
- effort: S
- risk: low
- test: Visual — dismiss control is discernible over the gallery art.
- deps: []
- batchHint: overview-cards

---

## Batch: prod-redeploy-and-rpc  (F307, F308, F305, F306, F304, F314)
Summary: Live-only findings that are mostly stale-prod-build or independent polish: primary RPC demotion already at HEAD but prod is stale (F307, plus a real nakamigos-only no-failover gap); background/hero art pops in with no LQIP (F308, T12); mascot occludes price chip (F305); light-mode h1 weak contrast (F306); first-visit splash has no labeled Skip (F304); splash-replay easter egg is an unlabeled 28px button over the home logo (F314).

### F307  (high)
- verdict: redeploy-only
- rootCause: T1
- approach: `wagmi.ts` at HEAD already demotes llamarpc to last-resort with `rank:true` (L12-21) — just ship HEAD to prod (CLI deploy per repo procedure). Separately (fix-now, out of this surface's scope): `nakamigos/components/OnChainProfile.jsx:158` and `WhaleIntelligence.jsx:363` hard-code llamarpc as their ONLY provider with no failover — route them through a shared provider list. Spawned as its own task.
- files: `src/lib/wagmi.ts:12-21`, `src/nakamigos/components/OnChainProfile.jsx:158`, `src/nakamigos/components/WhaleIntelligence.jsx:363`
- effort: S
- risk: low
- test: After redeploy, network log shows publicnode/ankr first; nakamigos surfaces survive llamarpc 503.
- deps: []
- batchHint: prod-redeploy-and-rpc

### F308  (low)
- verdict: fix-now
- rootCause: T12
- approach: Add a low-res blurred LQIP / dominant-color layer behind the full-bleed AVIF (`LendingPage.tsx:110-112` `ArtImg`/background) so the art fades in rather than popping from the flat `#060c1a` void. Consider preloading the page bg when the route is linked from Dashboard. Reuse any existing `ArtImg` blur-up support if present.
- files: `src/pages/LendingPage.tsx:110-112`, `src/components/ArtImg.tsx`
- effort: M
- risk: low
- test: Throttled reload — art fades from a placeholder instead of a 5-14s dark void.
- deps: []
- batchHint: prod-redeploy-and-rpc

### F305  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Offset the "Protocol Active $…" price chip left of the Towelie mascot (or raise z-index/margin) so the live price text isn't clipped. Both are fixed bottom-right with overlapping bounds — adjust in the global mascot/price-chip components (not page-local).
- files: `src/components/` (locate the floating Towelie mascot + price-chip widgets — search bottom-right fixed elements / "Protocol Active")
- effort: S
- risk: low
- test: Bottom-right — full "Protocol Active $X" reads without the sprite over it, desktop + mobile.
- deps: []
- batchHint: prod-redeploy-and-rpc

### F306  (low)
- verdict: fix-now
- rootCause: standalone
- approach: The `NFT Finance` h1 (`LendingPage.tsx:122`, `heading-luxury`) goes dark navy in light mode over the dark gallery art. Add a text-shadow/scrim or keep the h1 light-on-dark in both themes (the backdrop art is dark in both). Additive — don't change the art.
- files: `src/pages/LendingPage.tsx:122`
- effort: S
- risk: low
- test: Toggle light mode — h1 stays legible over the painting.
- deps: []
- batchHint: prod-redeploy-and-rpc

### F304  (medium)
- verdict: fix-now
- rootCause: T10
- approach: Keep the brand splash but add an explicit Skip affordance — a "Click to skip" hint or a Skip button after ~2s — so first-time visitors heading to a finance page aren't held ~15-19s. This is in the splash component (not page-local); sessionStorage `tf_loaded` + logo-monkey replay already work.
- files: `src/components/` (locate splash/intro component — search `tf_loaded`)
- effort: M
- risk: low
- test: Fresh session (clear `tf_loaded`) → a labeled Skip appears within ~2s and dismisses the splash.
- deps: []
- batchHint: prod-redeploy-and-rpc

### F314  (polish)
- verdict: fix-now
- rootCause: T10
- approach: Keep the splash-replay easter egg but move the 28px button a few px clear of the "Go to home page" logo link (or add a hover play-icon affordance) so a slightly-off logo click doesn't trigger a ~15s splash + full reload. In the header/logo cluster (`TopNav.tsx`).
- files: `src/components/layout/TopNav.tsx`
- effort: S
- risk: low
- test: Click the logo mark center → navigates home; only the offset replay hotspot replays the splash.
- deps: []
- batchHint: prod-redeploy-and-rpc

---

## Batch: nav-discoverability  (F301)
Summary: No desktop nav link to NFT Finance — the mobile `BottomNav` has it as a primary tab, but the desktop "More" menu (Gallery/Tegridy Score/Tokenomics/Treasury) and the footer PRODUCT column omit it (footer includes it only behind `NFT_FINANCE_LIVE`, currently false pre-deploy). Desktop is the owner's stated primary platform.

### F301  (medium)
- verdict: product-decision
- rootCause: standalone
- approach: Decision needed: surface "NFT Finance" in the desktop More menu (`TopNav.tsx` dropdown, ~L157-167) and footer PRODUCT column (`Footer.tsx:21` — relax/replace the `NFT_FINANCE_LIVE` gate) with an optional SOON badge while pre-deploy, matching the mobile bottom-nav — OR keep it intentionally hidden until contracts deploy (the existing `NFT_FINANCE_LIVE` credibility-gate is deliberate, per the 2026-06-09 note). Once decided, the code change is small/additive.
- files: `src/components/layout/TopNav.tsx:157-167`, `src/components/layout/Footer.tsx:12-21`, `src/components/layout/BottomNav.tsx:35`
- effort: S
- risk: low
- test: After the decision, desktop More menu + footer list NFT Finance (with SOON badge if pre-deploy), reachable without typing the URL.
- deps: []
- batchHint: nav-discoverability

---

## Batch: perf-dead-code  (F277, F272, F273, F297)
Summary: Perf/cleanup items: per-LoanRow 1Hz re-renders for a minute-granularity display + dead exported showcase components shipped in the bundle (F277); unbounded batch reads of every offer/loan + silent launchpad 20-cap, no pagination (F272/F297); expanded trade history re-runs two getLogs every block (F273).

### F277  (polish)
- verdict: fix-now
- rootCause: standalone
- approach: Give `useCountdown` an optional tick-interval param (60s when not urgent, 1s when `<1d`) so N `LoanRow`s don't each run a 1Hz loop for a `Xd:HHh:MMm` display (`useCountdown.ts:24-27`, used `LendingSection.tsx:1507`/`NFTLendingSection.tsx:938`). Move the `@internal Reserved` dead exports (`SkeletonLayout` L220, `LendingPulseDot` L268, `ComingSoonState` L350, `AMMSection ComingSoon` L2581) behind a lazy import or delete-on-confirm with the owner (do NOT delete art/sections unilaterally — owner mandate).
- files: `src/hooks/useCountdown.ts:23-27`, `src/components/nftfinance/LendingSection.tsx:220-445`, `src/components/nftfinance/AMMSection.tsx:2581-2644`
- effort: M
- risk: low
- test: Profiler shows minute-cadence re-renders for non-urgent loans; bundle no longer ships the reserved components (verify via build analyzer).
- deps: []
- batchHint: perf-dead-code

### F273  (low)
- verdict: fix-now
- rootCause: T8
- approach: Keep `lastFetchedBlock` in a ref and only re-run the getLogs pair when `blockNumber - lastFetched > 25` (or drop `watch` and rely on the 30s interval). Currently `AMMSection.tsx:1318` `useBlockNumber({watch:true})` + `blockNumber` in the effect deps (L1375) re-executes the full 10k-block getLogs pair every ~12s while expanded, despite the comment promising a delta check.
- files: `src/components/nftfinance/AMMSection.tsx:1315-1375`
- effort: S
- risk: low
- test: Expand a pool's Trade History, watch network — getLogs fires at most every ~25 blocks, not every block.
- deps: []
- batchHint: perf-dead-code

### F272  (low)
- verdict: fix-now
- rootCause: T8
- approach: Page the reads (newest-N + "Load more") instead of `Array.from({length: count})` over every offer/loan (`LendingSection.tsx:1751-1758`/`1802-1809`, `NFTLendingSection.tsx:484-495`). Surface the silent launchpad cap (`LaunchpadSection.tsx:53` `Math.min(count,20)`) as "showing 20 of N + Load more".
- files: `src/components/nftfinance/LendingSection.tsx:1751-1809`, `src/components/nftfinance/NFTLendingSection.tsx:484-495`, `src/components/nftfinance/LaunchpadSection.tsx:52-65`
- effort: L
- risk: med
- test: With >20 collections / many offers, confirm initial page + Load more, no giant single multicall on visit.
- deps: []
- batchHint: perf-dead-code

### F297  (low)
- verdict: duplicate
- rootCause: T8
- approach: Same work as F272 (missing-vs-best-in-class restatement of pagination/infinite-scroll + the silent 20-cap). No separate change.
- files: `src/components/nftfinance/LendingSection.tsx:1751-1809`, `src/components/nftfinance/LaunchpadSection.tsx:52-65`
- effort: S
- risk: low
- test: Covered by F272.
- deps: [F272]
- batchHint: perf-dead-code

---

## Batch: offer-lifecycle-mgmt  (F279, F288)
Summary: No "My Offers" management or cancel-offer affordance in either lending section — lender ETH is escrowed as `msg.value` with no UI path to recover it; NFT-lending offers carry a hardcoded 30-day expiry the lender never sees or chooses. NFTfi/Gondi treat offer management as a first-class tab.

### F279  (medium)
- verdict: fix-now
- rootCause: standalone
- approach: Add a "My Offers" sub-tab to both sections listing the user's open offers (filter `lender === address` from the existing batch read — already fetched), wired to the contract's cancel function. Show/let the lender choose the expiry at creation (NFT lending hardcodes `now + 30d` at `NFTLendingSection.tsx:304`). Verify the cancel selector exists in `TEGRIDY_LENDING_ABI`/`TEGRIDY_NFT_LENDING_ABI` first.
- files: `src/components/nftfinance/LendingSection.tsx:557-561`, `src/components/nftfinance/NFTLendingSection.tsx:47`, `src/components/nftfinance/NFTLendingSection.tsx:296-314`, `src/lib/contracts.ts`
- effort: L
- risk: med
- test: Create an offer, open My Offers, cancel it → escrowed ETH returns, offer leaves the list; expiry shown/chosen at creation.
- deps: [F257]
- batchHint: offer-lifecycle-mgmt

### F288  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same scope as F279 (missing-vs-best-in-class restatement of My Offers / cancel / expiry). No separate change.
- files: `src/components/nftfinance/LendingSection.tsx:557-561`
- effort: S
- risk: low
- test: Covered by F279.
- deps: [F279]
- batchHint: offer-lifecycle-mgmt

---

## Batch: nft-metadata-imagery  (F281, F289, F290)
Summary: No NFT imagery/metadata anywhere money changes hands — collateral renders as bare `#tokenId` text, pools as raw addresses, sellers/lenders type token IDs blind with no owned-NFT picker and no `ownerOf` pre-check. The repo already has `lib/nftMetadata.ts` + a deployed tokenURI reader (`constants.ts:52`). One metadata-resolution helper + a wallet inventory picker closes all three.

### F281  (medium)
- verdict: fix-now
- rootCause: standalone
- approach: Resolve `tokenURI → thumbnail` (via `lib/nftMetadata.ts` + `TEGRIDY_TOKEN_URI_READER_ADDRESS`) for offer/loan/pool cards; add explorer/marketplace links; add a "your NFTs" picker for the sell/deposit/collateral flows (replacing blind tokenId typing at `NFTLendingSection.tsx:397-406`, `AMMSection.tsx:807-824`); disable Accept with "You don't own #X" via an `ownerOf` read.
- files: `src/components/nftfinance/NFTLendingSection.tsx:397-406`, `src/components/nftfinance/NFTLendingSection.tsx:766-798`, `src/components/nftfinance/AMMSection.tsx:758-824`, `src/components/nftfinance/AMMSection.tsx:1618-1638`, `src/lib/nftMetadata.ts`
- effort: L
- risk: med
- test: Offer/loan cards show collateral thumbnails + explorer links; sell/deposit show an owned-NFT picker; Accept disabled when wallet doesn't own the tokenId.
- deps: []
- batchHint: nft-metadata-imagery

### F289  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same as F281 (collateral imagery + floor + valuation context). Floor-price context is the only incremental piece — fold into F281's card redesign if a floor source is available, else note as a follow-up.
- files: `src/components/nftfinance/NFTLendingSection.tsx:766-798`
- effort: S
- risk: low
- test: Covered by F281.
- deps: [F281]
- batchHint: nft-metadata-imagery

### F290  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same as F281 (wallet inventory picker for collateral/sell/deposit). No separate change.
- files: `src/components/nftfinance/NFTLendingSection.tsx:397-406`, `src/components/nftfinance/AMMSection.tsx:807-824`
- effort: S
- risk: low
- test: Covered by F281.
- deps: [F281]
- batchHint: nft-metadata-imagery

---

## Batch: usd-denominations  (F282, F291)
Summary: USD context is missing almost everywhere despite `useTOWELIPrice().ethUsd` already being plumbed into `LendingSection` — only `LendTab`'s principal estimate shows USD. Offer principals, repayments, AMM quotes/fees, TVL, pool balances, mint costs are ETH-only.

### F282  (low)
- verdict: fix-now
- rootCause: T6
- approach: Append greyed `~$` subtitles to principal/repay/quote/TVL figures using `ethUsd` (already available, `LendingSection.tsx:702`), with the existing "USD estimate unavailable" fallback (pattern at L795-801). Thread `useTOWELIPrice` into AMM/NFT-lending cards where not present.
- files: `src/components/nftfinance/LendingSection.tsx:1064-1080`, `src/components/nftfinance/LendingSection.tsx:1221-1233`, `src/components/nftfinance/NFTLendingSection.tsx:726-744`, `src/components/nftfinance/AMMSection.tsx:1582-1616`
- effort: M
- risk: low
- test: With ethUsd available, ETH figures show `~$` subtitles; when unavailable, the fallback text shows.
- deps: []
- batchHint: usd-denominations

### F291  (low)
- verdict: duplicate
- rootCause: T6
- approach: Same as F282 (USD alongside ETH across quotes/principals/repayments/TVL). No separate change.
- files: `src/components/nftfinance/LendingSection.tsx:1064-1080`
- effort: S
- risk: low
- test: Covered by F282.
- deps: [F282]
- batchHint: usd-denominations

---

## Batch: pool-directory  (F284, F292)
Summary: No global pool directory — AMM discovery requires already knowing the collection address (`PoolExplorer` only exposes `getPoolsForCollection(searchAddr)`), even though `getPoolCount` is already read for the stats bar. Sudoswap's core surface is a ranked browser.

### F284  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Enumerate pools via the factory (`getPoolCount` + an index getter, or `PoolCreated` logs) into a sortable list with TVL/spot columns, alongside the existing address-search `PoolExplorer` (`AMMSection.tsx:1818-1888`). Confirm the factory exposes a `poolAt(i)`/`allPools` getter in the ABI before building; else use `PoolCreated` getLogs.
- files: `src/components/nftfinance/AMMSection.tsx:1818-1902`, `src/lib/contracts.ts`
- effort: L
- risk: med
- test: With ≥2 pools deployed, the directory lists all, sortable by liquidity/spot, without pasting an address.
- deps: []
- batchHint: pool-directory

### F292  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same as F284 (Sudoswap-style ranked directory). No separate change.
- files: `src/components/nftfinance/AMMSection.tsx:1818-1902`
- effort: S
- risk: low
- test: Covered by F284.
- deps: [F284]
- batchHint: pool-directory

---

## Batch: simulate-and-revert-decode  (F285, F293)
Summary: All write paths toast `err.message?.slice(0,120)` so users see "execution reverted" prefixes instead of human reasons; `lib/revertDecoder.ts` exists but is imported by no nftfinance component, and there's no `useSimulateContract` pre-check so doomed txs reach the wallet.

### F285  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Route all write `onError` toasts through the shared `revertDecoder` instead of `slice(0,120)` (sites: `LendingSection.tsx:771,1026,1040,1565`; `AMMSection.tsx:1520,1548` and others). Add `useSimulateContract` pre-checks on Accept/Repay/Claim so doomed txs (insufficient repayment, unowned tokenId, expired offer) are blocked before the wallet prompt.
- files: `src/components/nftfinance/LendingSection.tsx:771`, `src/components/nftfinance/LendingSection.tsx:1026`, `src/components/nftfinance/LendingSection.tsx:1040`, `src/components/nftfinance/LendingSection.tsx:1565`, `src/components/nftfinance/AMMSection.tsx:1520`, `src/components/nftfinance/AMMSection.tsx:1548`, `src/lib/revertDecoder.ts`
- effort: M
- risk: med
- test: Trigger a known revert (e.g. underpaid repay) → toast shows a decoded human reason; simulate blocks the doomed tx before the wallet opens.
- deps: []
- batchHint: simulate-and-revert-decode

### F293  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same as F285 (pre-flight simulation + decoded reverts). No separate change.
- files: `src/lib/revertDecoder.ts`
- effort: S
- risk: low
- test: Covered by F285.
- deps: [F285]
- batchHint: simulate-and-revert-decode

---

## Batch: loan-alerts-deeplinks  (F286, F294)
Summary: No deadline alerts/reminders or share/export affordances for loans — the repo has `usePriceAlerts` + push alerts infra (Tier-1 roadmap), but loan deadlines aren't wired to it; no `.ics`/calendar export, copyable per-loan link, or CSV history. Table stakes for Gondi/NFTfi where a missed deadline forfeits the NFT.

### F286  (low)
- verdict: fix-now
- rootCause: standalone
- approach: Wire loan deadlines into the existing alert infrastructure (`usePriceAlerts`/push) and add a per-loan deep link (combine with F274's `#loan-id` anchor) + `.ics` export. Confirm the alert infra accepts a generic time-based trigger before building.
- files: `src/components/nftfinance/LendingSection.tsx:1586-1653`, `src/components/nftfinance/NFTLendingSection.tsx:1017-1117`, `src/hooks/usePriceAlerts.ts`
- effort: L
- risk: low
- test: Set a deadline alert on a loan → notification fires before deadline; per-loan link + ics download work.
- deps: [F274]
- batchHint: loan-alerts-deeplinks

### F294  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same as F286 (deadline alerts + shareable per-offer/per-loan deep links). No separate change.
- files: `src/components/nftfinance/LendingSection.tsx:1586-1653`
- effort: S
- risk: low
- test: Covered by F286.
- deps: [F286]
- batchHint: loan-alerts-deeplinks

---

## Batch: dutch-allowlist-mint-ux  (F283, F295, F296)
Summary: Mint page lacks Dutch-auction price-decay countdown + next-price preview (price re-polls only every 60s), supply/wallet guardrails on the quantity Max button (overshoot reverts on-chain), and a hosted allowlist proof service (users hand-paste comma-separated merkle proofs + leaf amount).

### F283  (low)
- verdict: fix-now
- rootCause: standalone
- approach: In `CollectionDetailV2`: add a price-decay countdown + next-price preview for phase 3 (Dutch); clamp the Max button (L433) to `min(maxPerWallet − minted, maxSupply − totalSupply)` instead of `maxPerWallet || 10`; host per-drop allowlist proofs (API or downloadable JSON the page looks up by address) so users don't paste proofs (L380-408).
- files: `src/components/launchpad/CollectionDetailV2.tsx:46-56`, `src/components/launchpad/CollectionDetailV2.tsx:380-433`, `src/hooks/useNFTDropV2.ts:76`
- effort: L
- risk: med
- test: Phase-3 drop shows a live decay countdown; Max clamps to remaining supply/wallet cap; allowlist mint requires no manual proof paste.
- deps: []
- batchHint: dutch-allowlist-mint-ux

### F295  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same as F283 (Dutch live price-decay countdown + next-price preview). No separate change.
- files: `src/components/launchpad/CollectionDetailV2.tsx:46-56`
- effort: S
- risk: low
- test: Covered by F283.
- deps: [F283]
- batchHint: dutch-allowlist-mint-ux

### F296  (low)
- verdict: duplicate
- rootCause: standalone
- approach: Same as F283 (hosted allowlist proof lookup). No separate change.
- files: `src/components/launchpad/CollectionDetailV2.tsx:380-408`
- effort: S
- risk: low
- test: Covered by F283.
- deps: [F283]
- batchHint: dutch-allowlist-mint-ux

---

## Batch: historical-analytics  (F298)
Summary: No pool volume charts, lending book depth, or realized APR — Dexscreener/Blend-grade context. Net-new analytics surface; needs an indexer/data source decision before coding.

### F298  (low)
- verdict: product-decision
- rootCause: standalone
- approach: Decide the data source (the planned indexer/Dune surface per pending-operator-tasks, or on-chain getLogs aggregation like `PoolTradeHistory`) before building pool-volume charts / lending-book-depth / realized-APR. Largest net-new scope on this surface; gate on the indexer decision rather than building bespoke client-side aggregation now.
- files: `src/components/nftfinance/AMMSection.tsx`, `src/components/nftfinance/LendingSection.tsx`
- effort: L
- risk: med
- test: Once a source is chosen, charts render realized volume/depth/APR matching on-chain reality.
- deps: [F284]
- batchHint: historical-analytics
