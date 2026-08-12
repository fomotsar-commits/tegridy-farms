import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { useAccount, useChainId, usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { LaunchExplorer } from '../components/launcher/LaunchExplorer';
import { LaunchAfterlife } from '../components/launcher/LaunchAfterlife';
import { LaunchRadar } from '../components/launcher/LaunchRadar';
import {
  DEFAULT_FEE_CONSTITUTION,
  LAUNCH_TIERS,
  type LaunchTierId,
  isLauncherEnabled,
  allowedNumeraires,
  ETH_NUMERAIRE,
  TOWELI_NUMERAIRE,
  LAUNCH_FEE_TIER,
} from '../lib/launcher/config';
import { MIGRATION_POOL } from '../lib/launcher/airlock';

// Rendered, never hardcoded. Both screens below used to read "1% total trade fee" over the
// constitution table — conflating the AUCTION pool's fee with the GRADUATED pool's, which
// is the fee the constitution actually divides. Terms §7 always stated this correctly; the
// wizard, the screen a creator signs on, did not. Deriving the numbers means the literal
// cannot drift back. feePct(10_000) = "1", feePct(3000) = "0.3".
const feePct = (hundredthsOfBip: number) => String(hundredthsOfBip / 10_000);
const AUCTION_FEE_PCT = feePct(LAUNCH_FEE_TIER);
const GRADUATED_FEE_PCT = feePct(MIGRATION_POOL.fee);
import { buildFactSheet, defaultGateConfig, type RawTokenFacts } from '../lib/launcher/gate';
import type { LaunchFactSheet } from '../lib/launcher/factSheet';
import { DOPPLER_MAINNET } from '../lib/launcher/doppler.constants';
import {
  launchToken,
  wizardConfigToLaunchConfig,
  resolveFeeConstitution,
  beneficiariesToFeeConstitution,
  protocolFeeSink,
  LaunchError,
  MAX_PREMINE_BPS,
  type LaunchResult,
  type AttentionSplit,
} from '../lib/launcher/launchService';
import {
  attestFactSheet,
  factSheetSchemaUid,
  factSheetSchemaRegistered,
  EAS_SCHEMA_REGISTRY_MAINNET,
  EAS_SCHEMA_REGISTRY_ABI,
} from '../lib/launcher/attestation';
import { collectTokenFacts, viemChainReader } from '../lib/launcher/collector';
import { readMigrationStream, lockResolverFor, type MigrationStream } from '../lib/launcher/lockerStream';
import type { FeeConstitutionLine } from '../lib/launcher/factSheet';
import { fetchLauncherOutcomes } from '../lib/launcher/outcomesClient';
import type { LaunchSummary } from '../lib/launcher/ordering';
import type { OutcomeRecord } from '../lib/launcher/outcomes';
import { readOurLaunches } from '../lib/launcher/ourLaunches';
import { cohortLogClient } from '../lib/launcher/cohortLogSource';
import { isAddress, getAddress, type Address } from 'viem';
import { LP_FARMING_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import {
  lpEmissionsPhase,
  dayTwoEconomyPhrase,
  dayTwoEconomyShortPhrase,
  type LpEmissionsPhase,
} from '../lib/lpEmissions';
import { useTOWELIPriceOptional } from '../contexts/PriceContext';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { LaunchGate } from '../components/LaunchGate';
import { notifyBirth } from '../lib/launcher/notifyBirth';

const DAY = 86_400;
// 365/12 days per month, so a 12-month lock is exactly 365 days and meets the
// flagship LP-lock floor (a "12-month lock" must satisfy "locked >= 12 months").
// A flat 30-day month would make 12mo = 360d and silently downgrade to Listable.
const MONTH = (365 / 12) * DAY;

type WizardState = {
  name: string;
  symbol: string;
  tokenURI: string;
  tier: LaunchTierId;
  totalSupply: string; // whole tokens
  premineBps: number; // insider allocation, on-chain vested
  vestMonths: number; // on-chain vesting duration for the premine
  cliffMonths: number; // optional cliff before premine vesting begins
  mcapStartK: number; // Dutch-auction START (high) market cap, $ thousands
  mcapFloorK: number; // descends toward this FLOOR, $ thousands
  lpLockMonths: number;
  /** Base pair to settle in: native ETH (default) or TOWELI (exotic; only when enabled). */
  numeraire: 'eth' | 'toweli';
  /** Creator-directed KOL/community fee beneficiaries — carved from the creator's 80% pool. */
  attentionSplits: { address: string; shareBps: number }[];
};

const INITIAL: WizardState = {
  name: '',
  symbol: '',
  tokenURI: '',
  tier: 'flagship',
  totalSupply: '1000000000',
  premineBps: 0,
  vestMonths: 12,
  cliffMonths: 0,
  mcapStartK: 300, // Dutch auction starts high…
  mcapFloorK: 30, // …and descends to the floor
  lpLockMonths: 12,
  numeraire: 'eth',
  attentionSplits: [],
};

/**
 * Classify one attention-split row. Shared by the fee remainder, the Launch
 * gate, the per-row UI, and parseAttentionSplits so they can never disagree
 * again — the silent-drop bug was those sites computing validity over different
 * sets. A row is `blank` (ignored), `valid` (submitted), or `invalid` (blocks).
 */
export function splitRowStatus(r: { address: string; shareBps: number }): { blank: boolean; valid: boolean; invalid: boolean } {
  const addr = r.address.trim();
  const blank = addr.length === 0 && !r.shareBps;
  const valid = isAddress(addr) && Number.isInteger(r.shareBps) && r.shareBps > 0;
  return { blank, valid, invalid: !blank && !valid };
}

export function parseAttentionSplits(rows: WizardState['attentionSplits']): AttentionSplit[] {
  // Belt-and-braces: a non-blank row that is not valid must FAIL LOUDLY, never be
  // silently dropped. Silently dropping shipped a launch whose perpetual fee
  // stream differed from what the wizard displayed (a mistyped beneficiary got
  // nothing, forever, while the displayed remainder still counted them). The UI
  // blocks Launch while any row is invalid; this stops any future caller from
  // reintroducing the drop.
  const bad = rows.find((r) => splitRowStatus(r).invalid);
  if (bad) {
    throw new Error(`Invalid attention beneficiary "${bad.address || '(blank)'}": needs a valid 0x address and a positive whole-percent share.`);
  }
  return rows
    .filter((r) => !splitRowStatus(r).blank)
    .map((r) => ({ address: r.address.trim() as Address, shareBps: r.shareBps }));
}

/**
 * Project the Fact Sheet a launch WILL have, from the wizard config, by running
 * the SAME gate the live collector uses. This is the buyer's-eye preview: it
 * ties the UI directly to gate.ts so what the wizard promises is exactly what
 * gets attested. Doppler-template powers are known-false by construction.
 */
function projectFactSheet(w: WizardState, nowSeconds: number): LaunchFactSheet {
  // Show the RESOLVED split this config produces (creator remainder + directed
  // carve-outs + fixed lines), not the static 70/10 template — otherwise the
  // preview advertises a split the deployed StreamableFeesLocker never pays (by
  // default the creator+attention pool resolves to 80/0, not 70/10). Only valid
  // rows feed the resolver, and it still throws if they over-allocate the 80%
  // pool; in that (already-flagged) state fall back to the template so the
  // preview never crashes mid-edit — the StepFees over-allocation warning and
  // the launch-time throw both catch it.
  let feeConstitution: RawTokenFacts['feeConstitution'];
  try {
    feeConstitution = resolveFeeConstitution(
      '0x0000000000000000000000000000000000000000',
      w.attentionSplits.filter((r) => splitRowStatus(r).valid).map((r) => ({ address: r.address.trim() as Address, shareBps: r.shareBps })),
      // Preview the numeraire-aware protocol sink so a TOWELI launch's Fact Sheet shows the
      // real "Tegridy treasury" line, not the ETH-pair "Tegridy stakers" it can't pay.
      w.numeraire === 'toweli' ? TOWELI_NUMERAIRE : ETH_NUMERAIRE,
    );
  } catch {
    feeConstitution = [...DEFAULT_FEE_CONSTITUTION];
  }
  const facts: RawTokenFacts = {
    token: '0x0000000000000000000000000000000000000000',
    chainId: DOPPLER_MAINNET.chainId,
    name: w.name || 'Your Token',
    symbol: w.symbol || 'TOKEN',
    totalSupply: BigInt(w.totalSupply || '0'),
    tokenFactory: DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address,
    templateCodehash: null,
    powers: { mint: false, pause: false, blacklist: false, feeOnTransfer: false, upgrade: false, balanceLimit: false },
    // Accurate per tier: Flagship graduates under a Governor+timelock (withGovernance
    // 'default'), Community is noOp (renounced). Both satisfy the gate's admin check,
    // but the DISCLOSURE must not claim "renounced" for a timelock-governed flagship.
    owner: '0x0000000000000000000000000000000000000000',
    ownerRenounced: w.tier !== 'flagship',
    ownerIsTimelock: w.tier === 'flagship',
    liquidity: { locked: true, locker: DOPPLER_MAINNET.support.streamableFeesLocker, unlockAt: Math.round(nowSeconds + w.lpLockMonths * MONTH) },
    feeConstitution,
    vesting: [],
    teamAllocationBps: w.premineBps,
    teamAllocationVestedBps: w.premineBps, // wizard only offers on-chain-vested premine
    observedAt: nowSeconds,
  };
  return buildFactSheet(facts);
}

/**
 * Honest static display of the fee constitution. DEFAULT_FEE_CONSTITUTION splits
 * the creator+attention pool into an ASPIRATIONAL 70/10, but resolveFeeConstitution
 * treats it as ONE creator-directed pool (attention defaults to 0% and is carved
 * at the creator's discretion). Showing a fixed "Attention 10%" therefore advertises
 * a split the locker doesn't pay by default. Collapse the two into the real 80%
 * pool line for any display that isn't tied to a specific launch's resolved split.
 */
const CREATOR_ATTENTION_POOL_BPS = DEFAULT_FEE_CONSTITUTION
  .filter((l) => l.role === 'creator' || l.role === 'attention-beneficiary')
  .reduce((n, l) => n + l.shareBps, 0);
const FEE_POOL_DISPLAY: { recipient: string; shareBps: number }[] = [
  { recipient: 'Creator (directs the attention carve)', shareBps: CREATOR_ATTENTION_POOL_BPS },
  ...DEFAULT_FEE_CONSTITUTION
    .filter((l) => l.role === 'protocol-stakers' || l.role === 'doppler')
    .map((l) => ({ recipient: l.recipient, shareBps: l.shareBps })),
];

const STEPS = ['Details', 'Tier & curve', 'Fees & disclosure', 'Review'] as const;

/**
 * Does the LP farm have a funded emissions period right now? Read ONCE at the page root
 * and threaded down, so the two day-2 copy sites can never disagree with each other or
 * with the chain. `periodFinish` only — the Synthetix `rewardRate` residual survives the
 * period and would report emissions nobody is paid (see lib/lpEmissions.ts). A failed
 * read degrades to 'unknown', never to 'running'.
 */
function useLpEmissionsPhase(): LpEmissionsPhase {
  const { data } = useReadContract({
    address: LP_FARMING_ADDRESS,
    abi: LP_FARMING_ABI,
    functionName: 'periodFinish',
    chainId: CHAIN_ID,
    query: { enabled: isDeployed(LP_FARMING_ADDRESS), staleTime: 300_000 },
  });
  return lpEmissionsPhase(typeof data === 'bigint' ? Number(data) : 0);
}

type LaunchStatus =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'success'; result: LaunchResult }
  // `broadcast` marks a failure that may already be on-chain (see LaunchError.broadcast):
  // the UI blocks a blind retry and points at the pending tx instead of re-launching.
  | { phase: 'error'; message: string; broadcast?: boolean; txHash?: string };

type AttestStatus =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'done'; uid: string; txHash: string }
  | { phase: 'error'; message: string };

