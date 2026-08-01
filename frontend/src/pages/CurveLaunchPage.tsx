// Polyfill MUST load before any @solana/* import — keep this the very first
// import in this lazy chunk's entry (mirrors SolanaLaunchPage / SolanaSwapPage).
import '../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import {
  CurveQuoteError,
  LAUNCH_ERROR_COPY,
  TEGRIDY_LAUNCH_PROGRAM_ID,
  applySlippage,
  buyBlockedReason,
  classifyLaunchPhase,
  formatSol,
  formatTokenAmount,
  graduationProgress,
  isZeroPubkey,
  looksLikePubkey,
  parseDecimalToBaseUnits,
  quoteBuy,
  quoteSell,
  raiseCeiling,
  sellBlockedReason,
  spotPriceScaled,
  SPOT_SCALE,
  type BondingCurveState,
  type LaunchPhase,
  type ProgramProbe,
} from '../lib/launcher/solana/curve';
import {
  browserRpc,
  probeProgram,
  readLaunch,
  readMint,
  type CurveWriteClient,
  type LaunchSnapshot,
  type MintFacts,
} from '../lib/launcher/solana/curveClient';
import type { AccountRead } from '../lib/launcher/solana/curve';

// /curve-launch — the surface for OUR OWN bonding curve
// (solana/tegridy-amm/programs/tegridy-launch), which graduates into our cp-swap
// fork. Sibling to SolanaLaunchPage (the Meteora DBC fee-capture rail); this one
// is our own program rather than someone else's.
//
// 🔴 THE PROGRAM IS NOT DEPLOYED — not mainnet, not devnet. Its id is a
// documented placeholder (lib.rs:97-101) that returns null on mainnet-beta. Two
// consequences shape everything below:
//
//   1. The page CHECKS rather than asserts. The badge, the panels and every
//      number come from `probeProgram()` reading the chain. If someone deploys
//      the program tomorrow this page starts working without an edit; if the RPC
//      is down it says the read failed, and does NOT say "not deployed".
//   2. There is NO write path, deliberately. Not a disabled submit that would
//      otherwise fire — no transaction is ever built. Encoding an instruction
//      against a placeholder id that is guaranteed to change before deploy would
//      be a button that cannot work, and this repo has shipped worse (a "+10% NFT
//      boost" banner no contract paid). The write seam is `CurveWriteClient` in
//      curveClient.ts; when it lands, `writeClient` below turns the quote into a
//      signable action and nothing else here changes.
//
// Everything the page renders about a launch is either read from chain or
// labelled unknown. No price feed, no volume, no holder count, no market cap, no
// USD figure — none of them exist in program state and there is no indexer.

const CARD = 'rounded-2xl p-5 relative overflow-hidden';
const CARD_STYLE = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;
const SHADOW = { textShadow: '0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)' } as const;
const inputCls = 'w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[13px] outline-none';
const inputStyle = { border: '1px solid rgba(255,255,255,0.18)' } as const;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={CARD} style={CARD_STYLE}>
      <h2 className="text-white font-semibold text-[13px] mb-2.5" style={SHADOW}>
        {title}
      </h2>
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

/**
 * Label/value row. Both sides wrap rather than truncate: the cards are
 * `overflow-hidden`, so a clipped value would silently disappear, and a
 * truncated base58 address reads like a different address.
 */
