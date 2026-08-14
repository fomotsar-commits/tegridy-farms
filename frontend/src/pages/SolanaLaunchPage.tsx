// Polyfill MUST load before any @solana/* import — keep this the very first
// import in this lazy chunk's entry (mirrors SolanaSwapPage).
import '../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Keypair } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useAccount } from 'wagmi';
import { toast } from 'sonner';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { LaunchGate } from '../components/LaunchGate';
import { notifyBirth } from '../lib/launcher/notifyBirth';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import { SOL_MINT, USDC_MINT } from '../lib/solana';
import { isLauncherEnabled } from '../lib/launcher/config';
import {
  isSolanaLauncherEnabled,
  isSolanaSubmitReady,
  LIVE_DBC_CONFIG,
  MAX_TOKEN_NAME_CHARS,
  MAX_TOKEN_SYMBOL_CHARS,
  MAX_TOKEN_URI_CHARS,
  asSquadsVault,
  buildDbcPartnerConfig,
  buildLaunchParams,
  DEFAULT_ANTI_SNIPE,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  METEORA_PROTOCOL_FEE_PERCENT,
  MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT,
  type DbcPartnerConfig,
  type DbcLaunchParams,
} from '../lib/launcher/solana/dbc';
import {
  fetchLivePoolConfig,
  feeBpsAtSeconds,
  splitAtFee,
  type LivePoolConfig,
} from '../lib/launcher/solana/liveConfig';
import { submitLaunch, ConfirmationTimeout, LaunchFailedOnChain } from '../lib/launcher/solana/submitLaunch';

// The Solana leg is a fee-capture SUB-BRAND, deliberately separate from the EVM
// flagship launcher. This page is GATED: while isSolanaLauncherEnabled() is false
// it renders the standard "SOON" placeholder and never mounts the wizard.
//
// 🔄 2026-08-04 — IT NOW SUBMITS. Behind the gate the page does two distinct things,
// and conflating them is the mistake to avoid when editing it:
//   1. PREVIEW of the config the OPERATOR would create (vault, quote, market caps).
//      Nobody launching here chooses any of it — a DBC config is immutable.
//   2. SUBMIT (SubmitPanel), which launches against the operator's EXISTING live
//      config. It needs only name/symbol/uri; the curve, fee schedule and fee split
//      come from the config account and are shown as read from chain.
// CONFIG CREATION remains operator-only and out-of-band (dbcClient.createPartnerConfig),
// because that is what verifies the feeClaimer IS the derived Squads v4 vault on-chain.

interface PreviewInputs {
  name: string;
  symbol: string;
  uri: string;
  quote: 'SOL' | 'USDC' | 'custom';
  /** Base58 SPL mint, when quote === 'custom' (an exotic pair). Never TOWELI — TOWELI is EVM-only. */
  customQuoteMint: string;
  /** On-chain decimals (6–9) of the custom quote mint. */
  customQuoteDecimals: string;
  initialMarketCap: string;
  migrationMarketCap: string;
  vaultAddress: string;
  payer: string;
}

type PreviewResult =
  | { ok: true; config: DbcPartnerConfig; launch: DbcLaunchParams }
  | { ok: false; error: string };

function buildPreview(input: PreviewInputs, configPubkey: string, baseMintPubkey: string): PreviewResult {
  try {
    // SOL/USDC are curated; a custom mint is an exotic pair and must carry its decimals.
    // buildDbcPartnerConfig validates the mint (base58) + decimals (6–9), so a bad custom
    // entry surfaces as a preview error rather than a silently mis-scaled curve.
    const quoteMint = input.quote === 'custom' ? input.customQuoteMint.trim() : input.quote === 'USDC' ? USDC_MINT : SOL_MINT;
    const quoteDecimals = input.quote === 'custom' ? Number(input.customQuoteDecimals) : undefined;
    const vault = asSquadsVault(input.vaultAddress);
    const config = buildDbcPartnerConfig({
      feeClaimer: vault,
      config: configPubkey,
      payer: input.payer,
      quoteMint,
      quoteDecimals,
      initialMarketCap: Number(input.initialMarketCap),
      migrationMarketCap: Number(input.migrationMarketCap),
    });
    const launch = buildLaunchParams(
      { config: configPubkey, baseMint: baseMintPubkey, poolCreator: input.payer, payer: input.payer },
      { name: input.name, symbol: input.symbol, uri: input.uri },
    );
    return { ok: true, config, launch };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block mb-3">
      <span className="text-white text-[11px] block mb-1.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
        {label}
      </span>
      {children}
      {hint && <span className="text-white/40 text-[10px] block mt-1">{hint}</span>}
    </label>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[13px] outline-none';
const inputStyle = { border: '1px solid rgba(255,255,255,0.18)' } as const;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-white/75">
      <span>{label}</span>
      <span className="font-mono text-right truncate ml-2">{value}</span>
    </div>
  );
}

// LIVE_DBC_CONFIG now lives in dbc.ts so the NAV can read the same answer — a
// "Soon" pill and a working submit button must never disagree about whether this
// rail can launch.

