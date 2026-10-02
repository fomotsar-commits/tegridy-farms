# RC5 — Recovery: re-apply reverted hook hardening

**Date:** 2026-04-26
**Trigger:** prior R033/R034/R042/R043/R044/R075/R080/R036/R037 hook fixes were reverted in the working tree. `lib/safeParseEther.ts`, `lib/imageSafety.ts`, `lib/textSafety.ts`, `lib/consent.ts` survived; hook bodies did not.

## Re-applied per change-log spec

- **useSwap.ts** — bound displayed `minimumReceived` directly (R033 H-01); 30s `quoteFetchedAt`/`isQuoteStale` gate (H-02); `isPendingRef` in-flight guard (H-04); `submittedInputAmountRef`/`submittedRouteRef` snapshots at submit (R042 HIGH-1).
- **useSwapAllowance.ts** — USDT-style two-step approve (zero → target) with `pendingTargetAmountRef`/`isApprovingMultiStep` (R033 M-02); `chainId === CHAIN_ID` gating (R042 MED-3).
- **useSwapQuote.ts** — `quoteFetchedAt` stamp on every settle (success/failure, agg + on-chain), 1s reactive ticker, `useMemo`-wrapped return (R042 HIGH-2), exported `QUOTE_MAX_AGE_MS = 30_000`.
- **useLimitOrders.ts** — `executingRef` Set→Map<string, {txHash, submittedAt}> with 5min TTL; `.clear()` removed from poll-effect cleanup; `isExecuting()` helper.
- **useDCA.ts** — `BroadcastChannel('tegridy-dca-lock')`, `TAB_ID`, `remoteClaimsRef`, `claimWithBroadcast`/`releaseWithBroadcast`; beforeunload broadcasts release.
- **useFarmActions.ts + useLPFarming.ts + useNFTBoost.ts** — `txAddressRef` snapshot, `useEffect([address])` reset, `enabled: !!address && onMainnet`, `safeParseEtherPositive` replaces raw `parseEther`; tri-state `boolean | null` for JBAC/Gold.
- **useNFTDropV2.ts** — `chainId: CHAIN_ID` per entry, 60s poll; phase enum `0=CLOSED, 4=CANCELLED` (was 0=Paused).
- **usePoolTVL.ts** — chainId pin; NaN/Infinity guard `Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 1e12) : 0`; 60s.
- **useFarmStats.ts** — chainId pin everywhere.
- **useMyLoans.ts** — chunk loan IDs into batches of 50 via Promise.all; 60s; chainId pin.
- **useIrysUpload.ts** — `MAX_UPLOAD_BYTES = 100 MiB` per file + 500 MiB total; `Buffer.from(...)` polyfill replaces `as unknown as Buffer`; `PayloadTooLargeError`.
- **useTransactionReceipt.ts** — `useTrackedTransactionReceipt` already present (verified).
- **useGaugeList.ts + useBribes.ts** — `useWatchContractEvent` for Gauge/Bribe events; `EpochAdvanced` from VoteIncentives.
- **useRestaking.ts** — bonus cap `2 × (totalBonusFunded - totalBonusDistributed)`, base cap `2 × restakedAmount`; `rewardSanityBreach` flag.
- **useToweliPrice.ts + usePriceHistory.ts** — `PRICE_CACHE_VERSION = 2`, `signedAt` freshness check (60s slack, 24h max).
- **usePoints.ts** — removed silent `setReferrer` URL auto-write; updated disclaimer.
- **useTegridyScore.ts** — `readCachedTs` validator rejects negative/future/pre-2020 timestamps.
- **lib/storage.ts** — added `safeJsonParse` (already extended by linter with fallback signature).
- **lib/contracts.ts** — added `BribeDeposited`/`BribeDepositedETH`/`BribeClaimed`/`GaugeVoted`/`EpochAdvanced` (VoteIncentives) and `GaugeAdded`/`GaugeRemoved`/`Voted` (GaugeController) event ABIs.
- **lib/wagmi.ts** — `fallback([...], { rank: true })`.
- **test-utils/wagmi-mocks.ts** — added `useWatchContractEvent` no-op.

## Verification

`cd frontend && npx tsc --noEmit` → exit 0, zero output.

## Out of scope

Test-file updates (the existing `useSwap.test.ts` mock factory will need refresh for `QUOTE_MAX_AGE_MS` + multi-step helpers per R033 spec; tracked separately).