function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-white/75">
      <span className="break-words">{label}</span>
      <span className={`text-right break-all min-w-0 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="text-white text-[11px] block mb-1.5" style={SHADOW}>
        {label}
      </span>
      {children}
      {hint && <span className="text-white/40 text-[10px] block mt-1">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Deployment banner — the gate everything else hangs off
// ---------------------------------------------------------------------------

const PROBE_COPY: Record<
  'checking' | ProgramProbe['status'],
  { badge: string; tone: string; line: string }
> = {
  checking: {
    badge: 'CHECKING',
    tone: 'bg-white/10 text-white/70 border-white/20',
    line: 'Asking the chain whether the program exists…',
  },
  'not-deployed': {
    badge: 'NOT DEPLOYED',
    tone: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    line: 'There is no program at this address. No launches exist, no curve can be traded, and nothing on this page can be signed.',
  },
  unreadable: {
    badge: 'READ FAILED',
    tone: 'bg-rose-500/20 text-rose-200 border-rose-500/30',
    line: 'We could not reach the chain to check. This says nothing about whether the program is live — it only means the lookup failed.',
  },
  deployed: {
    badge: 'DEPLOYED',
    tone: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30',
    line: 'A program exists at this address. Everything below is read from it.',
  },
};

export function DeploymentBanner({ probe }: { probe: ProgramProbe | null }) {
  const key = probe === null ? 'checking' : probe.status;
  const c = PROBE_COPY[key];
  return (
    <m.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={CARD}
      style={CARD_STYLE}
    >
      <div className="absolute inset-0">
        <ArtImg pageId="curve-launch" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" style={{ filter: 'blur(1.5px)' }} />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} />
      </div>
      <div className="relative z-10" style={SHADOW}>
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <h1 className="heading-luxury text-[18px] text-white">Tegridy Curve</h1>
          <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-semibold border ${c.tone}`}>{c.badge}</span>
        </div>
        <p className="text-white/60 text-[11px] leading-relaxed">{c.line}</p>
        {probe?.status === 'unreadable' && <p className="text-rose-200/80 text-[10px] mt-1.5 break-all">{probe.reason}</p>}
        <p className="text-white/35 text-[10px] mt-2 break-all font-mono">{TEGRIDY_LAUNCH_PROGRAM_ID}</p>
        <p className="text-white/35 text-[10px] mt-1 leading-relaxed">
          That id is a placeholder generated so the program compiles. It is replaced with a real key at deploy, so it is
          expected to return nothing today — this badge is a live read, not a hardcoded state.
        </p>
      </div>
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Curve state
// ---------------------------------------------------------------------------

const PHASE_COPY: Record<LaunchPhase['kind'], { label: string; line: string }> = {
  'not-deployed': { label: 'Not deployed', line: 'The program does not exist on chain.' },
  unreadable: { label: "Couldn't read", line: 'A read failed. This is not a statement about the launch.' },
  'not-initialized': {
    label: 'Protocol not initialised',
    line: 'The program exists but its global config has never been created. Not a problem with this mint.',
  },
  'pre-launch': {
    label: 'No curve for this mint',
    line: 'Nothing has been launched on this mint. That is different from a launch that has raised nothing.',
  },
  trading: { label: 'Bonding', line: 'Buys and sells both run against the curve.' },
  'at-target': {
    label: 'At target, still raising the migration reserve',
    line: 'The graduation target is met but the reserve that pays for migration is not yet full. Buys and sells both still work.',
  },
  'awaiting-migration': {
    label: 'Fully funded — awaiting migration',
    line: 'Buys are finished. Selling still works, and anyone may call migration. It has NOT graduated yet.',
  },
  graduated: { label: 'Graduated', line: 'Liquidity has moved to the AMM pool. The curve is closed; trade the pool instead.' },
};

export function CurveStateCard({
  phase,
  curve,
  decimals,
  paused,
}: {
  phase: LaunchPhase;
  /** `null` means no lookup has been attempted — which is NOT a failed read. */
  curve: AccountRead<BondingCurveState> | null;
  decimals: number | null;
  paused: boolean | null;
}) {
  const p = PHASE_COPY[phase.kind];
  return (
    <Card title="Curve state">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-white/90 text-[12px] font-medium">{p.label}</span>
        {paused === true && (
          <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
            BUYS PAUSED · SELLS OPEN
          </span>
        )}
      </div>
      <p>{p.line}</p>
      {phase.kind === 'unreadable' && <p className="text-amber-300/90 break-all">{phase.reason}</p>}

      {curve?.status === 'present' ? (
        <CurveNumbers curve={curve.value} decimals={decimals} />
      ) : (
        <p className="text-white/40">
          {curve === null
            ? // Nothing has been looked up. Saying "the read failed" here would be
              // a claim about a call that was never made.
              'No launch has been looked up yet.'
            : curve.status === 'absent'
              ? 'No curve account, so there are no reserves to show. Deliberately blank rather than zeroed.'
              : 'Curve reserves are unavailable because the read failed.'}
        </p>
      )}
    </Card>
  );
}