/**
 * Terms read from the LIVE config account, or nothing.
 *
 * The Fact Sheet above is a PREVIEW of what we would configure. This panel is
 * the opposite: what IS configured, decoded from the account, with the address
 * so a reader can check it themselves. If the read fails it says so — it never
 * falls back to the builder defaults, because a default dressed as a live value
 * is precisely the confusion this panel exists to remove.
 */
type LiveConfigState = 'idle' | 'loading' | 'ok' | 'failed';

/**
 * One read of the live config account, shared by the terms panel and the submit
 * panel.
 *
 * Lifted out of `LiveTerms` when the submit path landed: the button that signs a
 * launch must disclose the SAME opening fee the terms panel shows, and two
 * independent fetches could disagree (one succeeds, one fails) — which is exactly
 * the kind of split-brain a launcher must not have at the moment of signing.
 */
function useLiveConfig(): { state: LiveConfigState; cfg: LivePoolConfig | null } {
  const [state, setState] = useState<LiveConfigState>(LIVE_DBC_CONFIG ? 'loading' : 'idle');
  const [cfg, setCfg] = useState<LivePoolConfig | null>(null);

  useEffect(() => {
    if (!LIVE_DBC_CONFIG) return;
    const ac = new AbortController();
    let alive = true;
    fetchLivePoolConfig(LIVE_DBC_CONFIG, { signal: ac.signal })
      .then((c) => { if (alive) { setCfg(c); setState(c ? 'ok' : 'failed'); } })
      .catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; ac.abort(); };
  }, []);

  return { state, cfg };
}

