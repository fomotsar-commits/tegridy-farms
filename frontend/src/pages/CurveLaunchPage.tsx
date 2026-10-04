// Polyfill MUST load before any @solana/* import — keep this the very first
// import in this lazy chunk's entry (mirrors SolanaSwapPage).
import '../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { m } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useSolanaConnect } from '../components/solana/useSolanaConnect';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { CardArt } from '../components/ui/CardArt';
import { LaunchGate } from '../components/LaunchGate';
import { VenueLaunchLines } from '../components/launcher/VenueLaunchLines';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import { Card, Field, Row } from '../components/solana/curve/ui';
import {
  CARD,
  CARD_STYLE,
  SHADOW,
  TOGGLE_CLS,
  bpsPercent,
  feeSplitLabel,
  inputCls,
  inputStyle,
} from '../components/solana/curve/uiFormat';
import { CurveStateCard } from '../components/solana/curve/CurveStateCard';
import { WriteGateBanner } from '../components/solana/curve/WriteGateBanner';
import { LaunchCreateForm } from '../components/solana/curve/LaunchCreateForm';
import { LaunchList } from '../components/solana/curve/LaunchList';
import { WalletNeeded } from '../components/solana/curve/WalletNeeded';
import { browserGateRpc } from '../components/solana/curve/gateRpc';
import { useWriteGate } from '../components/solana/curve/useWriteGate';
import { useCurveSigner, type CurveSignerState } from '../components/solana/curve/useCurveSigner';
import type { OpenGate, WriteApi, WriteRpc } from '../components/solana/curve/ports';
import { useLaunchLookup, type LaunchLookupReaders } from '../components/solana/curve/useLaunchLookup';
import { PublicKey } from '@solana/web3.js';
import {
  LAUNCH_ERROR_COPY,
  PLATFORM_TREASURY_VAULT,
  PROGRAM_ID,
  applySlippage,
  browserCurveRpc,
  browserRpc,
  buyBlockedReason,
  classifyLaunch,
  describeReserveRecipient,
  describeTreasury,
  formatSol,
  formatTokenAmount,
  isAmmConfigured,
  looksLikePubkey,
  parseDecimalToBaseUnits,
  quoteBuyOnCurve,
  quoteSellOnCurve,
  readCreateLaunchCost,
  readDeployment,
  readLaunch,
  readMint,
  sellBlockedReason,
  type BondingCurve,
  type CreateLaunchCost,
  type CurveRpc,
  type CurveWriteClient,
  type Deployment,
  type LaunchPhase,
  type LaunchState,
  type MintFacts,
  type Read,
  type SolanaRpc,
  type TreasuryDescription,
} from '../lib/launcher/solana/curve';

// /curve-launch: the surface for OUR OWN bonding curve
// (solana/tegridy-amm/programs/tegridy-launch), which graduates into our cp-swap
// fork.
//
// TWO MODES, and the first one is the default everywhere a build has not opted in:
//
//   1. READ-ONLY (writes off). What this page always was: the badge, the panels and
//      every number come from reading the chain at PROGRAM_ID, and there is no
//      signing path at all. The page says what it reads. From website release 2
//      `PROGRAM_ID` is the restart id and writes are on, so this mode is what a
//      build shows while the write gate is still loading or has been refused.
//   2. LAUNCH AND TRADE (writes on). Only when lib/launcher/solana/curveWriteFlag.ts
//      lets the write code load (a committed constant in production), AND the write
//      layer's own config accepts the program pair, AND the chain answers that both
//      programs are there and the protocol settings exist and point at our pool
//      program. Then this page offers the create form, the recent-launch list and a
//      lookup that opens /curve-launch/:mint, where trading happens. Every read on
//      the page then uses the configured program id, never a different one.
//
// The write code is behind a dynamic import (components/solana/curve/writeApi.ts),
// so mode 1 never fetches it.
//
// Everything the page renders about a launch is either read from chain or
// labelled unknown. No price feed, no volume, no holder count, no market cap, no
// USD figure: none of them exist in program state and there is no indexer.

/** "the platform treasury..." becomes "The platform treasury...", for the start of a sentence. */
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Deployment banner — the gate everything else hangs off
// ---------------------------------------------------------------------------

