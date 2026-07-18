import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { LaunchExplorer } from '../components/launcher/LaunchExplorer';
import {
  DEFAULT_FEE_CONSTITUTION,
  LAUNCH_TIERS,
  type LaunchTierId,
  isLauncherEnabled,
} from '../lib/launcher/config';
import { buildFactSheet, type RawTokenFacts } from '../lib/launcher/gate';
import type { LaunchFactSheet } from '../lib/launcher/factSheet';
import { DOPPLER_MAINNET } from '../lib/launcher/doppler.constants';
import {
  launchToken,
  wizardConfigToLaunchConfig,
  LaunchError,
  MAX_PREMINE_BPS,
  type LaunchResult,
  type AttentionSplit,
} from '../lib/launcher/launchService';
import { attestFactSheet } from '../lib/launcher/attestation';
import { collectTokenFacts, viemChainReader } from '../lib/launcher/collector';
import { fetchLauncherOutcomes } from '../lib/launcher/outcomesClient';
import type { LaunchSummary } from '../lib/launcher/ordering';
import type { OutcomeRecord } from '../lib/launcher/outcomes';
import type { LaunchBaseline } from '../lib/launcher/outcomesReader';
import { isAddress, type Address } from 'viem';
import { useTOWELIPriceOptional } from '../contexts/PriceContext';

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
  attentionSplits: [],
};

/** Parse the wizard's KOL rows into valid AttentionSplits (drop blank/invalid rows). */
function parseAttentionSplits(rows: WizardState['attentionSplits']): AttentionSplit[] {
  return rows
    .filter((r) => isAddress(r.address) && Number.isInteger(r.shareBps) && r.shareBps > 0)
    .map((r) => ({ address: r.address as Address, shareBps: r.shareBps }));
}

/**
 * Project the Fact Sheet a launch WILL have, from the wizard config, by running
 * the SAME gate the live collector uses. This is the buyer's-eye preview: it
 * ties the UI directly to gate.ts so what the wizard promises is exactly what
 * gets attested. Doppler-template powers are known-false by construction.
 */
function projectFactSheet(w: WizardState, nowSeconds: number): LaunchFactSheet {
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
    feeConstitution: [...DEFAULT_FEE_CONSTITUTION],
    vesting: [],
    teamAllocationBps: w.premineBps,
    teamAllocationVestedBps: w.premineBps, // wizard only offers on-chain-vested premine
    observedAt: nowSeconds,
  };
  return buildFactSheet(facts);
}

const STEPS = ['Details', 'Tier & curve', 'Fees & disclosure', 'Review'] as const;

type LaunchStatus =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'success'; result: LaunchResult }
  | { phase: 'error'; message: string };

type AttestStatus =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'done'; uid: string; txHash: string }
  | { phase: 'error'; message: string };

export default function LaunchPage() {
  usePageTitle('Launch', 'Launch a token on the verifiable, V4-native Tegridy rail.');
  useMemo(() => trackPageView('/launch'), []);

  const [step, setStep] = useState(0);
  const [w, setW] = useState<WizardState>(INITIAL);
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const sheet = useMemo(() => projectFactSheet(w, now), [w, now]);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const price = useTOWELIPriceOptional();
  const [launch, setLaunch] = useState<LaunchStatus>({ phase: 'idle' });
  const [attest, setAttest] = useState<AttestStatus>({ phase: 'idle' });
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
    const baselines: LaunchBaseline[] = []; // TODO(go-live): populate from new_pools / indexer discovery
    if (baselines.length === 0) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetchLauncherOutcomes({ baselines, signal: ac.signal });
        setExplorer({ launches: r.launches, outcomes: r.outcomes });
      } catch {
        setExplorer({ launches: [], outcomes: {} }); // client throws on net/HTTP — degrade to empty
      }
    })();
    return () => ac.abort();
  }, []);

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
    // ethUsd from the shared price context; a launch cannot proceed without it.
    const ethUsd = price?.ethUsd ?? 0;
    if (!ethUsd || ethUsd <= 0) {
      setLaunch({ phase: 'error', message: 'ETH price unavailable right now — try again shortly.' });
      return;
    }
    setLaunch({ phase: 'pending' });
    try {
      const cfg = wizardConfigToLaunchConfig(w, {
        userAddress: address,
        numerairePriceUsd: ethUsd,
        attentionSplits: parseAttentionSplits(w.attentionSplits),
      });
      const result = await launchToken(walletClient, publicClient, cfg);
      setLaunch({ phase: 'success', result });
    } catch (e) {
      const message = e instanceof LaunchError ? e.message : e instanceof Error ? e.message : 'Launch failed.';
      setLaunch({ phase: 'error', message });
    }
  };

  // Post-launch: write the Fact Sheet on-chain as an EAS attestation (the disclosure
  // becomes verifiable + composable). Non-fatal to the launch — the token is already live.
  const onAttest = async () => {
    if (attest.phase === 'pending' || launch.phase !== 'success') return;
    if (!isLauncherEnabled() || !isConnected || !walletClient || !publicClient) return;
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
        feeConstitution: [...DEFAULT_FEE_CONSTITUTION],
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
        <LaunchHeader />
        <FeatureNotDeployed
          pageId="community"
          idx={5}
          title="The launch rail isn't live yet"
          subtitle="Launching opens once the core loop is live, treasury ownership is re-homed, and TOWELI has an active market. The engine (Doppler V4 on mainnet) is integrated and verified — this is a sequencing gate, not a build gate."
        />
      </div>
    );
  }

  const set = <K extends keyof WizardState>(k: K, v: WizardState[K]) => setW((s) => ({ ...s, [k]: v }));
  const canNext = step === 0 ? w.name.trim().length > 0 && w.symbol.trim().length > 0 : true;

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <LaunchHeader />
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
            disabled={launch.phase === 'pending' || !isConnected}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
            title={
              isConnected
                ? 'Submits the Doppler create() transaction on Ethereum mainnet.'
                : 'Connect a wallet to launch.'
            }
          >
            {launch.phase === 'pending' ? 'Launching…' : isConnected ? 'Review & launch' : 'Connect wallet to launch'}
          </button>
        )}
      </div>

      {step === STEPS.length - 1 && launch.phase !== 'idle' && (
        <LaunchStatusBanner status={launch} attest={attest} onAttest={onAttest} />
      )}

      {/* Discovery / outcomes surface. Enriched via the aggregator-catchall adapter
          (GeckoTerminal + Etherscan) once a discovery feed populates baselines;
          degrades to "No launches yet" until then. */}
      <div className="mt-12">
        <LaunchExplorer launches={explorer.launches} outcomes={explorer.outcomes} />
      </div>
    </div>
  );
}