export default function LaunchPage() {
  usePageTitle('Launch', 'Launch a token on the verifiable, V4-native Tegridy rail.');
  useEffect(() => { trackPageView('/launch'); }, []);

  const [step, setStep] = useState(0);
  const [w, setW] = useState<WizardState>(INITIAL);
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const sheet = useMemo(() => projectFactSheet(w, now), [w, now]);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const price = useTOWELIPriceOptional();
  const lpPhase = useLpEmissionsPhase();
  const [launch, setLaunch] = useState<LaunchStatus>({ phase: 'idle' });
  const [attest, setAttest] = useState<AttestStatus>({ phase: 'idle' });
  // EAS honesty gate (2026-07-24): the Fact Sheet schema must be registered on
  // the SchemaRegistry before any attestation can succeed. It was NOT registered
  // on mainnet (verified on-chain: getSchema(uid).uid == 0), so "Attest
  // disclosures on-chain" reverted with an opaque error every time. Probe the
  // registry when a launch succeeds and only offer the button once the schema is
  // live; otherwise say so plainly. null = still checking / unknown.
  const [schemaReady, setSchemaReady] = useState<boolean | null>(null);
  // "we could not read the launch history" must be visibly DIFFERENT from "nothing has
  // launched yet". Collapsing the two is how an outage renders as a track record.
  const [cohortUnavailable, setCohortUnavailable] = useState(false);
  const [explorer, setExplorer] = useState<{ launches: LaunchSummary[]; outcomes: Record<string, OutcomeRecord> }>({
    launches: [],
    outcomes: {},
  });

  // Discovery / outcomes surface. The client enriches a CONSUMED launch list
  // (LaunchBaseline[]) with real GeckoTerminal + Etherscan data via the aggregator
  // catchall (Etherscan key stays server-side). Launch DISCOVERY — which tokens to
  // list — is the one remaining external dependency, sourced from GeckoTerminal
  // new_pools / an indexer at un-gate; until then `baselines` is empty and the
  // explorer degrades to its clean empty state. Wiring is complete; only the feed
  // is pending.
  useEffect(() => {
    if (!isLauncherEnabled()) return;
    if (!publicClient) return;
    // INTEGRATOR-FILTERED, deliberately. These two surfaces claim "launched and
    // graduated through THIS rail", so they may only ever list assets whose Airlock
    // record names our integrator. The market-wide GeckoTerminal `new_pools` feed is
    // wired too, but it renders in the separately-labelled <LaunchRadar /> below —
    // pouring it in here would fabricate a track record.
    //
    // `readOurLaunches` cannot be a topic filter: Airlock's `Create` event indexes
    // only `numeraire` and carries no integrator at all, so it enumerates Create and
    // then reads `getAssetData(asset)` word[9] per asset. See ourLaunches.ts.
    // Empty stays empty until launch #1 — that is the honest state, not a bug.
    const ac = new AbortController();
    void (async () => {
      // getLogs comes from our backend (`?resource=launch-cohort`): the Airlock's whole
      // Create history is millions of blocks and every browser-reachable RPC refuses that
      // range, which is why this surface was permanently empty. Provenance still happens
      // client-side inside readOurLaunches.
      //
      // Drive the banner off `complete`, NOT off a catch. readOurLaunches NEVER throws — it
      // degrades every failure to an empty result and reports `complete: false` — so a
      // try/catch here is dead code that silently never fires, and an unreadable history
      // would render as "nothing has launched": the fabricated track record this path
      // exists to prevent. (Written as a catch first; caught by reading ourLaunches.ts.)
      const { baselines, poolByToken, complete } = await readOurLaunches({
        client: cohortLogClient(publicClient, { signal: ac.signal }),
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      setCohortUnavailable(!complete);
      if (baselines.length === 0) {
        setExplorer({ launches: [], outcomes: {} });
        return;
      }
      try {
        const r = await fetchLauncherOutcomes({ baselines, poolByToken, signal: ac.signal });
        setExplorer({ launches: r.launches, outcomes: r.outcomes });
      } catch {
        setExplorer({ launches: [], outcomes: {} }); // client throws on net/HTTP — degrade to empty
      }
    })();
    return () => ac.abort();
  }, [publicClient]);

  const onLaunch = async () => {
    if (launch.phase === 'pending') return;
    if (!isConnected || !address || !walletClient || !publicClient) {
      setLaunch({ phase: 'error', message: 'Connect a wallet to launch.' });
      return;
    }
    // The SDK is pinned to Ethereum mainnet (Doppler chainId 1). Refuse a wrong-chain
    // wallet up front rather than build params against a mismatched address book.
    if (chainId !== DOPPLER_MAINNET.chainId) {
      setLaunch({ phase: 'error', message: 'Switch your wallet to Ethereum mainnet to launch.' });
      return;
    }
    // Numeraire + its USD price. ETH launches use ETH/USD; a TOWELI (exotic) launch MUST
    // use TOWELI/USD and REFUSE a stale/unavailable price — the numeraire price sets the
    // entire auction curve, and TOWELI's thin market makes a bad price the real risk.
    const numeraireAddr = w.numeraire === 'toweli' ? TOWELI_NUMERAIRE : ETH_NUMERAIRE;
    let numerairePriceUsd: number;
    if (w.numeraire === 'toweli') {
      if (!price || price.priceUnavailable || !price.priceSafeForSwaps || !(price.priceInUsd > 0)) {
        setLaunch({ phase: 'error', message: 'TOWELI price is unavailable or stale right now. A TOWELI-pegged launch needs a fresh price to set the auction curve — try again shortly.' });
        return;
      }
      numerairePriceUsd = price.priceInUsd;
    } else {
      // `ethUsdForLaunch`, NOT `ethUsd`: the latter carries the 300s swap-safety window,
      // which is 12x tighter than the feed's own 3600s heartbeat and was refusing ~85%
      // of launch attempts against a perfectly healthy oracle. See useToweliPrice.ts.
      numerairePriceUsd = price?.ethUsdForLaunch ?? 0;
      if (!(numerairePriceUsd > 0)) {
        setLaunch({ phase: 'error', message: 'ETH price unavailable right now — try again shortly.' });
        return;
      }
    }
    setLaunch({ phase: 'pending' });
    try {
      const cfg = wizardConfigToLaunchConfig(w, {
        userAddress: address,
        numerairePriceUsd,
        numeraire: numeraireAddr,
        attentionSplits: parseAttentionSplits(w.attentionSplits),
      });
      const result = await launchToken(walletClient, publicClient, cfg);
      setLaunch({ phase: 'success', result });
      // THE BIRTH NOTIFY. After the success state is set, and deliberately not awaited:
      // "the notify NEVER blocks a launch". The token exists on-chain either way, and a
      // launcher must not watch a spinner for a third party's uptime. Failures stay in
      // the queue with their error and surface on the ops panel — never swallowed.
      void notifyBirth({
        chain: 'ethereum',
        ca: result.tokenAddress,
        creator: address,
        txHash: result.transactionHash,
        gateDecisionId: result.gateDecisionId,
        publicClient,
      });
    } catch (e) {
      // A broadcast-stage failure (classically an RPC receipt-wait timeout) may mean the
      // tx is already on-chain. Surface a distinct "may be confirming" state and BLOCK a
      // blind retry — relaunching would mint a duplicate token, split the liquidity and
      // double the payment. Pre-broadcast failures fall through to the normal retryable error.
      if (e instanceof LaunchError && e.broadcast) {
        setLaunch({ phase: 'error', message: e.message, broadcast: true, txHash: e.txHash });
      } else {
        const message = e instanceof LaunchError ? e.message : e instanceof Error ? e.message : 'Launch failed.';
        setLaunch({ phase: 'error', message });
      }
    }
  };

  // Post-launch: write the Fact Sheet on-chain as an EAS attestation (the disclosure
  // becomes verifiable + composable). Non-fatal to the launch — the token is already live.
  // Probe whether the disclosure schema is registered once a launch lands.
  useEffect(() => {
    if (launch.phase !== 'success' || !publicClient) { setSchemaReady(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const rec = await publicClient.readContract({
          address: EAS_SCHEMA_REGISTRY_MAINNET,
          abi: EAS_SCHEMA_REGISTRY_ABI,
          functionName: 'getSchema',
          args: [factSheetSchemaUid()],
        }) as { uid?: `0x${string}` };
        // A registered schema has a non-zero uid; the empty record returns 0x0…0.
        // Conservative: any unexpected decode (missing uid) reads as NOT ready, so
        // the button hides rather than offering an attestation that would revert.
        const registered = typeof rec?.uid === 'string' && !/^0x0*$/.test(rec.uid);
        if (!cancelled) setSchemaReady(registered);
      } catch {
        if (!cancelled) setSchemaReady(null); // unknown — leave the button, guard in onAttest
      }
    })();
    return () => { cancelled = true; };
  }, [launch.phase, publicClient]);

  const onAttest = async () => {
    if (attest.phase === 'pending' || launch.phase !== 'success') return;
    if (!isLauncherEnabled() || !isConnected || !walletClient || !publicClient) return;
    // Belt-and-suspenders: never send an attestation the schema can't accept.
    if (schemaReady === false) {
      setAttest({ phase: 'error', message: 'Fact Sheet attestation isn’t live yet — the disclosure schema has not been registered on-chain. Your launch is unaffected.' });
      return;
    }
    setAttest({ phase: 'pending' });
    try {
      // Attest FACTS RE-COLLECTED FROM THE DEPLOYED TOKEN — never the mutable wizard
      // projection (`sheet`), which a launcher could edit post-launch to attest a false
      // disclosure (e.g. deploy 20% insider, set the slider to 0%, attest "0%"). The
      // collector reads the token's REAL powers (via template-match), supply, factory +
      // codehash; LP-lock/tier stay conservative until graduation, so the attestation is
      // a truthful point-in-time snapshot, not an aspirational projection.
      const observedAt = Math.floor(Date.now() / 1000);
      const raw = await collectTokenFacts(viemChainReader(publicClient), launch.result.tokenAddress as Address, {
        chainId: DOPPLER_MAINNET.chainId,
        now: observedAt,
        // Attest the RESOLVED split captured at launch (immutable) — not the
        // static 70/10 template, which never matches what the locker pays. This
        // is captured from the deployed config in launch.result, so it cannot be
        // forged by editing the still-mutable wizard after launch.
        feeConstitution: launch.result.feeConstitution,
      });
      const sheetForToken = buildFactSheet(raw);
      const { uid, txHash } = await attestFactSheet(walletClient, publicClient, sheetForToken);
      setAttest({ phase: 'done', uid, txHash });
    } catch (e) {
      setAttest({ phase: 'error', message: e instanceof Error ? e.message : 'Attestation failed.' });
    }
  };

  if (!isLauncherEnabled()) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <LaunchHeader lpPhase={lpPhase} />
        <FeatureNotDeployed
          pageId="community"
          idx={5}
          title="The launch rail isn't live yet"
          subtitle="Launching opens once the core loop is live, treasury ownership is re-homed, and TOWELI has an active market. The engine (Doppler V4 on mainnet) is integrated and verified — this is a sequencing gate, not a build gate."
        />
        {/* Pre-launch explainer. Rendered only in the gated state, BENEATH the SOON
            wall (which stays exactly as-is), so /launch teaches the rail instead of
            being a bare placeholder. No dates, no metrics, no simulated activity. */}
        <LauncherExplainer />
      </div>
    );
  }

  const set = <K extends keyof WizardState>(k: K, v: WizardState[K]) => setW((s) => ({ ...s, [k]: v }));
  const canNext = step === 0 ? w.name.trim().length > 0 && w.symbol.trim().length > 0 : true;
  // Any non-blank attention-split row that isn't a valid (address, positive %)
  // blocks the launch — the fee stream is perpetual and immutable, so a mistyped
  // beneficiary must never be silently dropped at submit.
  const hasInvalidSplit = w.attentionSplits.some((r) => splitRowStatus(r).invalid);

  return (
    <>
      <PageArtBackdrop pageId="launch" />
      <div className="relative z-10 max-w-3xl mx-auto px-4 py-10">
      <LaunchHeader lpPhase={lpPhase} />

      {/* THE DOOR, above the wizard. It reads held time live and explains itself, so a
          cold builder learns what warmth is here rather than at the submit button.
          The wizard stays usable either way — the gate is read again, live, inside
          launchToken(), which is the only place it decides anything. */}
      <div className="mt-4 mb-2">
        <LaunchGate rail="ethereum" />
      </div>

      <Stepper step={step} />

      <m.div
        key={step}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="rounded-2xl p-6 sm:p-8 mt-4"
        style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
      >
        {step === 0 && <StepDetails w={w} set={set} />}
        {step === 1 && <StepTier w={w} set={set} />}
        {step === 2 && <StepFees w={w} set={set} sheet={sheet} />}
        {step === 3 && <StepReview w={w} sheet={sheet} />}
      </m.div>

      <div className="flex items-center justify-between mt-5">
        <button
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="px-4 py-2 rounded-lg text-sm text-white/70 disabled:opacity-30 hover:text-white transition"
        >
          ← Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
            disabled={!canNext}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
          >
            Continue →
          </button>
        ) : (
          <button
            onClick={onLaunch}
            disabled={launch.phase === 'pending' || !isConnected || hasInvalidSplit || (launch.phase === 'error' && launch.broadcast === true)}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
            title={
              hasInvalidSplit
                ? 'Fix or remove the invalid attention beneficiary row(s) first.'
                : isConnected
                  ? 'Submits the Doppler create() transaction on Ethereum mainnet.'
                  : 'Connect a wallet to launch.'
            }
          >
            {launch.phase === 'pending' ? 'Launching…' : isConnected ? 'Review & launch' : 'Connect wallet to launch'}
          </button>
        )}
      </div>

      {step === STEPS.length - 1 && launch.phase !== 'idle' && (
        <LaunchStatusBanner status={launch} attest={attest} onAttest={onAttest} schemaReady={schemaReady} onResetLaunch={() => setLaunch({ phase: 'idle' })} lpPhase={lpPhase} />
      )}

      {/* Rail explainer, restored into the LIVE path 2026-07-31 — it had been stranded in
          the dead `!isLauncherEnabled()` arm since the flag flipped, so the copy a
          first-time launcher needs (audited template, what a Fact Sheet is and is not,
          the fee split, the afterlife) was reaching nobody. Below the wizard so the
          four steps still lead the page. */}
      <LauncherExplainer />

      {/* Post-graduation re-attestation — the fully-verifiable fee disclosure, read
          from the graduated pool's StreamableFeesLocker. Distinct from the pre-launch
          attest above (which snapshots the launch config): this reads the REAL on-chain
          beneficiaries once the token has migrated to its V4 pool. Prefills the token a
          launch just produced, but also works for any earlier launch that has graduated. */}
      <div className="mt-12">
        {/* key remounts the panel with a fresh prefill when a launch lands, so the token
            input syncs without a state-syncing effect. */}
        <PostGraduationReattest
          key={launch.phase === 'success' ? launch.result.tokenAddress : 'none'}
          prefillToken={launch.phase === 'success' ? launch.result.tokenAddress : undefined}
        />
      </div>

      {/* Discovery / outcomes surface. Enriched via the aggregator-catchall adapter
          (GeckoTerminal + Etherscan) once a discovery feed populates baselines;
          degrades to honest empty states until then. */}
      <div className="mt-12 space-y-8">
        {/* Launch Afterlife — honest cohort ledger over the SAME outcomes the
            explorer lists below. Self-gates to an honest empty statement. */}
        <LaunchAfterlife outcomes={Object.values(explorer.outcomes)} />
        {cohortUnavailable && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            We couldn&rsquo;t read the launch history just now, so the cohort below may be incomplete.
            This is a problem on our side — it does <span className="font-semibold">not</span> mean no
            tokens have launched.
          </div>
        )}
        <LaunchExplorer launches={explorer.launches} outcomes={explorer.outcomes} />
        {/* MARKET-WIDE radar — deliberately BELOW and visually distinct from the two
            cohort surfaces above. Those promise tokens that graduated through THIS
            rail and stay honestly empty until one does; this is the whole market,
            labelled as such, and exists to point the detection engine at it. */}
        <LaunchRadar />
      </div>
      </div>
    </>
  );
}