const PROBE_COPY: Record<
  'checking' | Deployment['kind'],
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
  // Its own badge, not folded into either neighbour: anyone may send lamports to
  // a public address, so an account can exist there while the program does not.
  'not-a-program': {
    badge: 'NOT A PROGRAM',
    tone: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    line: 'An account exists at this address but it is not executable, so it is not a program. Someone funded the address; nothing here is deployed.',
  },
  // Its own badge for the same reason as the one above, and a stronger one: this is
  // the state the executable flag reports as DEPLOYED. Say "gone", not "not yet".
  closed: {
    badge: 'CLOSED',
    tone: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    line: 'This program was deployed and has since been closed. Its bytecode account is gone, so nothing here can run, and Solana will never allow a program at this address again.',
  },
  unreadable: {
    badge: 'READ FAILED',
    tone: 'bg-rose-500/20 text-rose-200 border-rose-500/30',
    line: 'We could not reach the chain to check. This says nothing about whether the program is live. It only means the lookup failed.',
  },
  deployed: {
    badge: 'DEPLOYED',
    tone: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30',
    line: 'A program exists at this address. Everything below is read from it.',
  },
};

export function DeploymentBanner({
  probe,
  programId = PROGRAM_ID,
}: {
  probe: Deployment | null;
  /** The id that was probed. Defaults to PROGRAM_ID; the write mode passes its configured id. */
  programId?: PublicKey;
}) {
  const key = probe === null ? 'checking' : probe.kind;
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
          <h1 className="heading-luxury text-[18px] text-white">Memetics Curve</h1>
          <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-semibold border ${c.tone}`}>{c.badge}</span>
        </div>
        <p className="text-white/60 text-[11px] leading-relaxed">{c.line}</p>
        {probe?.kind === 'unreadable' && <p className="text-rose-200/80 text-[10px] mt-1.5 break-all">{probe.detail}</p>}
        {probe?.kind === 'not-a-program' && (
          <p className="text-amber-200/80 text-[10px] mt-1.5 break-all">owned by {probe.owner}</p>
        )}
        {probe?.kind === 'closed' && (
          <p className="text-amber-200/80 text-[10px] mt-1.5 break-all">
            bytecode account {probe.programDataAddress} no longer exists
          </p>
        )}
        <p className="text-white/35 text-[10px] mt-2 break-all font-mono">{programId.toBase58()}</p>
        {/*
          This read "That id is a placeholder generated so the program compiles… expected
          to return nothing today", which stopped being true at the 2026-08-08 deploy and
          stayed on the page for two weeks. It is not describing anything now: the badge
          above is a live read and is the only thing here entitled to make a claim.
        */}
        <p className="text-white/35 text-[10px] mt-1 leading-relaxed">
          The badge above is read from the chain each time this page loads. It is not a hardcoded state.
        </p>
        {/* The dead-end fix (2026-08-28): a dead Solana program is not a dead
            venue. Same rationale as App.tsx's no-redirect note — we never
            redirect INTO a dead rail, but a measured link OUT to live ones is
            exactly what that note leaves open. */}
        {(probe?.kind === 'closed' || probe?.kind === 'not-a-program' || probe?.kind === 'not-deployed') && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to="/eth-curve" className="btn-primary px-4 py-2 text-[12px]">
              The Memetics Curve is LIVE on Ethereum, Base + Robinhood →
            </Link>
            <Link to="/solana" className="btn-secondary px-4 py-2 text-[12px]">
              Swap any Solana token
            </Link>
          </div>
        )}
      </div>
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Curve state
// ---------------------------------------------------------------------------

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
  gateNotOpen = false,
  lookedUp = true,
}: {
  phase: LaunchPhase;
  curve: BondingCurve | null;
  decimals: number | null;
  paused: boolean | null;
  writeClient: CurveWriteClient | null;
  /** False: no launch has been looked up, so there is no reason to give for "blocked". */
  lookedUp?: boolean;
  /**
   * Writes are switched on for this site, but the check above did not open them.
   * The status card above says why; this panel must not claim a different reason.
   */
  gateNotOpen?: boolean;
}) {
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(100n);

  const c = curve;
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
    // `quoteBuyOnCurve` / `quoteSellOnCurve` are the SAME arithmetic the program
    // runs, and they RETURN their failures rather than throwing. No try/catch: a
    // catch-all is how a real failure becomes a clean-looking zero.
    if (side === 'buy') {
      const q = quoteBuyOnCurve(c, raw);
      return q.ok ? ({ side: 'buy', ...q.value } as const) : ({ side: 'error', code: q.error } as const);
    }
    const q = quoteSellOnCurve(c, raw);
    return q.ok ? ({ side: 'sell', ...q.value } as const) : ({ side: 'error', code: q.error } as const);
  }, [c, blocked, side, amount, decimals]);

  const disabled = !c || !!blocked;

  return (
    <Card title="Trade the curve" art={<CardArt pageId="curve-launch" idx={4} />}>
      <div className="flex gap-1.5 mb-3" role="group" aria-label="Buy or sell">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className={`${TOGGLE_CLS} font-medium capitalize`}
            style={{
              background: side === s ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
              border: side === s ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {!lookedUp ? (
        <p className="text-white/50 mb-3">Look up a launch above to see its curve here.</p>
      ) : (
        blocked && <p className="text-amber-300/90 mb-3">{LAUNCH_ERROR_COPY[blocked]}</p>
      )}

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
        {(a11y) => (
          <input
            className={`${inputCls} disabled:opacity-50`}
            style={inputStyle}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            spellCheck={false}
            disabled={disabled}
            {...a11y}
          />
        )}
      </Field>

      {/* A fieldset, not a <label>: a label wrapping buttons forwards a tap on its text
          to the first button, which would silently set 0.5%. */}
      <fieldset className="block mb-3 min-w-0">
        <legend className="text-white text-[11px] block mb-1.5" style={SHADOW}>
          Slippage tolerance
        </legend>
        <div className="flex gap-1.5">
          {SLIPPAGE_OPTIONS.map((bps) => (
            <button
              key={bps.toString()}
              type="button"
              onClick={() => setSlippageBps(bps)}
              aria-pressed={slippageBps === bps}
              disabled={disabled}
              className={`${TOGGLE_CLS} disabled:opacity-50`}
              style={{
                background: slippageBps === bps ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                border: slippageBps === bps ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
              }}
            >
              {(Number(bps) / 100).toFixed(bps % 100n === 0n ? 0 : 2)}%
            </button>
          ))}
        </div>
      </fieldset>

      {quote?.side === 'error' && <p className="text-amber-300/90">{LAUNCH_ERROR_COPY[quote.code]}</p>}
      {quote?.side === 'buy' && <BuyQuoteRows quote={quote} decimals={decimals} slippageBps={slippageBps} />}
      {quote?.side === 'sell' && <SellQuoteRows quote={quote} slippageBps={slippageBps} />}

      {/* The write seam. No transaction is built here — see the file header. */}
      {writeClient === null ? (
        <p className="text-white/40 text-[10px] leading-relaxed mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {gateNotOpen
            ? 'Launching and trading are not available right now; see the note above. The quote above is the same arithmetic the program runs.'
            : 'There is no signing path on this page. Launching and trading from this site are switched off for now. The quote above is the same arithmetic the program runs, shown so the terms can be checked.'}
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
  quote: { lamportsIn: bigint; feeLamports: bigint; lamportsToCurve: bigint; tokensOut: bigint; capped: boolean };
  decimals: number | null;
  slippageBps: bigint;
}) {
  const out = formatTokenAmount(quote.tokensOut, decimals);
  // `applySlippage` returns null for a tolerance it will not honour. A missing
  // floor is stated, never rendered as 0 — 0 accepts any fill at all.
  const floorRaw = applySlippage(quote.tokensOut, slippageBps);
  const floor = floorRaw === null ? null : formatTokenAmount(floorRaw, decimals);
  return (
    <div className="space-y-1.5 pt-1">
      {quote.capped && (
        <p className="text-amber-300/90">
          Capped at the graduation line. You will spend {formatSol(quote.lamportsIn)} SOL, not the amount entered — the
          remainder is never taken and never leaves your wallet.
        </p>
      )}
      <Row label="You pay" value={`${formatSol(quote.lamportsIn)} SOL`} />
      <Row label="…of which fee" value={`${formatSol(quote.feeLamports)} SOL`} />
      <Row label={`You receive${out.isBaseUnits ? ' (base units)' : ''}`} value={out.text} />
      <Row label="Minimum received" value={floor === null ? 'not computable at that tolerance' : floor.text} />
      <p className="text-white/35 text-[10px] leading-relaxed">
        A quote is computed from an account snapshot and is stale the moment it is made, so a trade carries the minimum
        above as an on-chain floor. Network fees and the rent for a token account, if you do not already have one, are on
        top of this.
      </p>
    </div>
  );
}

function SellQuoteRows({
  quote,
  slippageBps,
}: {
  quote: { grossLamports: bigint; feeLamports: bigint; lamportsOut: bigint };
  slippageBps: bigint;
}) {
  const floor = applySlippage(quote.lamportsOut, slippageBps);
  return (
    <div className="space-y-1.5 pt-1">
      <Row label="You receive" value={`${formatSol(quote.lamportsOut)} SOL`} />
      <Row label="Fee" value={`${formatSol(quote.feeLamports)} SOL`} />
      <Row
        label="Minimum received"
        value={floor === null ? 'not computable at that tolerance' : `${formatSol(floor)} SOL`}
      />
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
 * What the creator pays in rent to open a launch, read from the cluster.
 *
 * Since 2026-09-26 that includes the treasury's token account, which receives the
 * platform reserve inside `create_launch` and is created at the creator's expense
 * when it does not exist yet. Shown to the lamport (9 digits), because these amounts
 * are a few thousandths of a SOL.
 */
function CreateCostRows({ cost }: { cost: Read<CreateLaunchCost> | null }) {
  if (cost === null) return null;
  if (cost.kind !== 'ok') {
    return (
      <p className="text-amber-300/90">
        Could not read the rent, so what you would pay is not shown.
        {cost.kind === 'unreadable' ? ` ${cost.detail}` : ''}
      </p>
    );
  }
  const c = cost.value;
  const sol = (l: bigint) => `${formatSol(l, 9)} SOL`;
  return (
    <>
      <Row label="You pay (account rent)" value={sol(c.total)} />
      <p className="text-white/55 text-[10px]">
        The curve account {sol(c.curve)}, its token vault {sol(c.vault)}, and{' '}
        {c.treasuryTokenExists
          ? "the treasury's token account already exists, so you pay nothing for it."
          : `the treasury's token account ${sol(c.treasuryToken)} (it does not exist yet, so you create it; the platform reserve is paid into it).`}{' '}
        These are read from the cluster&apos;s current rent rate. Network fees, and the rent for your mint, which you
        create first, are extra.
      </p>
    </>
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
  globalPhase,
  createCost = null,
  launchingOff,
}: {
  /** `null` = nothing looked up yet, which is not a failed read. */
  mint: Read<MintFacts> | null;
  global: LaunchState['global'];
  /** Why `global` is null, when it is. Drives the copy — never a blank or a zero. */
  globalPhase: LaunchPhase | null;
  /** The rent `create_launch` would charge, read from the cluster. `null` = not read. */
  createCost?: Read<CreateLaunchCost> | null;
  /** The view's sentence that no launch can be made from it, said before anything else. */
  launchingOff?: string;
}) {
  const f = mint?.kind === 'ok' ? mint.value : null;
  const g = global;
  const treasury = describeTreasury(g?.feeRecipient ?? null);
  return (
    <Card title="Open a launch" art={<CardArt pageId="curve-launch" idx={5} />}>
      {launchingOff && <p className="text-white/85">{launchingOff}</p>}
      <p>
        Launching mints the entire supply, sends the platform reserve listed below to {treasury.name}, puts the rest
        into a fresh curve&apos;s vault and permanently revokes the mint authority, all in the
        same instruction, so no further supply can ever exist. The curve can sell everything in its vault; whatever it
        has not sold when it graduates goes into the pool. The curve&apos;s terms
        are not chosen per launch — they are
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
      {mint?.kind === 'absent' && <p className="text-white/40">No mint at that address yet.</p>}
      {mint?.kind === 'unreadable' && (
        <p className="text-amber-300/90">Could not read the mint, so none of the above has been checked: {mint.detail}</p>
      )}
      {mint?.kind === 'undecodable' && (
        <p className="text-amber-300/90">
          That address holds an account that is not an SPL mint ({mint.reason}), so none of the above has been checked.
        </p>
      )}
      {f && <Row label="Decimals (read from the mint)" value={String(f.decimals)} />}

      <div className="pt-1.5 space-y-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-white/50 pt-1.5">Terms this launch would be created with:</p>
        {g ? (
          <>
            <Row label="Trade fee" value={`${(Number(g.tradeFeeBps) / 100).toFixed(2)}%`} />
            <Row label="Fee split" value={feeSplitLabel(g.creatorFeeShareBps) ?? '—'} mono={false} />
            <Row label="Graduation target" value={`${formatSol(g.graduationTargetLamports)} SOL`} />
            <Row label="Migration reserve" value={`${formatSol(g.migrationReserveLamports)} SOL`} />
            <Row label="Total supply (base units)" value={g.tokenTotalSupply.toString()} />
            <Row
              label="Platform reserve"
              value={g.platformReserveBps === 0n ? 'none' : `${bpsPercent(g.platformReserveBps)} of supply`}
            />
            {g.platformReserveBps > 0n && (
              <p className="text-white/55 text-[10px]">
                Platform reserve: the platform receives {bpsPercent(g.platformReserveBps)} of supply when the token is
                created.{' '}
                {treasury.multisig
                  ? 'It goes to the platform treasury, which is a multisig.'
                  : `It goes to ${treasury.name}. This page cannot confirm that account is a multisig: it is not the platform's known Squads vault.`}
              </p>
            )}
            <Row label="Graduation venue" value={isAmmConfigured(g) ? 'configured' : 'not configured yet'} />
            {g.paused && <p className="text-amber-300/90">New launches are paused.</p>}
            <CreateCostRows cost={createCost} />
          </>
        ) : (
          <p className="text-white/40">
            {globalPhase === null
              ? 'Nothing has been read yet, so the terms are not known.'
              : globalPhase.kind === 'protocol-not-initialized'
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
  probe: Deployment | null;
  /** `null` until a lookup has been made — NOT the same as a failed one. */
  snapshot: LaunchState | null;
  mint: Read<MintFacts> | null;
  mintInput: string;
  onMintInput: (v: string) => void;
  onLookup: () => void;
  loading: boolean;
  /** Null until a write client exists. See curve/rpc.ts's CurveWriteClient. */
  writeClient?: CurveWriteClient | null;
  /** The rent `create_launch` would charge the creator. `null` = not read. */
  createCost?: Read<CreateLaunchCost> | null;
  wallet?: { address: string | null; connecting: boolean; onConnect: () => void };
  /** The program id the probe read. Defaults to PROGRAM_ID. */
  programId?: PublicKey;
  /** The launch-and-trade status card. Absent when writes are off: the page is then unchanged. */
  gateBanner?: ReactNode;
  /**
   * The launch-and-trade section (CurveWriteSection), present only when the write gate
   * is OPEN. It replaces the read-only door, lookup, state, quote, checklist and wallet
   * cards, and carries its own door; the explainer stays.
   */
  write?: ReactNode;
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
  programId = PROGRAM_ID,
  gateBanner,
  write,
  createCost = null,
}: CurveLaunchViewProps) {
  // `snapshot === null` = no lookup attempted. Kept distinct from a failed read
  // all the way down: the classifier has to call it unreadable (it genuinely
  // cannot say), but the cards must not tell the user that a call failed when no
  // call was made — which is what `lookedUp` below is for.
  const lookedUp = snapshot !== null;
  const notLookedUp = { kind: 'unreadable', detail: 'not looked up yet' } as const;
  const phase =
    snapshot?.phase ??
    classifyLaunch(probe ?? { kind: 'unreadable', detail: 'still checking' }, notLookedUp, notLookedUp).phase;
  const paused = snapshot?.paused ?? null;
  const decimals = mint?.kind === 'ok' ? mint.value.decimals : null;
  const treasury = describeTreasury(snapshot?.global?.feeRecipient ?? null);

  // A lookup is only meaningful once we know a program is actually there.
  // Offering it beforehand would invite deriving PDAs under a program that does
  // not exist and rendering their absence as data about a launch.
  const canLookUp = probe?.kind === 'deployed' && looksLikePubkey(mintInput);

  // No launch can be made from the read-only view. The door and the "Open a launch" card
  // both say so, in the same two cases as the trade panel's note.
  const launchingOff =
    gateBanner != null ? 'Launching is not open right now. The note above says why.' : 'Launching here is not switched on yet.';

  return (
    <>
      <PageArtBackdrop pageId="curve-launch" />
      <div className="relative z-10 max-w-xl mx-auto px-4 py-8 space-y-4">
        <DeploymentBanner probe={probe} programId={programId} />

        {gateBanner}

        {write ?? (
          <>
        {/* THE DOOR on our own curve rail, reading the connected Solana wallet. Same
            primitive as the other rails: one rule, read live, in one place. No launch can
            be made from this view, so the door shows the reading and says so. */}
        <LaunchGate
          rail="solana"
          wallet={wallet?.address ?? null}
          below={<VenueLaunchLines rail="solana" />}
          launchingOff={launchingOff}
        />

        <Card title="Look up a launch" art={<CardArt pageId="curve-launch" idx={2} />}>
          <p>Open a launch by its token address (mint). This view has no list of launches.</p>
          <Field label="Token mint address">
            <input
              className={`${inputCls} disabled:opacity-50`}
              style={inputStyle}
              value={mintInput}
              onChange={(e) => onMintInput(e.target.value)}
              placeholder="Base58 mint address"
              spellCheck={false}
              disabled={probe?.kind !== 'deployed'}
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
          {(probe?.kind === 'not-deployed' || probe?.kind === 'not-a-program') && (
            <p className="text-white/40">Nothing to look up while the program does not exist.</p>
          )}
          {probe?.kind === 'closed' && (
            <p className="text-white/40">
              Nothing to look up — the program was closed, and its launches went with it.
            </p>
          )}
          {mintInput.trim() !== '' && !looksLikePubkey(mintInput) && (
            <p className="text-amber-300/90">That does not look like a base58 Solana address.</p>
          )}
        </Card>

        <CurveStateCard
          phase={phase}
          curve={snapshot?.curve?.curve ?? null}
          decimals={decimals}
          paused={paused}
          lookedUp={lookedUp}
          // No treasury here: who received a past reserve is in the launch’s own create
          // transaction, which this read-only view does not read. Today’s config can have
          // changed since, so the card names no address and makes no multisig claim.
        />

        <TradePanel
          phase={phase}
          curve={snapshot?.curve?.curve ?? null}
          decimals={decimals}
          paused={paused}
          writeClient={writeClient}
          gateNotOpen={gateBanner != null}
          lookedUp={lookedUp}
        />

        <CreateChecklist
          mint={mint}
          global={snapshot?.global ?? null}
          globalPhase={lookedUp ? phase : null}
          createCost={createCost}
          launchingOff={launchingOff}
        />

        {wallet && (
          <Card title="Wallet" art={<CardArt pageId="curve-launch" idx={6} />}>
            {wallet.address ? (
              <Row label="Connected" value={wallet.address} />
            ) : (
              // Not switched off while it waits: a press then opens the wallet list
              // (useSolanaConnect), so a wallet that never answers is not a dead end.
              <button
                type="button"
                onClick={wallet.onConnect}
                aria-busy={wallet.connecting || undefined}
                className={`btn-primary w-full py-2.5 text-[13px]${wallet.connecting ? ' opacity-60' : ''}`}
              >
                {wallet.connecting ? 'Connecting…' : 'Connect Solana Wallet'}
              </button>
            )}
            <p className="text-white/40">
              Connecting only fills in your address. Nothing on this page asks for a signature while launching and
              trading here are switched off.
            </p>
          </Card>
        )}
          </>
        )}

        <CurveExplainer treasury={treasury} />
      </div>
    </>
  );
}

function CurveExplainer({ treasury }: { treasury: TreasuryDescription }) {
  return (
    <div className="space-y-4">
      <Card title="What this is" art={<CardArt pageId="curve-launch" idx={7} />}>
        <p>
          Our own bonding curve program, and our own AMM to graduate into — unlike the retired Solana launch rail, which
          ran on Meteora&apos;s curve and migrated into Meteora&apos;s pool.
        </p>
        <p>
          A launch raises SOL along a curve: each buy raises the price a little, each sell lowers it. When it has raised
          its target and the cost of opening a pool, one step opens the pool, burns the pool&apos;s LP tokens and closes
          the curve. It all happens or none of it does, so a launch can never get stuck half moved.
        </p>
        <p>
          What goes into the pool: the graduation target in SOL, and every token the curve did not sell. The migration
          reserve pays the pool&apos;s setup costs, and whatever it does not use goes to the treasury. The platform
          reserve does not go into the pool: {treasury.name} receives it when the token is created.
        </p>
        <p>
          The platform treasury is meant to be a Squads multisig vault ({PLATFORM_TREASURY_VAULT.toBase58()}). This page
          calls it a multisig only after reading the live config and finding that vault there.
        </p>
        <p className="text-white/40">
          The Meteora rail was retired on 2026-08-23 — this curve is now the only Solana launch surface here.
        </p>
      </Card>

      <Card title="What graduation does and does not promise" art={<CardArt pageId="curve-launch" idx={8} />}>
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
            Anyone can finish a graduation, and it pays them nothing. It can fail for a moment (a sell that lands first
            can leave the curve a tiny amount short of its target); then it is simply tried again, nothing is broken.
          </li>
          <li>
            Graduation does not touch the platform reserve. {capitalize(describeReserveRecipient(null).name)} received
            it when the token was created, whether or not the launch ever graduates. It holds those tokens like any other holder,
            and the program does not limit what it does with them, including selling them while the curve is live.
          </li>
        </ul>
      </Card>

      <Card title="What this page will not show you" art={<CardArt pageId="curve-launch" idx={9} />}>
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

/** Opens a launch's own page by its token address. Write mode only. */
function OpenByMint() {
  const navigate = useNavigate();
  const [v, setV] = useState('');
  const addr = v.trim();
  let valid = false;
  if (looksLikePubkey(addr)) {
    try {
      new PublicKey(addr);
      valid = true;
    } catch {
      valid = false;
    }
  }
  return (
    <Card title="Open a launch by its address" art={<CardArt pageId="curve-launch" idx={10} />}>
      <p>Paste the full token address (mint). Compare every character with the one you were given.</p>
      <Field label="Token mint address">
        <input
          className={inputCls}
          style={inputStyle}
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="Base58 mint address"
          spellCheck={false}
          aria-label="Token mint address"
        />
      </Field>
      <button
        type="button"
        className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
        disabled={!valid}
        onClick={() => navigate(`/curve-launch/${addr}`)}
      >
        Open
      </button>
      {addr !== '' && !valid && <p className="text-amber-300/90">That does not look like a Solana address.</p>}
    </Card>
  );
}

export interface CurveWriteSectionProps {
  api: WriteApi;
  gate: OpenGate;
  /** The wallet adapter's connection, which the create form signs and sends through. */
  writeRpc: WriteRpc;
  rpc: SolanaRpc;
  curveRpc: CurveRpc;
  signerState: CurveSignerState;
  /** The connected Solana wallet: the door reads it, and "Yours" lists its launches. */
  wallet: PublicKey | null;
}

/**
 * Write mode. Opening a launch by address, the list and trading stay open to anyone;
 * only the create form is behind the door, which reads the connected Solana wallet.
 * The form re-reads that wallet at every Review whatever the door showed.
 */
export function CurveWriteSection({ api, gate, writeRpc, rpc, curveRpc, signerState, wallet }: CurveWriteSectionProps) {
  const actions = api.writeActions(gate, null);
  return (
    <>
      <LaunchGate
        rail="solana"
        wallet={wallet?.toBase58() ?? null}
        connect={<WalletNeeded state={signerState} />}
        below={<VenueLaunchLines rail="solana" />}
      >
        <LaunchCreateForm api={api} rpc={writeRpc} gate={gate} actions={actions} signerState={signerState} />
      </LaunchGate>
      <OpenByMint />
      <LaunchList api={api} cfg={gate.cfg} rpc={rpc} curveRpc={curveRpc} wallet={wallet} />
    </>
  );
}

function CurveLaunchInner() {
  const { publicKey, connecting } = useWallet();
  const { connection } = useConnection();
  // Connect-intent goes through useSolanaConnect, not bare setVisible: a
  // selected-but-uninstalled wallet needs connect() to reach the install page
  // / iOS deep link (re-picking the same wallet in the modal is a no-op).
  const openConnect = useSolanaConnect();
  const signerState = useCurveSigner();

  // One transport, two views of it: the raw JSON-RPC callable for `readMint`, and
  // the `CurveRpc` adapter every reader in `curve/read.ts` is written against.
  const rpc = useMemo(() => browserRpc(), []);
  const curveRpc = useMemo(() => browserCurveRpc(rpc), [rpc]);
  const gateRpc = useMemo(() => browserGateRpc(rpc, curveRpc), [rpc, curveRpc]);
  const gateState = useWriteGate(gateRpc);
  // With writes on, every read on this page uses the program the write layer is
  // configured for. Until the gate has answered, nothing is probed, so the badge
  // never describes one program while the actions target another.
  const writesDecided = gateState.status !== 'loading';
  const cfg = gateState.status === 'ready' ? gateState.cfg : null;
  const programId = cfg?.programId ?? PROGRAM_ID;

  const [probe, setProbe] = useState<Deployment | null>(null);
  const [mintInput, setMintInput] = useState('');
  const readers = useMemo<LaunchLookupReaders>(
    () => ({
      launch: (key) => readLaunch(curveRpc, key, programId),
      mint: (addr) => readMint(rpc, addr),
      cost: (key, feeRecipient) => readCreateLaunchCost(curveRpc, key, feeRecipient),
    }),
    [rpc, curveRpc, programId],
  );
  const { snapshot, mint, createCost, loading, lookUp } = useLaunchLookup(readers);

  // The first read any surface performs. `not-deployed` → we stop there rather
  // than deriving PDAs and rendering their absence as data. A malformed or failed
  // response is `unreadable`, which is not that answer.
  useEffect(() => {
    if (!writesDecided) return;
    // Runs once in practice: the gate decides the id before the first probe.
    let live = true;
    readDeployment(curveRpc, programId).then((r) => {
      if (live) setProbe(r);
    });
    return () => {
      live = false;
    };
  }, [curveRpc, programId, writesDecided]);

  const onLookup = useCallback(async () => {
    const addr = mintInput.trim();
    if (probe?.kind !== 'deployed' || !looksLikePubkey(addr)) return;
    await lookUp(addr);
  }, [mintInput, probe, lookUp]);

  let write: ReactNode = undefined;
  if (gateState.status === 'ready' && gateState.gate.kind === 'open') {
    write = (
      <CurveWriteSection
        api={gateState.api}
        gate={gateState.gate}
        writeRpc={connection}
        rpc={rpc}
        curveRpc={curveRpc}
        signerState={signerState}
        wallet={publicKey ?? null}
      />
    );
  }

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
      createCost={createCost}
      wallet={{ address: publicKey?.toBase58() ?? null, connecting, onConnect: openConnect }}
      programId={programId}
      gateBanner={gateState.status === 'disabled' ? undefined : <WriteGateBanner state={gateState} />}
      write={write}
    />
  );
}

export default function CurveLaunchPage() {
  usePageTitle('Memetics Curve', 'Our own Solana bonding curve. Every state on this page is read live from the chain.');
  useEffect(() => {
    trackPageView('curve-launch');
  }, []);

  return (
    <SolanaProviders>
      <CurveLaunchInner />
    </SolanaProviders>
  );
}