function LaunchStatusBanner({ status, attest, onAttest }: { status: LaunchStatus; attest: AttestStatus; onAttest: () => void }) {
  if (status.phase === 'idle') return null;
  if (status.phase === 'pending') {
    return (
      <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
        Submitting the Doppler <code className="text-emerald-100">create()</code> transaction — confirm in your wallet…
      </div>
    );
  }
  if (status.phase === 'error') {
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
              disabled={attest.phase === 'pending'}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
            >
              {attest.phase === 'pending' ? 'Attesting…' : 'Attest disclosures on-chain'}
            </button>
            {attest.phase === 'error' && <span className="text-rose-300 text-xs break-words">{attest.message}</span>}
          </div>
        )}
      </div>

      {/* Afterlife — what a graduated Tegridy launch gets that no other launcher offers. */}
      <p className="text-emerald-200/60 text-xs mt-3 leading-relaxed">
        After the auction graduates into a V4 pool, this token can plug into the Tegridy
        economy — boosted LP farming and a gauge-emissions application. No other launcher
        gives a launch a day-2 economy.
      </p>
    </div>
  );
}

function LaunchHeader() {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-white">Launch a token</h1>
      <p className="text-white/60 text-sm mt-1 max-w-xl">
        The verifiable, V4-native rail. Every launch uses an audited non-upgradeable template, publishes a
        machine-checked Fact Sheet, and graduates into a Uniswap V4 pool — with a day-2 economy (farming, gauges)
        that no other launcher offers.
      </p>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={`h-6 w-6 rounded-full grid place-items-center text-[11px] font-semibold ${
              i <= step ? 'bg-emerald-500 text-black' : 'bg-white/10 text-white/50'
            }`}
          >
            {i + 1}
          </div>
          <span className={`text-xs ${i === step ? 'text-white' : 'text-white/50'}`}>{label}</span>
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
  return (
    <div>
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
  const totalSplitBps = w.attentionSplits.reduce((n, s) => n + (s.shareBps || 0), 0);
  const creatorKeepsBps = 8000 - totalSplitBps; // creator+attention pool = 80%
  return (
    <div>
      <h3 className="text-white font-semibold text-sm mb-1">Constitutional fee split</h3>
      <p className="text-white/50 text-xs mb-3">Fixed at launch and published in the Fact Sheet — never a marketing dial. 1% total trade fee.</p>
      <div className="rounded-xl border border-white/12 overflow-hidden mb-6">
        {DEFAULT_FEE_CONSTITUTION.map((l, i) => (
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
          <div key={i} className="flex items-center gap-2">
            <input
              placeholder="0x… beneficiary"
              value={row.address}
              onChange={(e) => { const next = [...w.attentionSplits]; next[i] = { ...row, address: e.target.value }; set('attentionSplits', next); }}
              className={`${inputCls} flex-1 mt-0 font-mono text-xs`}
            />
            <input
              inputMode="decimal"
              placeholder="%"
              value={row.shareBps ? String(row.shareBps / 100) : ''}
              onChange={(e) => { const pct = Number(e.target.value.replace(/[^\d.]/g, '')) || 0; const next = [...w.attentionSplits]; next[i] = { ...row, shareBps: Math.round(pct * 100) }; set('attentionSplits', next); }}
              className={`${inputCls} w-16 mt-0`}
            />
            <button onClick={() => set('attentionSplits', w.attentionSplits.filter((_, j) => j !== i))} className="text-white/40 hover:text-rose-300 text-sm px-1" aria-label="remove">✕</button>
          </div>
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
      <FactSheetCard sheet={sheet} />
      <p className="text-white/40 text-xs mt-4">
        Launching submits a single Doppler <code className="text-white/60">create()</code> transaction on Ethereum
        mainnet. Your token deploys from the audited template, the V4 auction opens, and on graduation liquidity
        migrates to a V4 pool with fees locked to the constitution above.
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