function LaunchStatusBanner({ status, attest, onAttest, schemaReady, onResetLaunch, lpPhase }: { status: LaunchStatus; attest: AttestStatus; onAttest: () => void; schemaReady: boolean | null; onResetLaunch: () => void; lpPhase: LpEmissionsPhase }) {
  if (status.phase === 'idle') return null;
  if (status.phase === 'pending') {
    return (
      <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
        Submitting the Doppler <code className="text-emerald-100">create()</code> transaction — confirm in your wallet…
      </div>
    );
  }
  if (status.phase === 'error') {
    // A possibly-broadcast failure: the tx may already be on-chain, so we must NOT invite a
    // one-click relaunch. Show the pending tx (when known) and gate retry behind an explicit
    // "it didn't go through" acknowledgement that resets the launcher.
    if (status.broadcast) {
      const txUrl = status.txHash ? `https://etherscan.io/tx/${status.txHash}` : undefined;
      return (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 break-words">
          <div className="font-semibold mb-1">Your launch may already be on-chain.</div>
          <p className="text-amber-200/90 leading-relaxed">
            The transaction was broadcast but its result didn’t come back (often an RPC timeout). It may still be
            confirming — or may already have created your token. <strong>Check your wallet or Etherscan before trying
            again</strong>: launching twice would mint a duplicate token and split your liquidity.
          </p>
          {txUrl && (
            <a href={txUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block underline hover:text-white break-all">
              View the pending transaction on Etherscan →
            </a>
          )}
          <div className="mt-3">
            <button
              onClick={onResetLaunch}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-amber-400/40 text-amber-100 hover:bg-amber-500/10 transition"
            >
              It didn’t go through — let me retry
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200 break-words">
        {status.message}
      </div>
    );
  }
  const { result } = status;
  const txUrl = `https://etherscan.io/tx/${result.transactionHash}`;
  const tokenUrl = `https://etherscan.io/token/${result.tokenAddress}`;
  return (
    <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
      <div className="font-semibold mb-1">Launched.</div>

      {/* THE HAND-OFF. The permalink at /launch/:token is the only artifact here that
          is ours and is worth sharing — it renders the Fact Sheet, provenance and
          graduation state from live on-chain reads. Until this link existed the flow
          ended at Etherscan at the exact moment a creator most wants something to post,
          and the page they had just earned was reachable only from the Explorer. */}
      <Link
        to={`/launch/${result.tokenAddress}`}
        className="mt-2 mb-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-emerald-400"
      >
        View your token’s page →
      </Link>
      <p className="text-emerald-200/60 text-xs mb-3 -mt-1">
        Permanent, shareable, and generated from on-chain reads — not from what you typed here.
      </p>

      <div className="text-emerald-200/90 space-y-0.5 break-all">
        <div>
          Token:{' '}
          <a href={tokenUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            {result.tokenAddress}
          </a>
        </div>
        <div>
          Transaction:{' '}
          <a href={txUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            {result.transactionHash}
          </a>
        </div>
      </div>

      {/* Attest the Fact Sheet on-chain — makes the disclosure verifiable + composable. */}
      <div className="mt-3 pt-3 border-t border-emerald-500/20">
        {attest.phase === 'done' ? (
          <div className="text-emerald-200/90 break-all">
            Disclosures attested on-chain (EAS).{' '}
            <a
              href={`https://easscan.org/attestation/view/${attest.uid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white"
            >
              View attestation
            </a>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              onClick={onAttest}
              disabled={attest.phase === 'pending' || schemaReady === false}
              title={schemaReady === false ? 'The disclosure schema is not registered on-chain yet.' : undefined}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
            >
              {attest.phase === 'pending' ? 'Attesting…' : 'Attest disclosures on-chain'}
            </button>
            {schemaReady === false && attest.phase !== 'error' && (
              <span className="text-white/50 text-xs break-words">Attestation isn’t live yet — the disclosure schema hasn’t been registered on-chain. Your launch is unaffected.</span>
            )}
            {attest.phase === 'error' && <span className="text-rose-300 text-xs break-words">{attest.message}</span>}
          </div>
        )}
      </div>

      {/* Afterlife — a day-2 economy that few other launchers offer. The LP-farming clause
          is read from TegridyLPFarming.periodFinish, not asserted: it said "boosted LP
          farming today" for six weeks after the last emissions period ended 2026-06-15.
          ba4d3399 corrected this sentence to a static "period ended and is not currently
          funded"; the live read replaces it so a re-funded period needs no code change. */}
      <p className="text-emerald-200/60 text-xs mt-3 leading-relaxed">
        After the auction graduates into a V4 pool, this token can plug into the Tegridy
        economy — {dayTwoEconomyPhrase(lpPhase)}. Few launchers give a launch any day-2
        economy at all.
      </p>
    </div>
  );
}

/**
 * Post-graduation re-attestation. The pre-launch attest (above) snapshots the fee
 * constitution the launch was CONFIGURED with — correct at that moment, but the
 * StreamableFeesLocker stream that actually pays those fees only exists AFTER the token
 * graduates into its V4 pool. This panel reads that stream's REAL beneficiaries, reverses
 * them to a labelled fee split, and attests the fully-verifiable disclosure — with the
 * lock status read from the same locker (not the pre-graduation default).
 *
 * The `creator` line resolves to the CONNECTED wallet, mirroring the launch-time resolver
 * (creator == the launching wallet). Re-attest from that wallet for the creator line to
 * label; from any other wallet, the creator's share still shows — as its own address —
 * with exact bps, because the shares/addresses come straight off-chain.
 */
type ReattestPhase =
  | { phase: 'idle' }
  | { phase: 'reading' }
  | { phase: 'not-graduated' }
  | { phase: 'ready'; sheet: LaunchFactSheet; lines: FeeConstitutionLine[]; poolId: string; locker: string; pair: string }
  | { phase: 'attesting'; sheet: LaunchFactSheet; lines: FeeConstitutionLine[]; poolId: string; locker: string; pair: string }
  | { phase: 'done'; uid: string; txHash: string }
  | { phase: 'error'; message: string };

function feeLineLabel(l: FeeConstitutionLine): string {
  if (l.role === 'attention-beneficiary' && l.recipient.startsWith('0x') && l.recipient.length >= 10) {
    return `${l.recipient.slice(0, 6)}…${l.recipient.slice(-4)}`;
  }
  return l.recipient;
}

function PostGraduationReattest({ prefillToken }: { prefillToken?: string }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [tokenInput, setTokenInput] = useState(prefillToken ?? '');
  const [state, setState] = useState<ReattestPhase>({ phase: 'idle' });
  const [schemaReady, setSchemaReady] = useState<boolean | null>(null);
  // Prefill sync is handled by a `key` on the parent (remounts on a fresh launch), so
  // there is no state-syncing effect here — the initial value above is the whole story.

  const onCheck = async () => {
    if (!publicClient) return setState({ phase: 'error', message: 'No RPC client available right now — try again shortly.' });
    const token = tokenInput.trim();
    if (!isAddress(token)) return setState({ phase: 'error', message: 'Enter a valid token address (0x…).' });
    if (!isConnected || !address) return setState({ phase: 'error', message: 'Connect the creator wallet to re-attest.' });
    if (chainId !== DOPPLER_MAINNET.chainId) return setState({ phase: 'error', message: 'Switch your wallet to Ethereum mainnet.' });
    setState({ phase: 'reading' });
    try {
      const tokenAddr = getAddress(token) as Address;
      const ready = await factSheetSchemaRegistered(publicClient);
      setSchemaReady(ready);
      // Auto-detect the base pair: read the locker for each allowed numeraire; the one it
      // actually graduated against has a stream (streams() reverts for the others). ETH-only
      // while exotic is gated off, so this is a single read in the common case.
      let stream: MigrationStream | null = null;
      for (const numeraire of allowedNumeraires()) {
        const s = await readMigrationStream(publicClient, tokenAddr, numeraire);
        if (s.graduated) { stream = s; break; }
      }
      if (!stream) return setState({ phase: 'not-graduated' });
      if (stream.beneficiaries.length === 0) {
        return setState({ phase: 'error', message: 'The migration stream exists but exposes no fee beneficiaries — nothing to attest.' });
      }
      // Label the protocol beneficiary by the pair this token ACTUALLY graduated against:
      // an ETH pool streamed to RevenueDistributor ("Tegridy stakers"), a TOWELI pool to
      // Treasury ("Tegridy treasury"). Using the numeraire-aware sink keeps the reverse
      // (disclosure) map consistent with the forward split — otherwise a TOWELI graduation's
      // Treasury beneficiary would be mislabelled as an unknown attention address.
      const sink = protocolFeeSink(stream.numeraire);
      const lines = beneficiariesToFeeConstitution(stream.beneficiaries, {
        creator: address,
        protocolStakers: sink.address,
        protocolRecipient: sink.recipient,
        doppler: DOPPLER_MAINNET.airlockOwner,
      });
      // Re-collect the token's own facts, but with the REAL fee constitution + a REAL
      // LockResolver built from this same stream (fixing the hardcoded lock default).
      const raw = await collectTokenFacts(viemChainReader(publicClient), tokenAddr, {
        chainId: DOPPLER_MAINNET.chainId,
        now: Math.floor(Date.now() / 1000),
        feeConstitution: lines,
        lockResolver: lockResolverFor(stream),
      });
      const pair = stream.numeraire.toLowerCase() === TOWELI_NUMERAIRE.toLowerCase() ? 'token / TOWELI' : 'token / ETH';
      setState({ phase: 'ready', sheet: buildFactSheet(raw), lines, poolId: stream.poolId, locker: stream.locker ?? '', pair });
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : 'Failed to read the graduated pool.' });
    }
  };

  const onReattest = async () => {
    if (state.phase !== 'ready') return;
    if (!walletClient || !publicClient) return setState({ phase: 'error', message: 'Connect a wallet to attest.' });
    if (schemaReady === false) {
      return setState({ phase: 'error', message: 'The disclosure schema isn’t registered on-chain yet — the on-chain attestation can’t be written. The read above is still accurate.' });
    }
    const { sheet, lines, poolId, locker, pair } = state;
    setState({ phase: 'attesting', sheet, lines, poolId, locker, pair });
    try {
      const { uid, txHash } = await attestFactSheet(walletClient, publicClient, sheet);
      setState({ phase: 'done', uid, txHash });
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : 'Attestation failed.' });
    }
  };

  const busy = state.phase === 'reading' || state.phase === 'attesting';

  return (
    <div className="rounded-2xl p-5 sm:p-6" style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}>
      <h2 className="text-white font-semibold text-sm mb-1">Re-attest the real fees (post-graduation)</h2>
      <p className="text-white/55 text-xs leading-relaxed mb-3">
        Once a launch graduates into its Uniswap V4 pool, its fee split becomes a live on-chain
        stream. This reads the actual beneficiaries from Doppler&rsquo;s StreamableFeesLocker and
        attests them — the fully-verifiable version of the launch-time disclosure.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          className={`${inputCls} flex-1 mt-0 font-mono text-xs`}
          placeholder="0x… graduated token address"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          spellCheck={false}
        />
        <button
          onClick={onCheck}
          disabled={busy}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition shrink-0"
        >
          {state.phase === 'reading' ? 'Reading…' : 'Check graduation'}
        </button>
      </div>

      {state.phase === 'not-graduated' && (
        <p className="mt-3 text-white/60 text-xs leading-relaxed break-words">
          No fee stream for this token in Doppler&rsquo;s StreamableFeesLocker — it either hasn&rsquo;t graduated yet
          (price discovery still running), or it wasn&rsquo;t launched through this rail. Re-attestation reads the
          real split once the auction migrates to its V4 pool.
        </p>
      )}

      {state.phase === 'error' && (
        <p className="mt-3 text-rose-300 text-xs leading-relaxed break-words">{state.message}</p>
      )}

      {(state.phase === 'ready' || state.phase === 'attesting') && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">On-chain fee constitution</div>
          <div className="rounded-xl border border-white/12 overflow-hidden mb-3">
            {state.lines.map((l, i) => (
              <div key={`${l.recipient}-${i}`} className={`flex items-center justify-between px-4 py-2 text-sm ${i % 2 ? 'bg-white/[0.02]' : ''}`}>
                <span className="text-white/75 break-all">{feeLineLabel(l)}</span>
                <span className="text-white/60 tabular-nums shrink-0 ml-3">{(l.shareBps / 100).toFixed(2)}%</span>
              </div>
            ))}
          </div>
          <p className="text-white/40 text-[11px] break-all mb-3">
            {state.pair} · read from locker {state.locker.slice(0, 8)}… · migration pool {state.poolId.slice(0, 10)}…
          </p>
          <FactSheetCard sheet={state.sheet} />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={onReattest}
              disabled={state.phase === 'attesting' || schemaReady === false}
              title={schemaReady === false ? 'The disclosure schema is not registered on-chain yet.' : undefined}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
            >
              {state.phase === 'attesting' ? 'Attesting…' : 'Attest on-chain fees'}
            </button>
            {schemaReady === false && (
              <span className="text-white/50 text-xs break-words">Schema not registered on-chain yet — the read above is accurate, but it can&rsquo;t be attested until then.</span>
            )}
          </div>
        </div>
      )}

      {state.phase === 'done' && (
        <div className="mt-3 text-emerald-200/90 text-xs break-all">
          Real fees attested on-chain (EAS).{' '}
          <a href={`https://easscan.org/attestation/view/${state.uid}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            View attestation
          </a>
        </div>
      )}
    </div>
  );
}

function ExplainerCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-5 sm:p-6"
      style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
    >
      <h2 className="text-white font-semibold text-sm mb-2">{title}</h2>
      <div className="text-white/60 text-xs leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

/**
 * Rail explainer.
 *
 * RESTORED TO THE LIVE PATH 2026-07-31. It was written for the gated branch, and when
 * LAUNCHER_ENABLED flipped true (2026-07-22) the whole `if (!isLauncherEnabled())` arm
 * went dead — orphaning every word of it. This is the copy a first-time launcher reads,
 * so it now renders beneath the wizard as well; the gated arm keeps it too, so re-gating
 * loses nothing. The tense was corrected in the same pass: a card headed "what we are
 * waiting on", and two cross-links calling live rails "gated", were false once they went live.
 *
 * Every claim here is already true of the shipped code or docs/LAUNCHER_STRATEGY.md.
 * The gate floors are READ from defaultGateConfig() and the fee rows from
 * DEFAULT_FEE_CONSTITUTION, so this copy cannot drift from the checker that actually
 * runs. Nothing here promises a date, quotes a yield, or implies any launch has happened.
 */
function LauncherExplainer() {
  const g = defaultGateConfig(0);
  const listableLockDays = Math.floor(g.listableLpLockMinSeconds / DAY);
  const flagshipLockDays = Math.floor(g.flagshipLpLockMinSeconds / DAY);
  const flagshipTeamPct = g.flagshipMaxTeamBps / 100;
  return (
    <div className="mt-8 space-y-4">
      <ExplainerCard title="What the launch rail does">
        <ol className="list-decimal pl-4 space-y-1.5 marker:text-white/30">
          <li>
            <span className="text-white/80">Configure.</span> Name, supply, tier and curve range, LP lock, and any
            team allocation — in a four-step wizard.
          </li>
          <li>
            <span className="text-white/80">Launch.</span> One Doppler <code className="text-white/70">create()</code>{' '}
            transaction on Ethereum mainnet. The token deploys from Doppler's audited template and its V4 auction opens.
          </li>
          <li>
            <span className="text-white/80">Disclose.</span> The launcher re-reads the deployed token on-chain and
            publishes its Fact Sheet, which can then be written as an on-chain EAS attestation.
          </li>
          <li>
            <span className="text-white/80">Graduate.</span> When price discovery completes, liquidity migrates into a
            canonical Uniswap V4 pool — LP locked, trading fees streaming to the split published at launch.
          </li>
        </ol>
      </ExplainerCard>

      <ExplainerCard title="Why an audited template matters">
        <p>
          Neither you nor Tegridy writes the token contract. Every launch is pinned to Doppler's{' '}
          <code className="text-white/70">DopplerERC20V1</code> factory — the template already whitelisted on Doppler's
          mainnet Airlock, with no mint, no fee-on-transfer, no blacklist, and no upgrade path.
        </p>
        <p>
          That is what makes a disclosure checkable instead of merely promised. The gate reads the deployed token's
          factory and clone bytecode, so “supply is fixed” is provenance rather than a claim in a chat group. A token
          that did not come from a recognised template factory fails the very first check.
        </p>
      </ExplainerCard>

      <ExplainerCard title="What a Fact Sheet is">
        <p>
          A machine-generated disclosure — not a certificate, not a safety rating, and not an endorsement. Nothing is
          scored and no human vouches for anything. It records:
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>the originating factory and template codehash;</li>
          <li>every residual power — mint, pause, blacklist, fee-on-transfer, upgrade, wallet cap — in plain language,
            and who holds it;</li>
          <li>whether liquidity is locked, by which locker, and until when;</li>
          <li>the team allocation and how much of it is under on-chain vesting;</li>
          <li>the fee split fixed at launch.</li>
        </ul>
        <p className="pt-1">Two structural tiers, decided by code rather than by us:</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="text-white/80">Community.</span> Recognised template; no mint, transfer tax, blacklist or
            upgrade power; LP locked at least {listableLockDays} days; any team allocation vested on-chain.
          </li>
          <li>
            <span className="text-white/80">Flagship.</span> All of the above, plus admin renounced or held by a
            timelock, LP locked at least {flagshipLockDays} days, no pause power, and team allocation at most{' '}
            {flagshipTeamPct}% of supply.
          </li>
          <li>
            <span className="text-white/80">Below the bar.</span> Still published, and not labelled unsafe. Buyers read
            the same facts and judge for themselves.
          </li>
        </ul>
        <p className="text-white/40">
          A tier describes structural configuration at a point in time, not the quality of a project. Off-template
          outcomes — post-cliff selling, abandonment — are disclosed and tracked, never claimed to be prevented.
        </p>
      </ExplainerCard>

      <ExplainerCard title="The fee split is fixed at launch">
        <p>
          These shares divide the <strong>graduated pool&apos;s {GRADUATED_FEE_PCT}% trade fee</strong> — published in the
          Fact Sheet and never a marketing dial. They do <strong>not</strong> split the {AUCTION_FEE_PCT}% auction fee:
          during the auction the protocol takes a third-party integrator fee, and no share of it is enforced on-chain or
          promised to you (Terms §7). These are the shares the rail launches with — the creator directs their pool
          (optionally carving a share to attention beneficiaries):
        </p>
        <div className="rounded-xl border border-white/12 overflow-hidden mt-1">
          {FEE_POOL_DISPLAY.map((l, i) => (
            <div
              key={l.recipient}
              className={`flex items-center justify-between px-3 py-2 ${i % 2 ? 'bg-white/[0.02]' : ''}`}
            >
              <span className="text-white/70">{l.recipient}</span>
              <span className="text-white/50 tabular-nums">{(l.shareBps / 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
        <p className="text-white/40">
          Creator and attention shares are both creator-directed. Doppler's share is theirs to define within their cap,
          and “constitutional” binds us — not the market.
        </p>
      </ExplainerCard>

      <ExplainerCard title="The Launch Afterlife — a day 2">
        <p>
          Most launchers graduate a token into nothing. Because this launcher sits inside a DeFi protocol that is
          already deployed, a graduated Tegridy launch has somewhere to go: a boosted LP-farming program on its own
          graduated pool — one per-pool staker escrowing Uniswap V4 position NFTs, boosted by veTOWELI — and the
          ability to apply to the existing GaugeController for a share of TOWELI emissions.
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Every afterlife feature is opt-in and reviewed per feature. Launching grants none of them automatically.</li>
          <li>A gauge is an <em>application</em> through the standard timelocked process — not a promise of emissions.</li>
          <li>
            The Uniswap V4 PositionManager is wired, so a graduated launch reports boosted-LP farming as
            <em> eligible</em> — but that means the infrastructure is in place, not that farming is running: the
            per-pool staker is deployed for each launch by a re-homed-Safe owner, never automatically.
          </li>
        </ul>
      </ExplainerCard>

      <ExplainerCard title="What is built, and what is still open">
        <p>
          The engine is integrated rather than sketched: Doppler's mainnet modules are address-verified on-chain, the
          gate and Fact Sheet are pure, unit-tested code, and a full auction creation has been run green against a fork
          of Ethereum mainnet. The rail is open — this page submits a real{' '}
          <code className="text-white/70">create()</code> on Ethereum mainnet.
        </p>
        <p>
          What is still open is the protocol around it, and we would rather you heard it here than found out after
          launching: the sequencing gates this rail was originally meant to wait on — a deep native pool, treasury
          ownership fully re-homed, an active TOWELI market — were waived, not passed. The day-2 economy above is
          infrastructure that exists, not a program currently paying anyone. Judge the launch rail on the Fact Sheet it
          produces, not on the protocol's own traction.
        </p>
      </ExplainerCard>

      {/* Detection-as-design-tool: the simulator is LIVE now (pure client-side), so unlike
          the gated rail below this is a real CTA — preview your distribution before launching. */}
      <p className="text-white/50 text-xs leading-relaxed">
        Planning a launch? Preview your distribution band and Fact-Sheet tier and fix concentration first with the{' '}
        <Link to="/launch-simulator" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">Launch Simulator</Link>.
      </p>
      {/* Cross-link to the Solana sub-brand rail. Secondary by design: the destination is a
          CONFIG PREVIEW with no in-app submit path (SOLANA_LAUNCHER_ENABLED = true since
          2026-07-27, but the page never signs), so this is wayfinding, not a call to
          action. Fee capture only — no TOWELI on Solana. */}
      <p className="text-white/40 text-xs leading-relaxed">
        There is also a Solana leg — a separate fee-capture sub-brand over Meteora&rsquo;s Dynamic Bonding Curve, with no
        TOWELI on Solana and no AMM of our own there. You sign and submit that launch yourself.{' '}
        <Link to="/solana-launch" className="text-white/60 hover:text-white underline transition-colors">
          See the Solana rail
        </Link>
      </p>
    </div>
  );
}

function LaunchHeader({ lpPhase }: { lpPhase: LpEmissionsPhase }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-white">Launch a token</h1>
      <p className="text-white/60 text-sm mt-1 max-w-xl">
        The verifiable, V4-native rail. Every launch uses Doppler's audited non-upgradeable template, publishes a
        machine-checked Fact Sheet, and graduates into a Uniswap V4 pool — with a day-2 economy{' '}
        {/* "LP farming today" was hardcoded and went stale the day the emissions period ended. */}
        ({dayTwoEconomyShortPhrase(lpPhase)}) that few other launchers offer.
      </p>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    // overflow-x-auto (matching LendingPage/DashboardPage tab strips) so the 4 steps SCROLL
    // instead of clipping off the right edge on iPhone-14-width — body{overflow-x:hidden}
    // would otherwise hide step 4 ("Review") entirely.
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2 shrink-0">
          <div
            className={`h-6 w-6 rounded-full grid place-items-center text-[11px] font-semibold ${
              i <= step ? 'bg-emerald-500 text-black' : 'bg-white/10 text-white/50'
            }`}
          >
            {i + 1}
          </div>
          <span className={`text-xs whitespace-nowrap ${i === step ? 'text-white' : 'text-white/50'}`}>{label}</span>
          {i < STEPS.length - 1 && <span className="text-white/20 mx-1">—</span>}
        </div>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block mb-4">
      <span className="text-white/80 text-sm">{label}</span>
      {hint && <span className="text-white/40 text-xs block mb-1">{hint}</span>}
      {children}
    </label>
  );
}

const inputCls =
  'w-full mt-1 px-3 py-2 rounded-lg bg-black/30 border border-white/12 text-white text-sm outline-none focus:border-emerald-500/60 transition';

// One attention-split row. Uses a LOCAL text buffer for the % input so decimals are
// typeable ("1.5"): a value re-derived from rounded bps on every keystroke drops the
// trailing "." and snaps back to a whole number. shareBps stays the source of truth; the
// local text resyncs only on EXTERNAL bps changes (e.g. a row above is removed and this
// one reindexes), never while the user types (their text already produces the current bps).
function AttentionSplitRow({
  row, onAddress, onShare, onRemove,
}: {
  row: WizardState['attentionSplits'][number];
  onAddress: (v: string) => void;
  onShare: (bps: number) => void;
  onRemove: () => void;
}) {
  const [pctText, setPctText] = useState(row.shareBps ? String(row.shareBps / 100) : '');
  useEffect(() => {
    if (Math.round((Number(pctText) || 0) * 100) !== row.shareBps) {
      setPctText(row.shareBps ? String(row.shareBps / 100) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.shareBps]);
  // A non-blank address that doesn't parse is flagged inline (and blocks Launch
  // upstream) instead of being silently dropped at submit. Trim at the boundary:
  // pasted surrounding whitespace is the likeliest real-world cause of a bad row.
  const trimmedAddr = row.address.trim();
  const addrInvalid = trimmedAddr.length > 0 && !isAddress(trimmedAddr);
  return (
    <div>
    <div className="flex items-center gap-2">
      <input
        placeholder="0x… beneficiary"
        value={row.address}
        onChange={(e) => onAddress(e.target.value.trim())}
        aria-invalid={addrInvalid}
        className={`${inputCls} flex-1 mt-0 font-mono text-xs ${addrInvalid ? 'border-rose-400/60' : ''}`}
      />
      <input
        inputMode="decimal"
        placeholder="%"
        value={pctText}
        onChange={(e) => {
          const clean = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
          setPctText(clean);
          onShare(Math.round((Number(clean) || 0) * 100));
        }}
        className={`${inputCls} w-16 mt-0`}
      />
      <button onClick={onRemove} className="text-white/40 hover:text-rose-300 text-sm px-1" aria-label="remove">✕</button>
    </div>
      {addrInvalid && <p className="text-rose-300/80 text-[10px] mt-1 ml-1">Enter a valid 0x address, or remove this row.</p>}
    </div>
  );
}

function StepDetails({ w, set }: { w: WizardState; set: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void }) {
  return (
    <div>
      <Field label="Token name">
        <input className={inputCls} value={w.name} onChange={(e) => set('name', e.target.value)} placeholder="Tegridy Launch" maxLength={64} />
      </Field>
      <Field label="Symbol">
        <input className={inputCls} value={w.symbol} onChange={(e) => set('symbol', e.target.value.toUpperCase())} placeholder="TGL" maxLength={11} />
      </Field>
      <Field label="Metadata URI" hint="IPFS/Arweave link to the token's image + description JSON.">
        <input className={inputCls} value={w.tokenURI} onChange={(e) => set('tokenURI', e.target.value)} placeholder="ipfs://…" />
      </Field>
      <Field label="Total supply" hint="Whole tokens. Fixed at launch — the template cannot mint more.">
        <input className={inputCls} inputMode="numeric" value={w.totalSupply} onChange={(e) => set('totalSupply', e.target.value.replace(/\D/g, ''))} />
      </Field>
    </div>
  );
}

function StepTier({ w, set }: { w: WizardState; set: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void }) {
  // Base-pair selector — only when exotic (TOWELI) launches are enabled. Gated OFF today,
  // so this whole block is dormant and ETH is the only pair until the fork rehearsal flips
  // EXOTIC_LAUNCHES_ENABLED. allowedNumeraires() encodes that gate.
  const exotic = allowedNumeraires().length > 1;
  return (
    <div>
      {exotic && (
        <div className="mb-5">
          <div className="text-white/80 text-sm">Base pair</div>
          <div className="text-white/40 text-xs mb-2">
            Settle the auction in ETH (standard) or TOWELI (exotic). The graduated pool and its fee stream are denominated in the base pair.
          </div>
          <div className="grid grid-cols-2 gap-3">
            {([['eth', 'token / ETH', 'Standard base pair — deepest liquidity, no extra price risk.'],
               ['toweli', 'token / TOWELI', 'Exotic — pegged to TOWELI, inheriting its price and liquidity.']] as const).map(
              ([id, label, blurb]) => (
                <button
                  key={id}
                  onClick={() => set('numeraire', id)}
                  className={`text-left rounded-xl p-3 border transition ${
                    w.numeraire === id ? 'border-emerald-500/70 bg-emerald-500/10' : 'border-white/12 hover:border-white/25'
                  }`}
                >
                  <div className="text-white font-semibold text-sm">{label}</div>
                  <p className="text-white/55 text-xs mt-1 leading-relaxed">{blurb}</p>
                </button>
              ),
            )}
          </div>
          {w.numeraire === 'toweli' && (
            <p className="text-amber-300/80 text-xs mt-2 leading-relaxed">
              Exotic launch: proceeds and the graduated pool are TOWELI-denominated, buyers must hold TOWELI, and the launch is only as
              stable as TOWELI&rsquo;s own price. Market cap is still set in USD; the curve is priced off the live TOWELI/USD rate.
            </p>
          )}
        </div>
      )}
      <div className="grid gap-3">
        {LAUNCH_TIERS.map((t) => (
          <button
            key={t.id}
            onClick={() => set('tier', t.id)}
            className={`text-left rounded-xl p-4 border transition ${
              w.tier === t.id ? 'border-emerald-500/70 bg-emerald-500/10' : 'border-white/12 hover:border-white/25'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-white font-semibold text-sm">{t.label}</span>
              <span className="text-white/50 text-[11px]">{t.curve}</span>
            </div>
            <p className="text-white/60 text-xs mt-1.5 leading-relaxed">{t.blurb}</p>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3 mt-5">
        <Field label="Start mcap ($k)">
          <input className={inputCls} inputMode="numeric" value={w.mcapStartK} onChange={(e) => set('mcapStartK', Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </Field>
        <Field label="Floor mcap ($k)">
          <input className={inputCls} inputMode="numeric" value={w.mcapFloorK} onChange={(e) => set('mcapFloorK', Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </Field>
        <Field label="LP lock (months)">
          <input className={inputCls} inputMode="numeric" value={w.lpLockMonths} onChange={(e) => set('lpLockMonths', Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </Field>
      </div>
      {/* Team allocation — reserved out of the auction and locked to the creator under
          an ON-CHAIN Doppler vesting schedule (so "vested" in the Fact Sheet is a real
          lock, not a promise). 0% = fully fair launch. Capped at the policy maximum. */}
      <Field
        label={w.premineBps > 0 ? `Team allocation: ${(w.premineBps / 100).toFixed(1)}% (vested)` : 'Team allocation: 0% (fair launch)'}
        hint={`Reserved out of the auction and locked to you on-chain (Doppler vesting). 0% is a fully fair launch. Capped at ${MAX_PREMINE_BPS / 100}%.`}
      >
        <input
          type="range"
          min={0}
          max={MAX_PREMINE_BPS}
          step={50}
          value={w.premineBps}
          onChange={(e) => set('premineBps', Number(e.target.value) || 0)}
          className="w-full accent-emerald-500"
        />
      </Field>
      {w.premineBps > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vesting duration (months)" hint="How long your allocation vests on-chain.">
            <input
              className={inputCls}
              inputMode="numeric"
              value={w.vestMonths}
              onChange={(e) => set('vestMonths', Number(e.target.value.replace(/\D/g, '')) || 0)}
            />
          </Field>
          <Field label="Cliff (months, optional)" hint="No tokens unlock before the cliff. Must be ≤ the duration.">
            <input
              className={inputCls}
              inputMode="numeric"
              value={w.cliffMonths}
              onChange={(e) => set('cliffMonths', Number(e.target.value.replace(/\D/g, '')) || 0)}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function StepFees({ w, set, sheet }: { w: WizardState; set: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void; sheet: LaunchFactSheet }) {
  // Count ONLY valid rows toward the carve — the "you keep X%" figure must
  // describe what will actually be submitted, not what an invalid (dropped) row
  // appeared to allocate. Mirrors parseAttentionSplits so the two agree.
  const totalSplitBps = w.attentionSplits.reduce((n, s) => splitRowStatus(s).valid ? n + s.shareBps : n, 0);
  const creatorKeepsBps = 8000 - totalSplitBps; // creator+attention pool = 80%
  return (
    <div>
      <h3 className="text-white font-semibold text-sm mb-1">Constitutional fee split</h3>
      <p className="text-white/50 text-xs mb-3">
        Fixed at launch and published in the Fact Sheet — never a marketing dial. These shares divide the{' '}
        <strong>graduated pool&apos;s {GRADUATED_FEE_PCT}% fee</strong>, not the {AUCTION_FEE_PCT}% auction fee — see Terms §7. You direct your pool below.
      </p>
      <div className="rounded-xl border border-white/12 overflow-hidden mb-6">
        {FEE_POOL_DISPLAY.map((l, i) => (
          <div key={l.recipient} className={`flex items-center justify-between px-4 py-2.5 text-sm ${i % 2 ? 'bg-white/[0.02]' : ''}`}>
            <span className="text-white/80">{l.recipient}</span>
            <span className="text-white/60 tabular-nums">{(l.shareBps / 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>

      <h3 className="text-white font-semibold text-sm mb-1">Attention beneficiaries <span className="text-white/40 font-normal">(optional)</span></h3>
      <p className="text-white/50 text-xs mb-2">
        Direct part of your creator share to KOLs/community who bring buyers — the proven distribution
        lever. Carved from your 80% pool; protocol + Doppler are untouched.
      </p>
      <div className="rounded-xl border border-white/12 p-3 mb-6 space-y-2">
        {w.attentionSplits.map((row, i) => (
          <AttentionSplitRow
            key={i}
            row={row}
            onAddress={(v) => { const next = [...w.attentionSplits]; next[i] = { ...row, address: v }; set('attentionSplits', next); }}
            onShare={(bps) => { const next = [...w.attentionSplits]; next[i] = { ...row, shareBps: bps }; set('attentionSplits', next); }}
            onRemove={() => set('attentionSplits', w.attentionSplits.filter((_, j) => j !== i))}
          />
        ))}
        <div className="flex items-center justify-between">
          <button onClick={() => set('attentionSplits', [...w.attentionSplits, { address: '', shareBps: 0 }])} className="text-emerald-400/80 hover:text-emerald-300 text-xs">
            + Add beneficiary
          </button>
          <span className={`text-xs tabular-nums ${creatorKeepsBps < 0 ? 'text-rose-300' : 'text-white/50'}`}>
            {creatorKeepsBps < 0 ? `over-allocated by ${(-creatorKeepsBps / 100).toFixed(1)}%` : `you keep ${(creatorKeepsBps / 100).toFixed(1)}% of the 80%`}
          </span>
        </div>
      </div>

      <h3 className="text-white font-semibold text-sm mb-1">Fact Sheet preview</h3>
      <p className="text-white/50 text-xs mb-3">Exactly what buyers will see — generated by the same automated gate that attests it.</p>
      <FactSheetCard sheet={sheet} />
    </div>
  );
}

function StepReview({ w, sheet }: { w: WizardState; sheet: LaunchFactSheet }) {
  const rows: [string, string][] = [
    ['Token', `${w.name || '—'} (${w.symbol || '—'})`],
    ['Total supply', Number(w.totalSupply || '0').toLocaleString()],
    ['Tier', LAUNCH_TIERS.find((t) => t.id === w.tier)?.label ?? w.tier],
    ['Curve', LAUNCH_TIERS.find((t) => t.id === w.tier)?.curve ?? '—'],
    ['Market cap (Dutch)', `$${w.mcapStartK}k → $${w.mcapFloorK}k (descends)`],
    // The descending Dutch price IS the anti-snipe: a block-0 sniper buys at the top of
    // the curve and pays the most, so front-running the open is structurally unprofitable.
    ['Anti-sniper', 'Descending Dutch price — block-0 buys pay the most'],
    ['LP lock', `${w.lpLockMonths} months`],
    [
      'Team allocation',
      w.premineBps > 0
        ? `${(w.premineBps / 100).toFixed(1)}% — vested ${w.vestMonths}mo${w.cliffMonths ? `, ${w.cliffMonths}mo cliff` : ''}`
        : '0% (fair launch)',
    ],
    ['Graduation', 'Uniswap V4 pool (fees stream to the constitution)'],
  ];
  return (
    <div>
      <div className="rounded-xl border border-white/12 overflow-hidden mb-5">
        {rows.map(([k, v], i) => (
          <div key={k} className={`flex items-center justify-between px-4 py-2.5 text-sm ${i % 2 ? 'bg-white/[0.02]' : ''}`}>
            <span className="text-white/50">{k}</span>
            <span className="text-white/85 text-right">{v}</span>
          </div>
        ))}
      </div>
      {(() => {
        // Show exactly who will receive the creator's fee carve on the final
        // pre-signature screen — the fee stream is perpetual and immutable, so
        // the irreversible action must disclose its beneficiaries. Only valid
        // rows are listed (invalid rows block Launch upstream).
        const validSplits = w.attentionSplits.filter((r) => splitRowStatus(r).valid);
        if (validSplits.length === 0) return null;
        const carvedBps = validSplits.reduce((n, r) => n + r.shareBps, 0);
        return (
          <div className="rounded-xl border border-white/12 overflow-hidden mb-5">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-white/40 bg-white/[0.02]">
              Attention beneficiaries (from the creator&rsquo;s 80% pool)
            </div>
            {validSplits.map((r, i) => (
              <div key={`${r.address}-${i}`} className="flex items-center justify-between px-4 py-2 text-xs">
                <span className="text-white/70 font-mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>
                <span className="text-white/85 tabular-nums">{(r.shareBps / 100).toFixed(1)}%</span>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2 text-xs bg-white/[0.02]">
              <span className="text-white/50">Creator keeps</span>
              <span className="text-white/85 tabular-nums">{((8000 - carvedBps) / 100).toFixed(1)}%</span>
            </div>
          </div>
        );
      })()}
      <FactSheetCard sheet={sheet} />
      <p className="text-white/40 text-xs mt-4">
        Launching submits a single Doppler <code className="text-white/60">create()</code> transaction on Ethereum
        mainnet. Your token deploys from Doppler's audited template, the V4 auction opens, and on graduation liquidity
        migrates to a V4 pool with fees locked to the constitution above.
      </p>
      {/* The irreversible action is one button away, so surface the issuer terms HERE — a
          term nobody is shown is a weak term, and §8–§11 of the Terms are the issuer-side
          ones (you are the issuer; launches are permissionless and final). */}
      <p className="text-white/40 text-xs mt-2">
        By launching you become the <span className="text-white/60">issuer</span> of this token and accept the{' '}
        <Link to="/terms" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
          Terms of Service
        </Link>
        , including the issuer, irreversibility and prohibited-use sections.
      </p>
    </div>
  );
}

function FactSheetCard({ sheet }: { sheet: LaunchFactSheet }) {
  const tierStyle =
    sheet.tier === 'flagship'
      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
      : sheet.tier === 'listable'
        ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
        : 'bg-white/10 text-white/60 border-white/20';
  return (
    <div className="rounded-xl border border-white/12 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-white/80 text-sm font-semibold">Launch Fact Sheet</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${tierStyle}`}>
          {sheet.tier === 'none' ? 'Below listable bar' : sheet.tier.toUpperCase()}
        </span>
      </div>
      <ul className="space-y-1.5">
        {sheet.gateChecks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-xs">
            <span className={c.passed ? 'text-emerald-400' : 'text-white/30'}>{c.passed ? '✓' : '○'}</span>
            <span className="text-white/60">{c.detail}</span>
          </li>
        ))}
      </ul>
      <p className="text-white/35 text-[11px] mt-3 leading-relaxed">
        Facts are point-in-time disclosures, not a safety endorsement. A tier reflects structural configuration, not
        a judgement of the project.
      </p>
    </div>
  );
}