function CurveNumbers({ curve, decimals }: { curve: BondingCurveState; decimals: number | null }) {
  const ceiling = raiseCeiling(curve);
  const progress = graduationProgress(curve);
  const spot = spotPriceScaled(curve);
  const sold = formatTokenAmount(curve.realTokenReserves, decimals);
  // Spot price per WHOLE token needs decimals. Without them the only honest
  // figure is per base unit, which we say explicitly rather than scaling by an
  // assumed 9.
  const spotPerToken =
    spot === null ? null : decimals === null ? null : (spot * 10n ** BigInt(decimals)) / SPOT_SCALE;

  return (
    <div className="space-y-2 pt-1">
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-white/60">Raised toward graduation</span>
          <span className="font-mono text-white/80">{(progress * 100).toFixed(2)}%</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden bg-white/10" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-[var(--color-stan)]" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
        <p className="text-white/40 text-[10px] mt-1">
          {formatSol(curve.realSolReserves)} of {formatSol(ceiling)} SOL. The denominator is the graduation target plus
          the migration reserve — the line buys are actually capped at.
        </p>
      </div>

      <Row label="SOL raised (curve reserves)" value={`${formatSol(curve.realSolReserves)} SOL`} />
      <Row label="Graduation target" value={`${formatSol(curve.graduationTargetLamports)} SOL`} />
      <Row label="Migration reserve" value={`${formatSol(curve.migrationReserveLamports)} SOL`} />
      <Row label="Trade fee (this launch)" value={`${(Number(curve.tradeFeeBps) / 100).toFixed(2)}%`} />
      <Row label={`Tokens still on the curve${sold.isBaseUnits ? ' (base units)' : ''}`} value={sold.text} />
      <Row
        label="Spot price"
        value={
          spotPerToken === null
            ? spot === null
              ? '—'
              : `${spot.toString()} / 1e12 lamports per base unit`
            : `${formatSol(spotPerToken, 9)} SOL per token`
        }
      />
      <p className="text-white/35 text-[10px] leading-relaxed">
        Spot is a display ratio off the curve&apos;s virtual + real reserves. Any real trade moves it, so it is not an
        executable price. There is no market cap, volume or holder count here — none of them exist in program state.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

type Side = 'buy' | 'sell';

const SLIPPAGE_OPTIONS = [50n, 100n, 300n];

export function TradePanel({
  phase,
  curve,
  decimals,
  paused,
  writeClient,
}: {
  phase: LaunchPhase;
  curve: AccountRead<BondingCurveState> | null;
  decimals: number | null;
  paused: boolean | null;
  writeClient: CurveWriteClient | null;
}) {
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(100n);

  const c = curve?.status === 'present' ? curve.value : null;
  // Paused is an overlay on buys only. `sell` is deliberately unpausable
  // (lib.rs:563-564) — a pause stops new money entering, it must never strand
  // holders — so a paused protocol must NOT grey out the sell side.
  const blocked = side === 'buy' ? buyBlockedReason(phase, paused === true) : sellBlockedReason(phase);

  const quote = useMemo(() => {
    if (!c || blocked) return null;
    // Buy input is SOL (9 dp, fixed by the chain). Sell input is tokens, which
    // needs the MINT's decimals — unknown decimals means base units, never an
    // assumed 9.
    const raw = side === 'buy' ? parseDecimalToBaseUnits(amount, 9) : parseDecimalToBaseUnits(amount, decimals ?? 0);
    if (raw === null || raw === 0n) return null;
    try {
      return side === 'buy'
        ? ({ side: 'buy', ...quoteBuy(c, raw) } as const)
        : ({ side: 'sell', ...quoteSell(c, raw) } as const);
    } catch (e) {
      return e instanceof CurveQuoteError ? ({ side: 'error', code: e.code } as const) : null;
    }
  }, [c, blocked, side, amount, decimals]);

  const disabled = !c || !!blocked;

  return (
    <Card title="Trade the curve">
      <div className="flex gap-1.5 mb-3">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className="flex-1 py-1.5 rounded-lg text-[12px] font-medium text-white capitalize transition-colors"
            style={{
              background: side === s ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
              border: side === s ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {blocked && <p className="text-amber-300/90 mb-3">{LAUNCH_ERROR_COPY[blocked]}</p>}

      <Field
        label={side === 'buy' ? 'Spend (SOL)' : decimals === null ? 'Sell (token base units)' : 'Sell (tokens)'}
        hint={
          side === 'buy'
            ? 'A ceiling, not a spend — the program caps the last buy of a launch at the graduation line.'
            : decimals === null
              ? "The mint's decimals could not be read, so this is in raw base units."
              : undefined
        }
      >
        <input
          className={`${inputCls} disabled:opacity-50`}
          style={inputStyle}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          inputMode="decimal"
          spellCheck={false}
          disabled={disabled}
          aria-label={side === 'buy' ? 'Amount of SOL to spend' : 'Amount of tokens to sell'}
        />
      </Field>

      <Field label="Slippage tolerance">
        <div className="flex gap-1.5">
          {SLIPPAGE_OPTIONS.map((bps) => (
            <button
              key={bps.toString()}
              type="button"
              onClick={() => setSlippageBps(bps)}
              aria-pressed={slippageBps === bps}
              disabled={disabled}
              className="flex-1 py-1.5 rounded-lg text-[12px] text-white transition-colors disabled:opacity-50"
              style={{
                background: slippageBps === bps ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                border: slippageBps === bps ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
              }}
            >
              {(Number(bps) / 100).toFixed(bps % 100n === 0n ? 0 : 2)}%
            </button>
          ))}
        </div>
      </Field>

      {quote?.side === 'error' && <p className="text-amber-300/90">{LAUNCH_ERROR_COPY[quote.code]}</p>}
      {quote?.side === 'buy' && <BuyQuoteRows quote={quote} decimals={decimals} slippageBps={slippageBps} />}
      {quote?.side === 'sell' && <SellQuoteRows quote={quote} slippageBps={slippageBps} />}

      {/* The write seam. No transaction is built here — see the file header. */}
      {writeClient === null ? (
        <p className="text-white/40 text-[10px] leading-relaxed mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          There is no signing path on this page. The program is not deployed and its on-chain address is still a
          placeholder, so no transaction can be built that would target the real program. The quote above is the same
          arithmetic the program runs — it is shown so the terms are inspectable before any of this goes live.
        </p>
      ) : (
        <button type="button" className="btn-primary w-full py-2.5 text-[13px] mt-3 disabled:opacity-60" disabled={disabled || !quote}>
          Review {side}
        </button>
      )}
    </Card>
  );
}

function BuyQuoteRows({
  quote,
  decimals,
  slippageBps,
}: {
  quote: { cappedIn: bigint; feeLamports: bigint; lamportsToCurve: bigint; tokensOut: bigint; capped: boolean };
  decimals: number | null;
  slippageBps: bigint;
}) {
  const out = formatTokenAmount(quote.tokensOut, decimals);
  const floor = formatTokenAmount(applySlippage(quote.tokensOut, slippageBps), decimals);
  return (
    <div className="space-y-1.5 pt-1">
      {quote.capped && (
        <p className="text-amber-300/90">
          Capped at the graduation line. You will spend {formatSol(quote.cappedIn)} SOL, not the amount entered — the
          remainder is never taken and never leaves your wallet.
        </p>
      )}
      <Row label="You pay" value={`${formatSol(quote.cappedIn)} SOL`} />
      <Row label="…of which fee" value={`${formatSol(quote.feeLamports)} SOL`} />
      <Row label={`You receive${out.isBaseUnits ? ' (base units)' : ''}`} value={out.text} />
      <Row label="Minimum received" value={floor.text} />
      <p className="text-white/35 text-[10px] leading-relaxed">
        A quote is computed from an account snapshot and is stale the moment it is made, so a trade carries the minimum
        above as an on-chain floor. Network fees and the rent for a token account, if you do not already have one, are on
        top of this.
      </p>
    </div>
  );
}

function SellQuoteRows({ quote, slippageBps }: { quote: { gross: bigint; feeLamports: bigint; lamportsOut: bigint }; slippageBps: bigint }) {
  return (
    <div className="space-y-1.5 pt-1">
      <Row label="You receive" value={`${formatSol(quote.lamportsOut)} SOL`} />
      <Row label="…after fee" value={`${formatSol(quote.feeLamports)} SOL`} />
      <Row label="Minimum received" value={`${formatSol(applySlippage(quote.lamportsOut, slippageBps))} SOL`} />
      <p className="text-white/35 text-[10px] leading-relaxed">
        A sell may also be refused if it would drop the curve account below its rent floor. That check reads the
        account&apos;s live balance, so it is only knowable at send time.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const mark = ok === null ? '?' : ok ? '✓' : '✗';
  const tone = ok === null ? 'text-amber-300/90' : ok ? 'text-emerald-300/90' : 'text-rose-300/90';
  return (
    <li className="flex gap-2">
      <span className={`${tone} shrink-0 font-mono`} aria-hidden="true">
        {mark}
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * Create-launch readiness.
 *
 * Deliberately NOT a "choose your curve" form: `create_launch` takes **no
 * arguments at all** (lib.rs:387). Supply, virtual reserves, fee, target and
 * reserve are read from `global` and snapshotted onto the curve, and the program
 * never creates Metaplex metadata — so a name/symbol/image field here would be
 * describing something this instruction does not do. What a creator actually
 * controls is the MINT they bring, so that is what this checks.
 */
export function CreateChecklist({
  mint,
  global,
}: {
  /** `null` on both = nothing looked up yet, which is not a failed read. */
  mint: AccountRead<MintFacts> | null;
  global: LaunchSnapshot['global'] | null;
}) {
  const f = mint?.status === 'present' ? mint.value : null;
  const g = global?.status === 'present' ? global.value : null;
  return (
    <Card title="Open a launch">
      <p>
        Launching mints the entire supply onto a fresh curve and permanently revokes the mint authority in the same
        instruction, so no further supply can ever exist. The curve&apos;s terms are not chosen per launch — they are
        copied from the protocol config at creation and frozen, so nothing can rewrite a live launch&apos;s economics
        afterwards.
      </p>

      <p className="text-white/50 pt-1">Your mint must satisfy:</p>
      <ul className="space-y-1.5">
        <Check ok={f ? f.supply === 0n : null}>
          Supply is zero. The program mints the whole supply itself; a pre-minted token is rejected.
        </Check>
        <Check ok={f ? f.freezeAuthority === null : null}>
          No freeze authority. A retained one could freeze the curve&apos;s vault — a publicly derivable address — and
          lock every lamport raised, permanently.
        </Check>
        <Check ok={f ? f.isLegacySplToken : null}>
          Legacy SPL Token, not Token-2022. Token-2022 mints fail the program&apos;s account validation.
        </Check>
        <Check ok={f ? f.mintAuthority !== null : null}>
          You still hold the mint authority, so the program can mint and then revoke it.
        </Check>
      </ul>

      {mint === null && <p className="text-white/40">No mint looked up, so none of the above has been checked yet.</p>}
      {mint?.status === 'absent' && <p className="text-white/40">No mint at that address yet.</p>}
      {mint?.status === 'unreadable' && (
        <p className="text-amber-300/90">Could not read the mint, so none of the above has been checked: {mint.reason}</p>
      )}
      {f && <Row label="Decimals (read from the mint)" value={String(f.decimals)} />}

      <div className="pt-1.5 space-y-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-white/50 pt-1.5">Terms this launch would be created with:</p>
        {g ? (
          <>
            <Row label="Trade fee" value={`${(Number(g.tradeFeeBps) / 100).toFixed(2)}%`} />
            <Row label="Graduation target" value={`${formatSol(g.graduationTargetLamports)} SOL`} />
            <Row label="Migration reserve" value={`${formatSol(g.migrationReserveLamports)} SOL`} />
            <Row label="Total supply (base units)" value={g.tokenTotalSupply.toString()} />
            <Row
              label="Graduation venue"
              value={isZeroPubkey(g.cpSwapProgram) || isZeroPubkey(g.ammConfig) ? 'not configured yet' : 'configured'}
            />
            {g.paused && <p className="text-amber-300/90">New launches are paused.</p>}
          </>
        ) : (
          <p className="text-white/40">
            {global === null
              ? 'Nothing has been read yet, so the terms are not known.'
              : global.status === 'absent'
                ? 'The protocol config has not been created, so there are no terms to show yet.'
                : 'The protocol config could not be read, so the terms are unknown.'}
          </p>
        )}
      </div>

      <p className="text-white/35 text-[10px] leading-relaxed">
        Name, symbol and image are not part of this. The program stores none of them and never creates token metadata —
        that is a separate Metaplex account on the mint, and a client that showed a name here would be reading it from
        somewhere else entirely.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface CurveLaunchViewProps {
  probe: ProgramProbe | null;
  snapshot: LaunchSnapshot | null;
  mint: AccountRead<MintFacts> | null;
  mintInput: string;
  onMintInput: (v: string) => void;
  onLookup: () => void;
  loading: boolean;
  /** Null until a write client exists. See curveClient.ts's CurveWriteClient. */
  writeClient?: CurveWriteClient | null;
  wallet?: { address: string | null; connecting: boolean; onConnect: () => void };
}

/**
 * Presentational shell, exported so the phase rendering can be driven directly
 * in tests without standing up a wallet provider or an RPC.
 */
export function CurveLaunchView({
  probe,
  snapshot,
  mint,
  mintInput,
  onMintInput,
  onLookup,
  loading,
  writeClient = null,
  wallet,
}: CurveLaunchViewProps) {
  // `null` = no lookup attempted. Kept distinct from a failed read all the way
  // down: the classifier has to call it unreadable (it genuinely cannot say),
  // but the cards must not tell the user that a call failed when none was made.
  const globalRead = snapshot?.global ?? null;
  const curveRead = snapshot?.curve ?? null;
  const notLookedUp = { status: 'unreadable', reason: 'not looked up yet' } as const;
  const phase = classifyLaunchPhase(
    probe ?? { status: 'unreadable', reason: 'still checking' },
    globalRead ?? notLookedUp,
    curveRead ?? notLookedUp,
  );
  const paused = globalRead?.status === 'present' ? globalRead.value.paused : null;
  const decimals = mint?.status === 'present' ? mint.value.decimals : null;

  // A lookup is only meaningful once we know a program is actually there.
  // Offering it beforehand would invite deriving PDAs under a program that does
  // not exist and rendering their absence as data about a launch.
  const canLookUp = probe?.status === 'deployed' && looksLikePubkey(mintInput);

  return (
    <>
      <PageArtBackdrop pageId="curve-launch" />
      <div className="relative z-10 max-w-xl mx-auto px-4 py-8 space-y-4">
        <DeploymentBanner probe={probe} />

        <Card title="Look up a launch">
          <p>
            Launches are found by mint address. They cannot be listed: enumerating them needs an RPC scan our proxy
            deliberately does not allow, so there is no &quot;all launches&quot; view to show — and inventing one would
            mean showing a list we cannot claim is complete.
          </p>
          <Field label="Token mint address">
            <input
              className={`${inputCls} disabled:opacity-50`}
              style={inputStyle}
              value={mintInput}
              onChange={(e) => onMintInput(e.target.value)}
              placeholder="Base58 mint address"
              spellCheck={false}
              disabled={probe?.status !== 'deployed'}
              aria-label="Token mint address"
            />
          </Field>
          <button
            type="button"
            onClick={onLookup}
            disabled={!canLookUp || loading}
            className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
          >
            {loading ? 'Reading…' : 'Look up'}
          </button>
          {probe?.status === 'not-deployed' && (
            <p className="text-white/40">Nothing to look up while the program does not exist.</p>
          )}
          {mintInput.trim() !== '' && !looksLikePubkey(mintInput) && (
            <p className="text-amber-300/90">That does not look like a base58 Solana address.</p>
          )}
        </Card>

        <CurveStateCard phase={phase} curve={curveRead} decimals={decimals} paused={paused} />

        <TradePanel phase={phase} curve={curveRead} decimals={decimals} paused={paused} writeClient={writeClient} />

        <CreateChecklist mint={mint} global={globalRead} />

        {wallet && (
          <Card title="Wallet">
            {wallet.address ? (
              <Row label="Connected" value={wallet.address} />
            ) : (
              <button
                type="button"
                onClick={wallet.onConnect}
                disabled={wallet.connecting}
                className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
              >
                {wallet.connecting ? 'Connecting…' : 'Connect Solana Wallet'}
              </button>
            )}
            <p className="text-white/40">
              Connecting only fills in your address. Nothing on this page asks for a signature, because there is no
              deployed program to send a transaction to.
            </p>
          </Card>
        )}

        <CurveExplainer />
      </div>
    </>
  );
}

function CurveExplainer() {
  return (
    <div className="space-y-4">
      <Card title="What this is">
        <p>
          Our own bonding curve program, and our own AMM to graduate into — as opposed to the Solana launch rail, which
          runs on Meteora&apos;s curve and migrates into Meteora&apos;s pool.
        </p>
        <p>
          A launch raises SOL along a constant-product curve priced on virtual plus real reserves. When it has raised its
          target and the cost of migrating, one instruction opens the AMM pool, deposits everything, burns the LP tokens
          and closes the curve — all or nothing, so there is no half-migrated state to get stuck in.
        </p>
        <p className="text-white/40">
          <Link to="/solana-launch" className="text-white/60 hover:text-white underline transition-colors">
            The Meteora rail
          </Link>{' '}
          is a separate surface and is unaffected by any of this.
        </p>
      </Card>

      <Card title="What graduation does and does not promise">
        <ul className="list-disc pl-4 space-y-1">
          <li>
            The LP tokens are burned in the same instruction that creates the pool, and the program aborts the whole
            migration rather than finish with them unburned. That makes &quot;liquidity is locked&quot; checkable on
            chain rather than a claim — the LP mint&apos;s supply must read zero.
          </li>
          <li>
            A launch lists close to its final curve price, but not exactly at it. The protocol refuses a configuration
            whose listing price sits more than 5% from the curve&apos;s, and that band is the whole promise.
          </li>
          <li>
            Migration is permissionless and pays its caller nothing. It can also fail temporarily — a sell landing first
            can leave the curve a lamport short — in which case it is retried, not broken.
          </li>
        </ul>
      </Card>

      <Card title="What this page will not show you">
        <p>
          Program state contains reserves, terms and a completion flag. It does not contain a price in dollars, a market
          cap, a holder count, a trade history or a volume figure, and there is no indexer behind this page inventing
          them. Where a value cannot be read it says so rather than showing a zero.
        </p>
        <p className="text-white/40">
          Token names and images are not program state either. Anything showing one is reading separate metadata that a
          launch is not required to have.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function CurveLaunchInner() {
  const { publicKey, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  const rpc = useMemo(() => browserRpc(), []);
  const [probe, setProbe] = useState<ProgramProbe | null>(null);
  const [mintInput, setMintInput] = useState('');
  const [snapshot, setSnapshot] = useState<LaunchSnapshot | null>(null);
  const [mint, setMint] = useState<AccountRead<MintFacts> | null>(null);
  const [loading, setLoading] = useState(false);

  // The first read any surface performs. `null` → not deployed, and we stop
  // there rather than deriving PDAs and rendering their absence as data.
  useEffect(() => {
    let live = true;
    probeProgram(rpc).then((r) => {
      if (live) setProbe(r);
    });
    return () => {
      live = false;
    };
  }, [rpc]);

  const onLookup = useCallback(async () => {
    const addr = mintInput.trim();
    if (probe?.status !== 'deployed' || !looksLikePubkey(addr)) return;
    setLoading(true);
    try {
      const [snap, facts] = await Promise.all([readLaunch(rpc, addr), readMint(rpc, addr)]);
      setSnapshot(snap);
      setMint(facts);
    } catch (e) {
      // A throw here is a client fault (a malformed address reaching PDA
      // derivation), not a finding — surface it as unreadable, not as absent.
      const reason = (e as Error).message;
      setSnapshot(null);
      setMint({ status: 'unreadable', reason });
    } finally {
      setLoading(false);
    }
  }, [mintInput, probe, rpc]);

  return (
    <CurveLaunchView
      probe={probe}
      snapshot={snapshot}
      mint={mint}
      mintInput={mintInput}
      onMintInput={setMintInput}
      onLookup={onLookup}
      loading={loading}
      writeClient={null}
      wallet={{ address: publicKey?.toBase58() ?? null, connecting, onConnect: () => setVisible(true) }}
    />
  );
}

export default function CurveLaunchPage() {
  usePageTitle('Tegridy Curve', 'Our own Solana bonding curve — not deployed yet, and this page says so from a live read.');
  useEffect(() => {
    trackPageView('curve-launch');
  }, []);

  return (
    <SolanaProviders>
      <CurveLaunchInner />
    </SolanaProviders>
  );
}