function LiveTerms({ state, cfg }: { state: LiveConfigState; cfg: LivePoolConfig | null }) {
  if (state === 'idle') return null;

  const pctOf = (bps: number) => (bps / 100).toFixed(2);

  return (
    <div className="mt-3 rounded-xl p-3.5 text-[11px] space-y-2.5" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <p className="text-white/50 text-[10px] uppercase tracking-wide">Live mainnet config</p>

      {state === 'loading' && <p className="text-white/40 text-[10px]">Reading the config account…</p>}

      {state === 'failed' && (
        <p className="text-white/40 text-[10px]">
          Could not read the live config right now. The Fact Sheet above is a builder preview, not
          observed on-chain terms.
        </p>
      )}

      {state === 'ok' && cfg && (
        <>
          <Row label="Config account" value={`${LIVE_DBC_CONFIG!.slice(0, 6)}…${LIVE_DBC_CONFIG!.slice(-4)}`} />
          <Row label="Creator share of fee" value={`${splitAtFee(cfg, 10_000).creatorBps / 100}%`} />
          <Row label="Tegridy share of fee" value={`${splitAtFee(cfg, 10_000).partnerBps / 100}%`} />

          <div className="space-y-1 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-white/60 text-[10px]">
              What a trade actually costs, {cfg.mode} over {(cfg.totalDurationSeconds / 3600).toFixed(0)}h
            </p>
            {[0, 3600, 3 * 3600, cfg.totalDurationSeconds].map((t) => (
              <Row
                key={t}
                label={t === 0 ? 'at launch' : `after ${(t / 3600).toFixed(0)}h`}
                value={`${pctOf(feeBpsAtSeconds(cfg, t))}%`}
              />
            ))}
            <p className="text-white/40 text-[10px]">
              The opening fee is an anti-snipe measure and decays on the schedule above. It is the
              real cost of trading in that window, not a headline rate.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** Explicit escape from a terminal state — never automatic; see `reset`. */
function ResetButton({ onReset, label }: { onReset: () => void; label: string }) {
  return (
    <button type="button" onClick={onReset} className="mt-2 underline text-white/60 hover:text-white text-[10px]">
      {label}
    </button>
  );
}

type SubmitPhase =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'confirming'; signature: string }
  | { phase: 'done'; signature: string; mint: string }
  /** Broadcast, outcome unknown. May have succeeded — never invite a retry. */
  | { phase: 'stranded'; signature: string }
  /** Broadcast, landed, failed. Definitive; the mint keypair is spent. */
  | { phase: 'failedOnChain'; signature: string }
  /** Failed BEFORE broadcast. Nothing landed, so retrying is genuinely safe. */
  | { phase: 'error'; message: string };

/**
 * The submit path: sign and broadcast a launch against the operator's LIVE config.
 *
 * ## Why this panel takes only name/symbol/uri
 *
 * The form above previews the config the OPERATOR would create — vault, quote token,
 * market caps. None of those are yours to choose when launching: a DBC config is
 * IMMUTABLE once created, so a launch inherits the live config's curve, its fee
 * schedule and its fee split wholesale. Rendering those inputs beside a live submit
 * button would imply you are choosing them. You are not, and the terms panel above
 * shows what you actually get, read from the account itself.
 *
 * ## The mint keypair lifetime is the safety-critical part
 *
 * The token's mint must co-sign its own creation, so we hold a keypair. It is created
 * ONCE per attempt and kept in a ref: if the first broadcast fails and the user
 * retries, the retry must reuse the SAME mint, or the retry is a second, different
 * token. That is precisely the double-launch defect the EVM rail shipped and fixed in
 * #125. The keypair is only regenerated after a CONFIRMED success, when starting a
 * genuinely new launch. It never leaves the page and is never persisted.
 */
function SubmitPanel({
  cfg,
  cfgState,
  name,
  symbol,
  uri,
}: {
  cfg: LivePoolConfig | null;
  cfgState: LiveConfigState;
  name: string;
  symbol: string;
  uri: string;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  // The Heat gate's qualifying identity. Deliberately the EVM account, not the Solana
  // one — see SubmitLaunchInput.heatIdentity.
  const { address: evmAddress } = useAccount();
  const [status, setStatus] = useState<SubmitPhase>({ phase: 'idle' });
  const [ack, setAck] = useState(false);

  // See the doc comment: stable across retries, regenerated only after success.
  const mintRef = useRef<Keypair | null>(null);

  /**
   * Leave a terminal state and start a genuinely NEW launch.
   *
   * Clears the mint so the next attempt mints a different token — which is the whole
   * point, and the reason this is an explicit button rather than an automatic reset.
   * Every caller sits behind a state where the previous transaction is settled or
   * has been surfaced for the user to check.
   */
  const reset = useCallback(() => {
    mintRef.current = null;
    setAck(false);
    setStatus({ phase: 'idle' });
  }, []);

  const trimmed = { name: name.trim(), symbol: symbol.trim(), uri: uri.trim() };
  const missing = !trimmed.name || !trimmed.symbol || !trimmed.uri;
  const busy = status.phase === 'signing' || status.phase === 'confirming';
  // Every state in which the transaction reached the network. None of them may offer
  // a one-click retry: 'done' and 'failedOnChain' are settled, and 'stranded' may
  // already have succeeded.
  const terminal =
    status.phase === 'done' || status.phase === 'stranded' || status.phase === 'failedOnChain';
  // The opening fee is the single most expensive surprise on this rail. If the config
  // could not be read we cannot state it, so we do not let the launch proceed blind.
  const termsUnknown = cfgState !== 'ok' || !cfg;

  const openingFeePct = cfg ? (feeBpsAtSeconds(cfg, 0) / 100).toFixed(2) : null;

  const onSubmit = useCallback(async () => {
    if (!publicKey || !LIVE_DBC_CONFIG || missing || busy || terminal) return;
    if (!mintRef.current) mintRef.current = Keypair.generate();
    setStatus({ phase: 'signing' });
    try {
      const res = await submitLaunch({
        connection,
        sendTransaction,
        walletAddress: publicKey.toBase58(),
        // The island measures Base + Ethereum tokens, so the qualifying identity for
        // the launch gate is the connected ETHEREUM wallet, not the Solana one paying
        // for this transaction. The door above explains that; submitLaunch refuses
        // honestly (and pre-broadcast) if it is missing.
        heatIdentity: evmAddress ?? '',
        config: LIVE_DBC_CONFIG,
        mintKeypair: mintRef.current,
        ...trimmed,
        // The moment it is on the network, say so and show the signature. Until this
        // existed the button read "confirm in your wallet" for the whole confirmation
        // window, which is what makes someone reload — and a reload loses the mint ref
        // that stops the next attempt being a second token.
        onBroadcast: (signature) => setStatus({ phase: 'confirming', signature }),
      });
      mintRef.current = null; // launched — a further launch is a NEW token
      setStatus({ phase: 'done', signature: res.signature, mint: res.mint });
      toast.success('Launched on Solana', { description: `${trimmed.symbol} is live` });
      // THE BIRTH NOTIFY, after the success state and deliberately not awaited. The slot
      // is read from the confirmed signature — chain truth, never approximated; if it
      // cannot be read the notify is withheld rather than sent with a guessed birth.
      void (async () => {
        let slot: number | null = null;
        try {
          const st = await connection.getSignatureStatuses([res.signature]);
          slot = st.value[0]?.slot ?? null;
        } catch {
          slot = null;
        }
        await notifyBirth({
          chain: 'solana',
          ca: res.mint,
          // The island measures the EVM identity, so that is the creator it enrols.
          creator: evmAddress ?? '',
          txHash: res.signature,
          gateDecisionId: res.gateDecisionId,
          slot,
        });
      })();
    } catch (err) {
      // ANY error carrying a signature means it reached the network. Never invite a
      // retry on those, and never claim nothing was submitted.
      if (err instanceof ConfirmationTimeout) {
        setStatus({ phase: 'stranded', signature: err.signature });
        toast.warning('Broadcast, not confirmed', { description: 'Check the transaction before trying again.' });
        return;
      }
      if (err instanceof LaunchFailedOnChain) {
        // Definitive: it landed and failed. The mint may now be initialized, so the
        // same keypair cannot be reused — force a fresh one for any next attempt.
        mintRef.current = null;
        setStatus({ phase: 'failedOnChain', signature: err.signature });
        toast.error('Launch failed on-chain', { description: 'The transaction was submitted but did not succeed.' });
        return;
      }
      // Everything that is NOT a ConfirmationTimeout failed BEFORE broadcast — the
      // build threw, the wallet was declined, or the node refused it. Nothing landed,
      // so a retry is safe, and it reuses the same mint because the ref survives.
      const raw = err instanceof Error ? err.message : 'Could not submit the launch.';
      // The signed blockhash is fetched at `finalized` and the window is ~60-90s, so
      // a slow wallet approval expires it. The RPC says "Blockhash not found", which
      // reads like a fault; it is just a stopwatch, and retrying is the fix.
      const message = /blockhash not found|block height exceeded/i.test(raw)
        ? 'The transaction expired before it was approved (they are only valid for about a minute). Nothing was submitted — launch again.'
        : raw;
      setStatus({ phase: 'error', message });
      toast.error('Launch failed', { description: message });
    }
  }, [publicKey, missing, busy, terminal, connection, sendTransaction, trimmed]);

  // Nothing to launch against: the honest gate, and the honest reason.
  if (!LIVE_DBC_CONFIG) {
    return (
      <div className="mt-3 rounded-xl p-3.5 text-[11px]" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
        <p className="text-white/50 text-[10px] uppercase tracking-wide mb-1.5">Launch</p>
        <p className="text-white/50 text-[11px]">
          No live config is published for this deployment, so there is nothing to launch against here yet.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl p-3.5 text-[11px] space-y-2.5" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <p className="text-white/50 text-[10px] uppercase tracking-wide">Launch this token</p>
      <p className="text-white/50 text-[10px] leading-relaxed">
        Your wallet pays the network fee and signs. You are the issuer of the token you create here — the curve,
        fee schedule and fee split come from the live config above and cannot be changed after launch.
      </p>

      {/* THE DOOR. Same rule, same primitive, same tier words as the EVM rail — the
          island's standard does not change with the chain. `rail="solana"` only changes
          the copy about which wallet carries the standing. */}
      <div className="pt-1">
        <LaunchGate rail="solana" />
      </div>

      {/* The opening fee is the single most surprising thing about this rail, so it is
          stated at the point of signing rather than only in the terms panel. */}
      {openingFeePct && (
        <p className="text-amber-300/90 text-[10px] leading-relaxed">
          Anti-snipe: trading opens at a <strong>{openingFeePct}% fee</strong> and decays on the schedule above.
          Early buyers pay materially more than the resting rate.
        </p>
      )}
      {termsUnknown && (
        <p className="text-amber-300/90 text-[10px] leading-relaxed">
          {cfgState === 'loading'
            ? 'Reading the live config…'
            : 'The live config could not be read, so the fee you would pay cannot be shown. Launching is disabled until it reads — retry in a moment.'}
        </p>
      )}

      {status.phase !== 'done' && status.phase !== 'stranded' && (
        <label className="flex items-start gap-2 text-white/60 text-[10px] leading-relaxed cursor-pointer">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
          <span>
            I am the issuer of this token, I have read the <Link to="/terms" className="underline hover:text-white">Terms</Link>,
            and I understand this is irreversible.
          </span>
        </label>
      )}

      {!publicKey ? (
        <p className="text-white/40 text-[10px]">Connect a Solana wallet above to launch.</p>
      ) : status.phase === 'done' ? (
        <div className="space-y-1 text-emerald-200/90 break-all">
          <p className="font-semibold text-emerald-100">Launched.</p>
          <p>Mint: {status.mint}</p>
          <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            View the transaction
          </a>
          <ResetButton onReset={reset} label="Launch another token" />
        </div>
      ) : status.phase === 'stranded' ? (
        <div className="space-y-1 text-amber-200/90 break-all">
          <p className="font-semibold">Broadcast, but not confirmed in time.</p>
          <p className="text-amber-200/70">
            It may have succeeded. Check before launching again — retrying could create a second token.
          </p>
          <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            Check the transaction
          </a>
          <ResetButton onReset={reset} label="It did not land — start a new launch" />
        </div>
      ) : status.phase === 'failedOnChain' ? (
        <div className="space-y-1 text-rose-200/90 break-all">
          <p className="font-semibold">Submitted, but it failed on-chain.</p>
          <p className="text-rose-200/70">
            Your token was not created. The transaction is on the network, so its error explains why.
          </p>
          <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            View the transaction
          </a>
          <ResetButton onReset={reset} label="Start a new launch" />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onSubmit}
            disabled={missing || busy || !ack || termsUnknown}
            className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-40"
          >
            {status.phase === 'signing' ? 'Confirm in your wallet…'
              : status.phase === 'confirming' ? 'Confirming…'
              : 'Launch on Solana'}
          </button>
          {/* Once it is on the network the signature is shown IMMEDIATELY, with an
              explicit do-not-reload. A reload discards the in-memory mint keypair, and
              the next attempt would mint a different token — so this window is the one
              place where losing page state actually costs the user something. */}
          {status.phase === 'confirming' && (
            <div className="text-amber-200/90 text-[10px] break-all space-y-0.5">
              <p>Submitted — waiting for the network to confirm. Do not reload this page.</p>
              <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
                {status.signature.slice(0, 8)}…{status.signature.slice(-8)}
              </a>
            </div>
          )}
          {missing && <p className="text-white/40 text-[10px]">Name, symbol and metadata URI are required.</p>}
          {status.phase === 'error' && (
            <>
              <p className="text-rose-300 text-[10px] break-words">{status.message}</p>
              <p className="text-white/40 text-[10px]">
                Nothing was submitted, so launching again is safe — it will reuse the same token address.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

function FactSheetPreview({ config }: { config: DbcPartnerConfig }) {
  const endingBps = DEFAULT_ANTI_SNIPE.endingFeeBps;
  // feeSplit bps are out of the resting (ending) fee — normalize to % of the fee.
  const pct = (bps: number) => (endingBps > 0 ? ((bps / endingBps) * 100).toFixed(0) : '0');
  const s = config.feeSplit;
  const startPct = (DEFAULT_ANTI_SNIPE.startingFeeBps / 100).toFixed(0);
  const endPct = (endingBps / 100).toFixed(2);
  const hours = (DEFAULT_ANTI_SNIPE.totalDuration / 3600).toFixed(0);
  return (
    <div className="mt-4 rounded-xl p-3.5 text-[11px] space-y-2.5" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <p className="text-white/50 text-[10px] uppercase tracking-wide">Fact Sheet (preview)</p>

      <div className="space-y-1">
        <p className="text-white/60 text-[10px]">Trading-fee split (of each trade fee)</p>
        <Row label={`Meteora protocol (fixed ${METEORA_PROTOCOL_FEE_PERCENT}%)`} value={`${pct(s.meteoraBps)}%`} />
        <Row label="Creator" value={`${pct(s.creatorBps)}%`} />
        <Row label="Tegridy partner vault" value={`${pct(s.partnerBps)}%`} />
      </div>

      <div className="space-y-1 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-white/60 text-[10px]">Anti-snipe fee schedule</p>
        <Row label="Opening fee" value={`${startPct}%`} />
        <Row label="Resting fee" value={`${endPct}%`} />
        <Row label="Decay window" value={`${hours}h ${DEFAULT_ANTI_SNIPE.mode ?? 'exponential'}`} />
      </div>

      <div className="space-y-1 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-white/60 text-[10px]">Migrated liquidity</p>
        <Row
          label="Permanently locked"
          value={`${config.curve.liquidityDistribution.partnerPermanentLockedLiquidityPercentage + config.curve.liquidityDistribution.creatorPermanentLockedLiquidityPercentage}%`}
        />
        <p className="text-white/40 text-[10px]">
          At least {MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT}% of migrated LP is locked; locked-LP fees stream to the vault.
        </p>
      </div>
    </div>
  );
}

function SolanaLaunchInner() {
  const { publicKey, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  // Fresh ephemeral keys for the CONFIG PREVIEW only — they stand in for accounts
  // the operator would create when configuring a new partner config. The mint a
  // real launch uses is generated inside SubmitPanel, which owns its lifetime.
  const [configPubkey] = useState(() => Keypair.generate().publicKey.toBase58());
  const [baseMintPubkey] = useState(() => Keypair.generate().publicKey.toBase58());
  // A stand-in payer used only so the preview builders validate when no wallet is
  // connected; replaced by the connected wallet address when available.
  const [previewPayer] = useState(() => Keypair.generate().publicKey.toBase58());

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [uri, setUri] = useState('');
  const [quote, setQuote] = useState<'SOL' | 'USDC' | 'custom'>('SOL');
  const [customQuoteMint, setCustomQuoteMint] = useState('');
  const [customQuoteDecimals, setCustomQuoteDecimals] = useState('6');
  const [initialMarketCap, setInitialMarketCap] = useState('5000');
  const [migrationMarketCap, setMigrationMarketCap] = useState('50000');
  const [vaultAddress, setVaultAddress] = useState('');

  const payer = publicKey?.toBase58() ?? previewPayer;
  const quoteLabel = quote === 'custom' ? 'quote' : quote;
  // ONE read, shared by the terms panel and the submit panel — see useLiveConfig.
  const live = useLiveConfig();

  const preview = useMemo(
    () =>
      buildPreview(
        { name, symbol, uri, quote, customQuoteMint, customQuoteDecimals, initialMarketCap, migrationMarketCap, vaultAddress, payer },
        configPubkey,
        baseMintPubkey,
      ),
    [name, symbol, uri, quote, customQuoteMint, customQuoteDecimals, initialMarketCap, migrationMarketCap, vaultAddress, payer, configPubkey, baseMintPubkey],
  );

  return (
    <>
      <PageArtBackdrop pageId="solana-launch" />
      <div className="relative z-10 max-w-md mx-auto px-4 py-8">
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-5 relative overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.12)' }}
      >
        <div className="absolute inset-0">
          <ArtImg pageId="launch" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" style={{ filter: 'blur(1.5px) saturate(1.05)' }} />
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.5)' }} />
        </div>

        <div className="relative z-10" style={{ textShadow: '0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)' }}>
          <div className="flex items-center justify-between mb-1">
            <h1 className="heading-luxury text-[18px] text-white">Solana Launch</h1>
            <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              {LIVE_DBC_CONFIG ? 'LIVE' : 'PREVIEW'}
            </span>
          </div>
          <p className="text-white/60 text-[11px] mb-4">
            Fee-capture sub-brand over Meteora&apos;s Dynamic Bonding Curve.{' '}
            {LIVE_DBC_CONFIG
              ? 'You sign and submit your own launch; we never take custody of your token or your funds.'
              : 'This is a configuration preview — nothing is signed or submitted here.'}
          </p>

          <Field label="Token name">
            {/* Neutral placeholders: this rail launches OTHER people's tokens.
                Tegridy-branded examples read as "Tegridy is launching its own
                Solana coin", which is exactly the impression the fee-capture-only
                doctrine exists to avoid (no TOWELI on Solana, ever). */}
            <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your token name" spellCheck={false} maxLength={MAX_TOKEN_NAME_CHARS} />
          </Field>
          <Field label="Symbol">
            <input className={inputCls} style={inputStyle} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="TICKER" spellCheck={false} maxLength={MAX_TOKEN_SYMBOL_CHARS} />
          </Field>
          <Field label="Metadata URI" hint="ipfs:// or https:// pointing at the token metadata JSON.">
            <input className={inputCls} style={inputStyle} value={uri} onChange={(e) => setUri(e.target.value)} placeholder="ipfs://…" spellCheck={false} maxLength={MAX_TOKEN_URI_CHARS} />
          </Field>

          <Field label="Quote token" hint="SOL/USDC are the vetted, deep-liquidity pairs. A custom mint is an exotic pair.">
            <div className="flex gap-1.5">
              {(['SOL', 'USDC', 'custom'] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setQuote(q)}
                  aria-pressed={quote === q}
                  className="flex-1 py-1.5 rounded-lg text-[12px] font-medium text-white transition-colors"
                  style={{
                    background: quote === q ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                    border: quote === q ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  {q === 'custom' ? 'Custom' : q}
                </button>
              ))}
            </div>
          </Field>

          {quote === 'custom' && (
            <>
              <Field label="Custom quote mint" hint="Any SPL mint address. Never TOWELI — TOWELI is EVM-only, never on Solana.">
                <input className={inputCls} style={inputStyle} value={customQuoteMint} onChange={(e) => setCustomQuoteMint(e.target.value)} placeholder="Base58 mint address" spellCheck={false} />
              </Field>
              <Field label="Quote decimals (6–9)" hint="The mint's on-chain decimals. Wrong decimals mis-scale the whole curve.">
                <input className={inputCls} style={inputStyle} type="number" inputMode="numeric" value={customQuoteDecimals} onChange={(e) => setCustomQuoteDecimals(e.target.value)} min={6} max={9} />
              </Field>
              <p className="text-amber-300/80 text-[10px] mb-3 leading-relaxed">
                Exotic pair: a custom quote token can be illiquid, letting the pool graduate into a dead market. Prefer SOL or USDC
                unless there is a real reason to pair against this mint.
              </p>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={`Initial market cap (${quoteLabel})`}>
              <input className={inputCls} style={inputStyle} type="number" inputMode="decimal" value={initialMarketCap} onChange={(e) => setInitialMarketCap(e.target.value)} min={0} />
            </Field>
            <Field label={`Migration market cap (${quoteLabel})`}>
              <input className={inputCls} style={inputStyle} type="number" inputMode="decimal" value={migrationMarketCap} onChange={(e) => setMigrationMarketCap(e.target.value)} min={0} />
            </Field>
          </div>

          <Field
            label="Fee vault (Squads v4)"
            hint="The partner fee authority. Must be a Squads v4 multisig vault — verified on-chain before any real launch, never an EOA."
          >
            <input className={inputCls} style={inputStyle} value={vaultAddress} onChange={(e) => setVaultAddress(e.target.value)} placeholder="Squads vault address" spellCheck={false} />
          </Field>

          {!publicKey && (
            <button type="button" onClick={() => setVisible(true)} disabled={connecting} className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60 mb-1">
              {connecting ? 'Connecting…' : 'Connect Solana Wallet'}
            </button>
          )}

          {preview.ok ? (
            <FactSheetPreview config={preview.config} />
          ) : (
            <p className="mt-3 text-amber-300 text-[11px]">{vaultAddress || name || symbol || uri ? preview.error : 'Fill in the fields above to preview the Fact Sheet.'}</p>
          )}

          {/* Outside the preview ternary on purpose: the live config is a fact
              about mainnet, not about whether this draft validates. */}
          <LiveTerms state={live.state} cfg={live.cfg} />

          <SubmitPanel cfg={live.cfg} cfgState={live.state} name={name} symbol={symbol} uri={uri} />

          <p className="mt-4 text-center text-white/40 text-[10px] leading-relaxed">
            Solana leg is fee-capture only — no TOWELI on Solana, no custom program. Launch parameters are disclosed, not a
            hidden dial. The form above previews the config the operator would create; a launch you submit runs against
            the live config, whose terms are immutable and shown as read from the account.
          </p>
        </div>
      </m.div>

      {/* Rail explainer, restored into the LIVE path 2026-07-31 — it had been stranded in
          the dead `!isSolanaLauncherEnabled()` arm since the flag flipped, so the copy a
          first-time launcher needs was reaching nobody. Below the preview card so the
          config form still leads. */}
      <SolanaLauncherExplainer />
      </div>
    </>
  );
}

function ExplainerCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-5"
      style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
    >
      <h2 className="text-white font-semibold text-[13px] mb-2">{title}</h2>
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

/**
 * Rail explainer, mirroring LaunchPage.tsx's LauncherExplainer.
 *
 * RESTORED TO THE LIVE PATH 2026-07-31. It was written for the gated branch, and when
 * SOLANA_LAUNCHER_ENABLED flipped true (2026-07-27) the whole `if (!isSolanaLauncherEnabled())`
 * arm went dead — orphaning every word of it. This is the copy a first-time launcher
 * reads, so it now renders beneath the preview card as well; the gated arm keeps it too,
 * so re-gating loses nothing. The tense was corrected in the same pass: cards written as
 * "before this opens" / "nothing here is live" were false the moment the flag flipped.
 *
 * Every claim is grounded in shipped code/docs, and every number is READ from dbc.ts
 * (program id, Meteora's protocol take, the anti-snipe defaults, the LP-lock floor) so
 * this copy cannot drift from the builders that actually run. Nothing here names a
 * date, quotes a metric, or implies a launch has happened.
 */
function SolanaLauncherExplainer() {
  const openPct = (DEFAULT_ANTI_SNIPE.startingFeeBps / 100).toFixed(0);
  const restPct = (DEFAULT_ANTI_SNIPE.endingFeeBps / 100).toFixed(2);
  const decayHours = (DEFAULT_ANTI_SNIPE.totalDuration / 3600).toFixed(0);
  return (
    <div className="mt-8 space-y-4">
      <ExplainerCard title="What the Solana rail is — and is not">
        <p>
          A separate, fee-capture sub-brand: a rail for launching{' '}
          <span className="text-white/80">other people&apos;s</span> tokens on Solana through Meteora&apos;s Dynamic
          Bonding Curve. Tegridy&apos;s only position in a launch is the partner fee claimer.
        </p>
        <p>
          <span className="text-white/80">TOWELI is never deployed on Solana</span>, and there is no Tegridy AMM here.
          Solana is fee capture only. Graduated liquidity migrates into Meteora&apos;s own DAMM v2 pool, not into
          anything we run.
        </p>
        <p className="text-white/40">
          It is deliberately a sub-brand, kept separate from the Ethereum flagship launcher so the two do not share a
          reputation.
        </p>
      </ExplainerCard>

      <ExplainerCard title="The token contract is Meteora's, not ours">
        <p>
          We deploy no custom Solana program of our own. Every launch runs against Meteora&apos;s audited Dynamic
          Bonding Curve program, integrated through its published SDK:
        </p>
        <p className="font-mono text-[10px] text-white/50 break-all">{DYNAMIC_BONDING_CURVE_PROGRAM_ID}</p>
        <p>
          The curve pins an immutable SPL token — no mint authority and no update authority — with trading fees
          collected in the quote token, either SOL or USDC.
        </p>
      </ExplainerCard>

      <ExplainerCard title="Fees are published, not a hidden dial">
        <ul className="list-disc pl-4 space-y-1">
          <li>
            Meteora takes a fixed {METEORA_PROTOCOL_FEE_PERCENT}% of every trade fee. The remainder is split between
            the launching creator and the Tegridy partner vault, creator-majority by default.
          </li>
          <li>
            Launches open with a decaying anti-snipe fee — {openPct}% at open, decaying to a {restPct}% resting fee
            over {decayHours} hours — so buying in block 0 is unprofitable.
          </li>
          <li>
            At least {MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT}% of migrated liquidity is permanently locked; the
            default configuration locks the whole partner side, and those locked-LP fees stream to the vault.
          </li>
        </ul>
        <p className="text-white/40">
          Whatever a launch is configured with is surfaced in its Fact Sheet rather than left implicit. These are the
          defaults the builders emit today — not a quote of any past launch, because there have been none.
        </p>
      </ExplainerCard>

      <ExplainerCard title="What has to be true before any real launch">
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="text-white/80">A Squads v4 multisig vault.</span> Meteora&apos;s fee-claim signer has full
            custody of accrued fees and can name any receiver on each claim, so the fee claimer must be a multisig
            vault and never a single key. The builders refuse to produce a config or a claim otherwise.
          </li>
          <li>
            <span className="text-white/80">On-chain verification of that vault.</span> The operator supplies the
            vault&apos;s provenance — its parent multisig and vault index — and the signing wrapper re-derives the
            canonical vault address and confirms the parent is a genuine Squads account before building any
            transaction. A mismatch fails closed.
          </li>
          <li>
            <span className="text-white/80">A signing threshold enforced in code.</span> The wrapper also reads the
            parent multisig&apos;s account data — matched on its Anchor discriminator, so a different Squads account
            type cannot be substituted — and requires a threshold of <strong>at least 2</strong>. A 1-of-1 multisig is
            rejected. This used to be an out-of-band operator check that this page could not prove to you; it is now a
            fail-closed gate in the signing path.
          </li>
          {/* 2026-08-07: this sentence was a hardcoded string claiming "The partner
              config is now live on Solana mainnet, so the rail is armed" — rendered
              unconditionally, on BOTH the live and the gated path. In any build without
              VITE_SOLANA_DBC_CONFIG (which is the state of production today) the page
              therefore showed, on one screen: a PREVIEW badge, a submit panel reading
              "No live config is published for this deployment", and this claim that the
              config is live and the rail armed. Three statements, one screen, two of
              them contradicting the third.
              Now derived from the same LIVE_DBC_CONFIG the badge and the submit panel
              read, so the three can never disagree again. */}
          <li>
            <span className="text-white/80">Sequencing.</span> Solana is deliberately behind the Ethereum rail — a
            later, smaller phase.{' '}
            {LIVE_DBC_CONFIG
              ? 'The partner config is live on Solana mainnet, so the rail is armed; we are still not naming a date for the first launch through it.'
              : 'No partner config is published for this deployment yet, so nothing can launch through this rail today — the page above is a configuration preview.'}
          </li>
        </ul>
      </ExplainerCard>

      <p className="text-center text-white/40 text-[10px] leading-relaxed px-2">
        You sign and submit your own launch here, against a partner config the operator created out of band. That
        separation is the point: creating a config is what requires the fee claimer to be the derived Squads vault,
        and that step never runs in your browser.
      </p>
    </div>
  );
}

export default function SolanaLaunchPage() {
  // 2026-08-07: the description was the unconditional string "Preview the Tegridy
  // Solana fee-capture launch config (Meteora DBC)" — written before this page had a
  // submit path. It has one now (see the submitLaunch import and call above), so the
  // one page that could counterbalance the site's Ethereum-only framing was describing
  // itself as a preview in the exact field crawlers and link-unfurlers read.
  // Derived from the same predicate the page's own LIVE/PREVIEW badge uses, so the
  // meta and the badge can never disagree.
  usePageTitle(
    'Solana Launch',
    isSolanaSubmitReady()
      ? 'Launch an SPL token on Solana mainnet through Meteora’s Dynamic Bonding Curve — disclosed fees, anti-snipe schedule and locked liquidity, published before you sign.'
      : 'Preview the Tegridy Solana launch config (Meteora DBC) — fees, anti-snipe schedule and LP lock, disclosed up front.',
  );
  useEffect(() => {
    trackPageView('solana-launch');
  }, []);

  if (!isSolanaLauncherEnabled()) {
    return (
      <div className="max-w-md mx-auto px-4 py-10">
        {/* ⚠ UNREACHABLE TODAY. SOLANA_LAUNCHER_ENABLED is true
            (lib/launcher/solana/dbc.ts), so this branch never renders and
            /solana-launch always shows the live submit flow. Kept as the fail-closed
            path if the flag is turned off. NOTE this is a different gate from
            /solana (the SWAP surface), which IS currently walled because
            VITE_SOLANA_FEE_ACCOUNT is unset — that one is reachable and accurate. */}
        <FeatureNotDeployed
          pageId="launch"
          idx={0}
          title="Solana launch isn't live yet"
          subtitle="A fee-capture sub-brand launcher over Meteora's Dynamic Bonding Curve — disclosed fees, anti-snipe schedule, locked liquidity. Coming soon."
        />
        {/* Pre-launch explainer. Rendered only in the gated state, BENEATH the SOON
            wall (which stays exactly as-is), so /solana-launch teaches the rail instead
            of being a bare placeholder. Mirrors LaunchPage's LauncherExplainer. No
            dates, no metrics, no simulated activity — and it states plainly that this
            rail launches OTHER people's tokens: TOWELI is never deployed on Solana. */}
        <SolanaLauncherExplainer />
        {/* Reciprocal cross-link back to the EVM flagship rail.
            2026-08-07: this arm renders only when the Solana kill switch
            (SOLANA_LAUNCHER_ENABLED in lib/launcher/solana/dbc.ts) is pulled, so it is
            not on screen today — but its copy had gone stale and would have been wrong
            the moment it WAS shown. Both the comment and the sentence claimed the EVM
            rail "is gated as well"; LAUNCHER_ENABLED has been true since the 2026-07-22
            go-live. Now derived from isLauncherEnabled() rather than asserted. */}
        <p className="text-white/40 text-xs leading-relaxed mt-6 text-center">
          The flagship rail is on Ethereum mainnet, built on Doppler V4.
          {isLauncherEnabled() ? ' It is live.' : ' It is gated as well.'}{' '}
          <Link to="/launch" className="text-white/60 hover:text-white underline transition-colors">
            See the mainnet rail
          </Link>
        </p>
      </div>
    );
  }

  return (
    <SolanaProviders>
      <SolanaLaunchInner />
    </SolanaProviders>
  );
}
