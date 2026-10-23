import { useCallback, useEffect, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  buildSwapTransaction,
  getQuote,
  NoRouteError,
  quoteHasPlatformFee,
  simulateSwap,
  swapCarriesPlatformFee,
  type JupiterQuote,
  type PriorityLevel,
} from '../../../lib/jupiter';
import { decimalCommaToPoint, formatTokenAmount, parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve/format';
import { holdReload } from '../../../lib/reloadHold';
import { quoteOwnPool } from '../../../lib/solana/cpswap/read';
import { feeReserveFor, isPlanProblem, solSetAside } from '../../../lib/solana/lp/liquidityMath';
import { outsideShare, ownPoolShare, stepTwo, type Side, type StepTwo } from '../../../lib/solana/lp/oneCoin';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { PoolHealth } from '../../../lib/solana/lp/poolHealth';
import { tokenTicker } from '../../../lib/solana/lp/identity';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { NO_SITE_FEE_ROUTE_COPY, prepareJupiterSwap, type PreparedJupiterSwap } from '../../../lib/solana/swap/jupiterFeeRetry';
import { OWN_ROUTE_COPY, freshDecision, ownPoolNowWins, prepareOwnPoolSwap, within } from '../../../lib/solana/swap/ownPoolRoute';
import type { VenuePoolCandidate } from '../../../lib/solana/swap/venuePools';
import { CHECK_KEEPS_FAILING, LOST_ANSWER_TITLE, LOST_NO_SIGNATURE, OWN_POOL_REVIEW_OFFER } from '../../../lib/solana/swap/walletCopy';
import type { AggregatorSeen } from '../../../lib/launcher/solana/write/types';
import { useVenueSwap } from '../../swap/useVenueSwap';
import { FinePrint } from '../../ui/FinePrint';
import { PendingTradeCard } from '../curve/PendingTradeCard';
import { noteKey, readPendingTrades, swapPendingScope } from '../curve/pendingTrade';
import type { Prepared } from '../curve/ports';
import { TxFlowView } from '../curve/TxFlowView';
import { Field, Notice, Row, SlippagePicker } from '../curve/ui';
import { DEFAULT_SLIPPAGE_BPS, TOGGLE_CLS, baseUnitsToInput, impactWarning, inputCls, inputStyle } from '../curve/uiFormat';
import { useReturnFocus, type OnSettled } from '../curve/useTxFlow';
import { WalletNeeded } from '../curve/WalletNeeded';
import { AddLiquidityPanel } from './AddLiquidityPanel';
import { RISK_SHORT } from './LpDisclosures';
import { PercentPicker } from './PercentPicker';
import { tick } from '../../../lib/tick';
import { clearStepTwo, priceChangeOf, readStepTwo, receivedBy, saveStepTwo, sendJupiterLeg, stepOneLanded, type StepTwoNote } from './oneCoinSwap';
import { PanelFrame } from './PanelFrame';
import { coinAbout, coinExact, solExact, unitsExact, useWalletFacts } from './panelKit';
import { useLpWrites, type LpWrites } from './useLpWrites';

/** The one line under the button (owner, 2026-10-13: minimal words; D10: an ordinary swap). */
export const ONE_COIN_LINE = 'Part of it is swapped first, as an ordinary swap with the swap page’s fees. Then both coins go in. Two signatures: the swap, then the add.';
/** Kept back from a SOL amount for the swap's fees and its temporary accounts: the swap page's own Max reserve. */
export const SWAP_SOL_RESERVE = 10_000_000n;
/** How long the press waits for our pool to be read again before Jupiter's transaction goes to the wallet. */
const OWN_CHECK_MS = 4_000;

const JUPITER = { getQuote, buildSwapTransaction, simulateSwap, swapCarriesPlatformFee };
const notBuilt = (message: string): Prepared => ({ ok: false, outcome: { status: 'not-sent', stage: 'build', message } });
const shortSig = (sig: string) => `${sig.slice(0, 6)}…${sig.slice(-4)}`;
const floorOf = (q: JupiterQuote): bigint => {
  try {
    return BigInt(q.otherAmountThreshold);
  } catch {
    return 0n;
  }
};

/** The swap page's speed setting, as it keeps it (SolanaSwapPage.tsx). */
function speed(): PriorityLevel {
  try {
    const s = localStorage.getItem('sol.speed');
    if (s === 'medium' || s === 'high' || s === 'veryHigh') return s;
  } catch {
    /* default stands */
  }
  return 'high';
}

interface Plan {
  route: 'jupiter' | 'own';
  view: PoolView;
  paid: Side;
  inputMint: string;
  outputMint: string;
  total: bigint;
  swapIn: bigint;
  /** What the swap is quoted to pay, and at least (Jupiter's route; our pool's review says its own). */
  out: bigint;
  min: bigint | null;
  quote: JupiterQuote | null;
  /** What this pool would pay for Jupiter's swap: null when it could not quote it. */
  poolOut: bigint | null;
  two: StepTwo | null;
  /** The slippage this plan was made with: step 1's, and step 2's to start with. */
  bps: bigint;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'planning' }
  | { kind: 'review'; plan: Plan }
  | { kind: 'own'; plan: Plan }
  | { kind: 'sending'; plan: Plan }
  | { kind: 'waiting'; plan: Plan; signature: string }
  | { kind: 'step2'; view: PoolView; note: StepTwoNote; initial: { side: Side; text: string; bps: bigint } | null; done: boolean };

type Said = { title: string; text: string; tone: 'warn' | 'bad' | 'info' };

/**
 * "Add with one coin", in place inside a pool card (owner, 2026-10-13). Step 1 swaps the
 * share of the coin that step 2 needs of the other one, through whichever pays more for
 * that swap, Jupiter or this pool, by the swap page's rules and fees; step 2 is the Add
 * liquidity form itself, opened on what step 1 left. Two transactions, two signatures.
 * A swap this wallet sent and the chain has not answered for holds step 1 (useVenueSwap's
 * notes, the swap page's, by the wallet that signed); once step 1 lands, only step 2 is offered.
 */
export function AddOneCoinPanel(p: { view: PoolView; health: PoolHealth; safety: TokenSafety | null; tokenDecimals: number | null; onClose: () => void; onPair?: () => void }) {
  const writes = useLpWrites();
  if (!writes || !writes.api || writes.gate?.kind !== 'open') return null;
  return <OneCoinInner {...p} writes={writes} />;
}

function OneCoinInner({
  view,
  health,
  safety,
  tokenDecimals,
  onClose,
  writes,
  onPair,
}: {
  view: PoolView;
  health: PoolHealth;
  safety: TokenSafety | null;
  tokenDecimals: number | null;
  onClose: () => void;
  writes: LpWrites;
  /** "I have both coins": this pool's Add liquidity form, in one press. */
  onPair?: () => void;
}) {
  const { connection } = useConnection();
  const { sendTransaction } = useWallet();
  const pool = view.snapshot.pool;
  const coin = view.quote;
  const decimals = tokenDecimals ?? (view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals);
  const tokenProgram = view.quoteIsToken0 ? pool.token1Program : pool.token0Program;
  // Its ticker as the pool's heading says it (identity.ts): a copy of a well-known one reads "fake USDC", never "USDC".
  const tokenName = (safety?.kind !== 'read' || safety.verdict !== 'blocked' ? tokenTicker(view.tokenMint, safety) : null) ?? 'tokens';
  const signer = writes.signerState.kind === 'ready' ? writes.signerState.signer : null;
  const owner = signer?.publicKey ?? null;
  const ownerKey = owner?.toBase58() ?? null;
  const [factsNonce, setFactsNonce] = useState(0);
  const facts = useWalletFacts(writes, owner, { tokenMint: view.tokenMint, tokenProgram, lpMint: pool.lpMint, quote: coin }, factsNonce);

  const [paid, setPaid] = useState<Side>('quote');
  const [text, setText] = useState('');
  // The percent row's pick (25, 50, 75); typing or Max clears it.
  const [pctBps, setPctBps] = useState<bigint | null>(null);
  const [slippageBps, setSlippageBps] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [said, setSaid] = useState<Said | null>(null);
  // D2: the second press in a row whose Jupiter test run could not run offers this pool's review.
  const uncheckedRun = useRef(0);
  const [ownOffer, setOwnOffer] = useState(false);
  // Pairs whose Jupiter transaction from this site goes out with no site fee (jupiterFeeRetry.ts).
  const noFeePairs = useRef<Set<string>>(new Set());
  const learnNoFee = (pair: string, noFee: boolean) => (noFee ? noFeePairs.current.add(pair) : noFeePairs.current.delete(pair));

  const name = (side: Side) => (side === 'quote' ? coin.symbol : tokenName);
  const decimalsOf = (side: Side) => (side === 'quote' ? coin.decimals : decimals);
  const about = (side: Side, v: bigint) => (side === 'quote' ? coinAbout(v, coin) : `${formatTokenAmount(v, decimals, 4).text} ${tokenName}`);
  const exact = (side: Side, v: bigint) => (side === 'quote' ? coinExact(v, coin) : `${unitsExact(v, decimals)} ${tokenName}`);
  const other = (side: Side): Side => (side === 'quote' ? 'token' : 'quote');

  // What the wallet can pay with. SOL: what is left after both steps' fees and deposits. Unread is null, never 0.
  const band =
    facts?.kind === 'ok'
      ? {
          walletFloor: facts.rents.walletFloor,
          feeReserve: feeReserveFor(1),
          lpAccountRent: facts.lpAccountExists ? 0n : facts.rents.tokenAccount165,
          wsolCreateRent: !coin.native || facts.wsol.exists ? 0n : facts.rents.tokenAccount165,
        }
      : null;
  const setAside = band ? solSetAside(band) + SWAP_SOL_RESERVE : null;
  const paysSol = paid === 'quote' && coin.native;
  const available: bigint | null =
    facts?.kind !== 'ok' || setAside === null
      ? null
      : paysSol
        ? facts.lamports > setAside
          ? facts.lamports - setAside
          : 0n
        : paid === 'quote'
          ? facts.coin
            ? facts.coin.exists
              ? facts.coin.amount
              : 0n
            : null
          : (facts.token?.amount ?? 0n);
  const shortOfSol = !paysSol && facts?.kind === 'ok' && setAside !== null && facts.lamports < setAside;
  const total = text.trim() === '' ? null : parseDecimalToBaseUnits(text, decimalsOf(paid));
  const bad = text.trim() !== '' && total === null;
  const over = total !== null && available !== null && total > available;
  // About how much of the pool the amount buys (the share bar): its value at the pool's own
  // price against the pool's, from the reserves as read. The review works out the real figure.
  const sharePct = (() => {
    if (total === null || total <= 0n || view.quoteReserve <= 0n || view.tokenReserve <= 0n) return null;
    const value = paid === 'quote' ? Number(total) : (Number(total) * Number(view.quoteReserve)) / Number(view.tokenReserve);
    return (value / (2 * Number(view.quoteReserve) + value)) * 100;
  })();

  const pair = (p: { inputMint: string; outputMint: string }) => `${p.inputMint}|${p.outputMint}`;

  // ── reads ──
  const readPool = useCallback(async (): Promise<{ view: PoolView; now: number } | null> => {
    try {
      const r = await writes.readers.findPools(new PublicKey(view.tokenMint), [view.address]);
      if (r.kind !== 'ok') return null;
      const e = r.search.pools.find((x) => x.kind === 'pool' && x.view.address === view.address);
      if (!e || e.kind !== 'pool') return null;
      return { view: e.view, now: r.search.chainNow !== null ? Number(r.search.chainNow) : Math.floor(Date.now() / 1000) };
    } catch {
      return null;
    }
  }, [writes.readers, view.tokenMint, view.address]);

  const candidate = (v: PoolView, now: number, inputMint: string, amount: bigint): VenuePoolCandidate | null => {
    if (!v.config || v.vaultsFrozen) return null;
    const q = quoteOwnPool(v.snapshot, v.config, inputMint, amount, now);
    return q && q.outAmount > 0n ? { venue: 'own-pool', outAmount: q.outAmount, label: 'venue pool', poolAddress: v.address, priceImpact: q.priceImpact, view: v, quote: q } : null;
  };

  // ── step 2 ──
  const openStep2 = useCallback(
    async (note: StepTwoNote) => {
      const r = await readPool();
      const v = r?.view ?? view;
      const two = stepTwo(v.snapshot, { quoteIsToken0: v.quoteIsToken0, paid: note.paid, kept: note.kept, got: note.got, bps: note.bps });
      const initial = isPlanProblem(two) ? null : { side: two.driving, text: baseUnitsToInput(two.maxIn, two.driving === 'quote' ? coin.decimals : decimals), bps: note.bps };
      writes.setBusy(false);
      setPhase({ kind: 'step2', view: v, note, initial, done: false });
    },
    [readPool, view, coin.decimals, decimals, writes],
  );

  /**
   * Step 1 landed: what it paid is read from the transaction itself; `least`, the floor of
   * the transaction that was sent, stands in when that read fails. The note is written
   * before the read, so no tab offers step 1 again while it runs.
   */
  const landed = async (p: Plan, signature: string, least: bigint) => {
    if (!ownerKey) return;
    const floor: StepTwoNote = { pool: view.address, paid: p.paid, kept: p.total - p.swapIn, got: least, gotExact: false, bps: p.bps, signature, at: Date.now() };
    saveStepTwo(ownerKey, floor);
    const outIsSol = p.paid === 'token' && coin.native;
    const got = await receivedBy(connection, signature, ownerKey, p.outputMint, outIsSol);
    const note: StepTwoNote = got !== null && got >= least ? { ...floor, got, gotExact: true } : floor;
    if (note.gotExact) saveStepTwo(ownerKey, note);
    setFactsNonce((n) => n + 1);
    writes.finished();
    await openStep2(note);
  };

  // Step 1 landed for this wallet on this pool (here, in another tab, before a reload): only step 2 is offered.
  const owed = () => (ownerKey ? readStepTwo(ownerKey, view.address) : null);
  const stepTwoOwed = () => {
    const note = owed();
    if (note) void openStep2(note);
    return note !== null;
  };

  // A step 2 owed by this wallet on this pool (a reload, a trip away): offered again, never step 1.
  useEffect(() => {
    if (!ownerKey) return;
    const note = readStepTwo(ownerKey, view.address);
    if (note) void openStep2(note);
    // Once per wallet: a new read of the same pool must not reopen what was skipped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);

  // ── step 1 in our pool: the swap page's own review ──
  const ownPlan = useRef<Plan | null>(null);
  // Step 1 sent and not confirmed, on either route: its note holds step 1 until the chain answers.
  const [waitingFor, setWaitingFor] = useState<{ plan: Plan; signature: string; least: bigint } | null>(null);
  const onOwnSettled = useCallback<OnSettled>((outcome, prepared) => {
    const p = ownPlan.current;
    if (!p || prepared?.summary.kind !== 'venue-swap') return;
    if (outcome.status === 'unknown') setWaitingFor({ plan: p, signature: outcome.signature, least: prepared.summary.minimumAmountOut });
    if (outcome.status !== 'confirmed') return;
    ownPlan.current = null;
    void landed(p, outcome.signature, prepared.summary.minimumAmountOut);
  // `landed` reads this render's values; the flow keeps the newest callback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, connection]);
  const venueSwap = useVenueSwap({ wanted: true, programId: writes.readers.programId, onSettled: onOwnSettled });
  const flowStep = venueSwap.flow.state.step;
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flowStep);
  const scope = ownerKey ? swapPendingScope(ownerKey) : null;
  const notes = venueSwap.pending.notes;
  const held = notes.length > 0;

  // Its note ended (the chain answered, or the hold was turned off or ran out): step 2 if
  // step 1 landed. A status that cannot be read is no answer, and is said as none.
  const answered = useRef<string | null>(null);
  useEffect(() => {
    const w = waitingFor;
    if (!w || answered.current === w.signature || notes.some((n) => n.signature === w.signature)) return;
    answered.current = w.signature;
    void (async () => {
      const end = await stepOneLanded(connection, w.signature);
      setWaitingFor(null);
      if (end === 'landed') return landed(w.plan, w.signature, w.least);
      ownPlan.current = null;
      venueSwap.flow.reset();
      setSaid(
        end === 'failed'
          ? { title: 'Step 1 did not land', text: `${shortSig(w.signature)} was refused on chain. Only the network fee was spent.`, tone: 'warn' }
          : { title: 'Step 1 not confirmed', text: `Whether ${shortSig(w.signature)} landed could not be read. Check your wallet before you press again.`, tone: 'warn' },
      );
      setPhase({ kind: 'form' });
    })();
    // `landed` and the flow read this render's values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingFor, notes, connection]);

  // The review in our pool was cancelled or started over: back to the form.
  const prevStep = useRef(flowStep);
  useEffect(() => {
    const was = prevStep.current;
    prevStep.current = flowStep;
    if (was !== 'idle' && flowStep === 'idle' && phase.kind === 'own') setPhase({ kind: 'form' });
  }, [flowStep, phase.kind]);
  // Step 1 landed in our pool: its confirmed card gives way to step 2.
  const { reset: resetOwn } = venueSwap.flow;
  useEffect(() => {
    if (phase.kind === 'step2' && flowStep === 'outcome') resetOwn();
  }, [phase.kind, flowStep, resetOwn]);

  // Step 1 landed in another tab: this one, open on step 1 and not sending, offers step 2
  // instead (and takes the read figure once that tab has it).
  const phaseNow = useRef(phase);
  useEffect(() => {
    phaseNow.current = phase;
  }, [phase]);
  useEffect(() => {
    if (!ownerKey) return;
    const onStorage = () => {
      const note = readStepTwo(ownerKey, view.address);
      const ph = phaseNow.current;
      if (!note) return;
      const onStepOne = ph.kind === 'form' || ph.kind === 'review' || (ph.kind === 'own' && (prevStep.current === 'idle' || prevStep.current === 'preparing' || prevStep.current === 'review'));
      const readNow = ph.kind === 'step2' && !ph.done && ph.note.signature === note.signature && !ph.note.gotExact && note.gotExact;
      if (!onStepOne && !readNow) return;
      if (ph.kind === 'own') {
        ownPlan.current = null;
        resetOwn();
      }
      void openStep2(note);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [ownerKey, view.address, openStep2, resetOwn]);

  // One panel at a time (useLpWrites): busy while step 1 is on its way. Step 2's form reports its own.
  const busy =
    phase.kind === 'planning' || phase.kind === 'sending' || flowStep === 'preparing' || flowStep === 'submitting' || flowStep === 'sent' || venueSwap.flow.locked;
  const { setBusy } = writes;
  useEffect(() => {
    if (phase.kind !== 'step2') setBusy(busy);
  }, [busy, phase.kind, setBusy]);
  useEffect(() => () => setBusy(false), [setBusy]);

  /** Build step 1 in our pool, by the swap page's route rule: Jupiter is quoted again for the same swap first. */
  const ownBuild = (p: Plan, force: AggregatorSeen | null) => async (): Promise<Prepared> => {
    const ready = venueSwap.ready;
    if (!ready || !owner || slippageBps === null) return notBuilt(OWN_ROUTE_COPY.poolGone);
    const bps = slippageBps;
    const buildIn = (address: string, aggregator: AggregatorSeen) =>
      ready.api.prepareVenueSwap(venueSwap.rpc, ready.gate, {
        owner,
        pool: new PublicKey(address),
        inputMint: new PublicKey(p.inputMint),
        outputMint: new PublicKey(p.outputMint),
        amountIn: p.swapIn,
        slippageBps: bps,
        aggregator,
      });
    if (force) return buildIn(p.view.address, force);
    const amount = p.swapIn.toString();
    const seen: { fresh: JupiterQuote | null; sends: boolean | null } = { fresh: null, sends: null };
    const jupTx = (fresh: JupiterQuote) =>
      prepareJupiterSwap(JUPITER, { fresh, shown: fresh, inputMint: p.inputMint, outputMint: p.outputMint, amount, slippageBps: Number(bps), user: owner.toBase58(), priority: speed() });
    // A test run that could not run refuses nothing (law 8).
    const sends = (j: PreparedJupiterSwap | null) => !(j?.status === 'blocked' && !j.unchecked);
    return prepareOwnPoolSwap(
      {
        aggregatorOut: async () => {
          let fresh: JupiterQuote;
          try {
            fresh = await getQuote({ inputMint: p.inputMint, outputMint: p.outputMint, amount, slippageBps: Number(bps) });
          } catch (e) {
            if (e instanceof NoRouteError) return null;
            throw e;
          }
          seen.fresh = fresh;
          const quoted = BigInt(fresh.outAmount);
          if (!swapCarriesPlatformFee(p.inputMint, p.outputMint)) return quoted;
          try {
            const j = await jupTx(fresh);
            seen.sends = sends(j);
            if (j.status === 'blocked') return quoted;
            learnNoFee(pair(p), j.status === 'moved' || j.siteFeeWaived);
            return BigInt(j.quote.outAmount);
          } catch {
            seen.sends = true;
            return quoted;
          }
        },
        aggregatorSends: async () => {
          if (seen.sends !== null || seen.fresh === null) return seen.sends ?? true;
          seen.sends = sends(await jupTx(seen.fresh).catch(() => null));
          return seen.sends;
        },
        ownPools: async () => {
          const r = await readPool();
          const c = r ? candidate(r.view, r.now, p.inputMint, p.swapIn) : null;
          return c ? [c] : [];
        },
        prepare: buildIn,
      },
      null,
    );
  };

  /**
   * Read the pool and the prices again and decide step 1: its route, its share, what it
   * pays, and what step 2 then adds and leaves. `force`: this pool's swap, for a Jupiter
   * transaction refused or not checkable (its review says which). Nothing is signed here.
   */
  async function plan(force: 'refused' | 'unchecked' | null = null, why: string | null = null, keep: Said | null = null) {
    if (!owner || total === null || total < 2n || slippageBps === null) return;
    setSaid(keep);
    setOwnOffer(false);
    if (stepTwoOwed()) return;
    setPhase({ kind: 'planning' });
    const read = await readPool();
    if (!read) {
      setSaid({ title: 'Not read', text: 'This pool could not be read just now. Nothing was sent. Try again in a moment.', tone: 'warn' });
      setPhase({ kind: 'form' });
      return;
    }
    const v = read.view;
    const [inputMint, outputMint] = paid === 'quote' ? [coin.mint, v.tokenMint] : [v.tokenMint, coin.mint];
    const in0 = inputMint === v.snapshot.pool.token0Mint;
    const [rIn, rOut] = in0 ? [v.snapshot.reserve0, v.snapshot.reserve1] : [v.snapshot.reserve1, v.snapshot.reserve0];
    const own = venueSwap.ready && v.config && !v.vaultsFrozen ? ownPoolShare(v.snapshot, v.config, inputMint, total, read.now) : null;
    const noFee = noFeePairs.current.has(`${inputMint}|${outputMint}`) ? { noPlatformFee: true } : {};
    const ask = (amount: bigint) => getQuote({ inputMint, outputMint, amount: amount.toString(), slippageBps: Number(slippageBps), ...noFee });
    const base = { view: v, paid, inputMint, outputMint, total, bps: slippageBps };

    if (force) {
      if (!own) {
        setSaid({ title: 'Not built', text: OWN_ROUTE_COPY.poolGone, tone: 'warn' });
        setPhase({ kind: 'form' });
        return;
      }
      // Jupiter's figure for this very swap: the review compares like with like.
      const out = await ask(own.swapIn).then((q) => BigInt(q.outAmount), () => null);
      const seen: AggregatorSeen = out === null ? { kind: 'unreachable' } : force === 'refused' ? { kind: 'refused', out, ...(why ? { why } : {}) } : { kind: 'unchecked', out };
      if (stepTwoOwed()) return;
      startOwn({ ...base, route: 'own', swapIn: own.swapIn, out: own.out, min: null, quote: null, poolOut: own.out, two: twoOf(own.after, own.swapIn, own.out) }, seen);
      return;
    }

    let jup: { quote: JupiterQuote; swapIn: bigint } | 'no-route' | 'unread';
    try {
      const half = await ask(total / 2n);
      const s = outsideShare(total, BigInt(half.inAmount), BigInt(half.outAmount), rIn, rOut);
      jup = s === null || s <= 0n ? 'unread' : { quote: await ask(s), swapIn: s };
    } catch (e) {
      jup = e instanceof NoRouteError ? 'no-route' : 'unread';
    }
    // Step 1 may have landed in another tab while the prices were read.
    if (stepTwoOwed()) return;
    if (typeof jup === 'object') {
      // What this pool pays for the same swap, said even when its swap cannot be sent from here.
      const at = candidate(v, read.now, inputMint, jup.swapIn);
      const out = BigInt(jup.quote.outAmount);
      // The swap page's rule (route.ts): our pool takes the swap when it pays at least as much.
      if (!own || freshDecision(at ? [at] : [], out).chosen?.venue !== 'own-pool') {
        setPhase({
          kind: 'review',
          plan: { ...base, route: 'jupiter', swapIn: jup.swapIn, out, min: BigInt(jup.quote.otherAmountThreshold), quote: jup.quote, poolOut: at?.outAmount ?? null, two: twoOf(v.snapshot, jup.swapIn, out) },
        });
        return;
      }
    }
    if (!own) {
      const pool = venueSwap.unavailable ?? 'this pool cannot price it';
      setSaid({
        title: 'No route',
        text: jup === 'no-route' ? `Jupiter has no route for this swap, and this pool cannot take it here (${pool}). Nothing was sent.` : `Jupiter’s price could not be fetched just now, and this pool cannot take this swap here (${pool}). Nothing was sent. Try again in a moment.`,
        tone: 'warn',
      });
      setPhase({ kind: 'form' });
      return;
    }
    startOwn({ ...base, route: 'own', swapIn: own.swapIn, out: own.out, min: null, quote: null, poolOut: own.out, two: twoOf(own.after, own.swapIn, own.out) }, null);
  }

  function twoOf(s: PoolView['snapshot'], swapIn: bigint, out: bigint): StepTwo | null {
    if (total === null || slippageBps === null) return null;
    const two = stepTwo(s, { quoteIsToken0: view.quoteIsToken0, paid, kept: total - swapIn, got: out, bps: slippageBps });
    return isPlanProblem(two) ? null : two;
  }

  function startOwn(p: Plan, force: AggregatorSeen | null) {
    ownPlan.current = p;
    setPhase({ kind: 'own', plan: p });
    void venueSwap.flow.prepare(ownBuild(p, force), { repeatable: true });
  }

  /** Step 1 through Jupiter: the swap page's Buy press (oneCoinSwap.ts). The wallet is asked here and nowhere before. */
  async function signJupiter(p: Plan) {
    if (!owner || !scope || !p.quote || slippageBps === null) return;
    setSaid(null);
    if (stepTwoOwed()) return;
    setPhase({ kind: 'sending', plan: p });
    // Until step 1 is answered the page does not reload itself (lib/staleBuild.ts), as on the swap page.
    const release = holdReload();
    let end: Awaited<ReturnType<typeof sendJupiterLeg>>;
    try {
      end = await sendJupiterLeg(
        {
          ...JUPITER,
          ownPoolWins: async (out) => {
            if (!venueSwap.ready) return false;
            const r = await within(readPool(), OWN_CHECK_MS, null);
            const c = r ? candidate(r.view, r.now, p.inputMint, p.swapIn) : null;
            return ownPoolNowWins(async () => (c ? [c] : []), out);
          },
          // Read again right before the wallet: a swap still held, or a step 1 that landed in another tab.
          holdsNow: () => venueSwap.pending.holdsNow(scope) || owed() !== null,
          hold: (n) => venueSwap.pending.hold({ kind: 'jupiter-swap', ...n }, scope),
          stillHeld: (n) => readPendingTrades(scope).some((x) => noteKey(x) === noteKey(n)),
          release: (sig) => venueSwap.pending.release(sig, scope),
          send: (tx) => sendTransaction(tx, connection),
          rpc: connection,
        },
        {
          shown: p.quote,
          inputMint: p.inputMint,
          outputMint: p.outputMint,
          amount: p.swapIn.toString(),
          slippageBps: Number(slippageBps),
          user: owner.toBase58(),
          priority: speed(),
          uncheckedBefore: uncheckedRun.current,
          words: `≈${about(other(p.paid), p.out)} with ${exact(p.paid, p.swapIn)}`,
          onNoFee: (nf) => learnNoFee(pair(p), nf),
        },
      );
    } finally {
      release();
    }
    if (end.kind === 'not-sent') {
      if (stepTwoOwed()) return;
      uncheckedRun.current = end.unchecked ? uncheckedRun.current + 1 : 0;
      const line: Said = { title: end.title, text: end.message, tone: 'warn' };
      if (end.refused && venueSwap.ready) {
        void plan('refused', end.refused.why, { title: 'Route changed', text: `${OWN_ROUTE_COPY.jupiterRefused}${end.refused.why ? ` ${end.refused.why}.` : ''}`, tone: 'warn' });
        return;
      }
      if (end.replan) {
        void plan(null, null, line);
        return;
      }
      setSaid(line);
      setOwnOffer(end.message === CHECK_KEEPS_FAILING && venueSwap.ready !== null);
      setPhase({ kind: 'review', plan: p });
      return;
    }
    uncheckedRun.current = 0;
    if (end.kind === 'lost') {
      setSaid({ title: LOST_ANSWER_TITLE, text: end.message, tone: 'warn' });
      setPhase({ kind: 'form' });
      return;
    }
    // The floor of the transaction that was sent (its fresh quote's), which can sit one
    // slippage step under the review's. Unparseable: nothing is assumed.
    const least = floorOf(end.quote);
    if (end.outcome === 'confirmed') return landed(p, end.signature, least);
    if (end.outcome === 'reverted') {
      setSaid({ title: 'Swap refused on chain', text: `${shortSig(end.signature)}. Only the network fee was spent. Nothing else changed.`, tone: 'bad' });
      setPhase({ kind: 'form' });
      return;
    }
    setWaitingFor({ plan: p, signature: end.signature, least });
    setSaid({ title: 'Sent, not confirmed yet', text: `${shortSig(end.signature)}. Step 2 is offered here once the network says it landed.`, tone: 'warn' });
    setPhase({ kind: 'waiting', plan: p, signature: end.signature });
  }

  // ── what is drawn ──
  if (phase.kind === 'step2') {
    const n = phase.note;
    const got = n.gotExact ? about(other(n.paid), n.got) : `at least ${exact(other(n.paid), n.got)} (what it paid could not be read)`;
    return (
      <AddLiquidityPanel
        // Opened again on a figure read later (another tab's step 1): its form starts from that.
        key={`${n.signature}:${n.got}`}
        view={phase.view}
        health={health}
        safety={safety}
        tokenDecimals={tokenDecimals}
        onClose={onClose}
        title="Step 2: add both coins"
        initial={phase.initial ?? undefined}
        onSettled={(o) => {
          if (o.status !== 'confirmed' || !ownerKey) return;
          clearStepTwo(ownerKey, view.address);
          setPhase((was) => (was.kind === 'step2' ? { ...was, done: true } : was));
        }}
        lead={
          <div data-testid="lp-one-step2" className="space-y-1.5">
            <Notice tone="good">
              {phase.done ? 'Both steps are done.' : `Step 1 is done (${shortSig(n.signature)}). It left you ${about(n.paid, n.kept)} and ${got} to add.`}
            </Notice>
            {!phase.done && (
              <button
                type="button"
                className="btn-secondary min-h-[44px] px-4 text-[12px]"
                onClick={() => {
                  if (ownerKey) clearStepTwo(ownerKey, view.address);
                  setPhase({ kind: 'form' });
                }}
              >
                Skip step 2
              </button>
            )}
          </div>
        }
      />
    );
  }

  const plan_ = phase.kind === 'review' || phase.kind === 'sending' || phase.kind === 'waiting' || phase.kind === 'own' ? phase.plan : null;
  const loadingOwn = venueSwap.loading;
  const canReview = !!signer && total !== null && total >= 2n && !bad && !over && !shortOfSol && slippageBps !== null && !held && !loadingOwn && phase.kind === 'form';
  const hint = !signer
    ? 'Connect a wallet to see what you can put in.'
    : !facts
      ? 'Reading your wallet…'
      : facts.kind === 'unread'
        ? `You have: could not read (${facts.detail})`
        : available === null
          ? `You have: could not read (this wallet’s ${name(paid)} was not read)`
          : paysSol
            ? `Up to ${coinExact(available, coin)} after both steps’ fees and deposits.`
            : `You have ${exact(paid, available)}.`;

  return (
    <PanelFrame testId="lp-one-coin-panel" title="Add with one coin" headingRef={headingRef}>
      {!signer && <WalletNeeded state={writes.signerState} />}
      {said && (
        <div role="alert" data-testid="lp-one-said">
          <Notice tone={said.tone}>
            {said.title}: {said.text}
          </Notice>
        </div>
      )}
      {held && phase.kind !== 'own' && (
        <PendingTradeCard
          state={venueSwap.pending}
          explorerUrl={(sig) => (venueSwap.api ? venueSwap.api.explorerTxUrl(sig, venueSwap.cfg?.cluster ?? 'mainnet') : `https://solscan.io/tx/${sig}`)}
          title={notes.some((n) => n.signature !== null) ? 'A swap from this wallet is not confirmed yet' : 'A swap may have been sent'}
          lead={
            <>
              <Notice tone="warn">It may still land. Swapping again now could make you pay twice.</Notice>
              {notes.some((n) => n.signature !== null) && <Notice>Step 1 stays off for this wallet until the network answers: 10 minutes at most.</Notice>}
              {notes.some((n) => n.signature === null) && <Notice>Step 1 stays off for this wallet until this swap can no longer land: 2 minutes at most.</Notice>}
            </>
          }
          describe={(n) => <p className="text-white/70">{n.signature === null ? LOST_NO_SIGNATURE : n.kind === 'jupiter-swap' ? 'Through Jupiter' : 'In our own pool'}</p>}
          testId="lp-one-held"
          dismissLabel="Turn step 1 back on now"
          dismissMeans="This does not cancel the swap. If it lands, it lands."
        />
      )}

      {phase.kind === 'own' && venueSwap.api && (
        <TxFlowView
          flow={venueSwap.flow}
          api={venueSwap.api}
          cluster={venueSwap.cfg?.cluster ?? 'mainnet'}
          decimals={null}
          signer={signer}
          extraReview={
            <>
              <Notice>Step 1 of 2 is this swap, in this pool (below). Step 2 adds both coins once it lands, with its own review.</Notice>
              <StepTwoRows plan={phase.plan} about={about} quoteIsToken0={view.quoteIsToken0} lpDecimals={pool.lpMintDecimals} />
            </>
          }
          preparingText="Reading this pool and Jupiter again, then test-running step 1 on the network…"
        />
      )}

      {plan_ && plan_.route === 'jupiter' && phase.kind !== 'own' && (
        <div className="space-y-1.5" data-testid="lp-one-review">
          <p className="text-white font-semibold">Step 1: swap, through Jupiter</p>
          <Row label="You pay" value={exact(plan_.paid, plan_.swapIn)} mono={false} />
          <Row label="You receive (quoted)" value={about(other(plan_.paid), plan_.out)} mono={false} />
          {plan_.min !== null && <Row label="You receive at least" value={exact(other(plan_.paid), plan_.min)} mono={false} />}
          {plan_.quote && <PriceChangeRows quote={plan_.quote} />}
          <Row
            label="Site fee"
            value={
              plan_.quote && quoteHasPlatformFee(plan_.quote)
                ? `${((plan_.quote.platformFee?.feeBps ?? 0) / 100).toFixed(2)}%, inside the quote`
                : swapCarriesPlatformFee(plan_.inputMint, plan_.outputMint)
                  ? 'none on this route'
                  : 'none on this pair'
            }
            mono={false}
          />
          {/* A pair that carries the fee, on a route whose transaction cannot take it (the 6014 retry): said as the swap page says it. */}
          {plan_.quote && !quoteHasPlatformFee(plan_.quote) && swapCarriesPlatformFee(plan_.inputMint, plan_.outputMint) && (
            <div data-testid="lp-one-no-fee">
              <Notice tone="warn">{NO_SITE_FEE_ROUTE_COPY}</Notice>
            </div>
          )}
          <Row label="This pool would pay" value={plan_.poolOut === null ? 'could not be read' : about(other(plan_.paid), plan_.poolOut)} mono={false} />
          <StepTwoRows plan={plan_} about={about} quoteIsToken0={view.quoteIsToken0} lpDecimals={pool.lpMintDecimals} />
          <Notice>Two transactions, two signatures. Step 2 has its own review.</Notice>
          {phase.kind === 'review' && (
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60" disabled={held} onClick={() => {
                  tick();
                  void signJupiter(plan_);
                }}>
                Sign in wallet
              </button>
              <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={() => setPhase({ kind: 'form' })}>
                Back
              </button>
            </div>
          )}
          {phase.kind === 'review' && ownOffer && (
            <button type="button" className="btn-secondary w-full min-h-[44px] text-[13px]" onClick={() => void plan('unchecked')}>
              {OWN_POOL_REVIEW_OFFER}
            </button>
          )}
          {phase.kind === 'sending' && <p role="status">Checking the swap again, then your wallet asks you to sign…</p>}
        </div>
      )}

      {phase.kind === 'planning' && <p role="status">Reading this pool and Jupiter’s price…</p>}

      {(phase.kind === 'form' || phase.kind === 'planning') && (
        <>
          <p data-testid="lp-one-what" className="text-white text-[14px] leading-relaxed">
            A share of the {tokenName}/{coin.symbol} pool and its fee on every trade. No lock, but the team&apos;s vault can pause removing.
          </p>
          <div role="group" aria-label="Pay with" className="flex gap-2">
            {(['quote', 'token'] as const).map((side) => (
              <button
                key={side}
                type="button"
                aria-pressed={paid === side}
                className={`${TOGGLE_CLS} min-h-[44px] px-4`}
                style={{ background: paid === side ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
                disabled={phase.kind !== 'form'}
                onClick={() => {
                  setPaid(side);
                  setText('');
                  setPctBps(null);
                }}
              >
                {name(side)}
              </button>
            ))}
          </div>
          <Field label={`${name(paid)} to put in`} hint={hint} error={bad ? `That is not a ${name(paid)} amount (at most ${decimalsOf(paid)} decimals).` : null}>
            {(a11y) => (
              <div className="flex gap-1.5 items-stretch">
                <input
                  {...a11y}
                  className={`${inputCls} flex-1 min-w-0`}
                  style={inputStyle}
                  value={text}
                  onChange={(e) => {
                    setText(decimalCommaToPoint(e.target.value, text));
                    setPctBps(null);
                  }}
                  placeholder="0.0"
                  inputMode="decimal"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={phase.kind !== 'form'}
                />
                {available !== null && available > 0n && (
                  <button
                    type="button"
                    className={`${TOGGLE_CLS} !flex-none min-w-[56px] px-3`}
                    style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
                    aria-label={`Max ${name(paid)}`}
                    onClick={() => {
                      tick();
                      setPctBps(null);
                      setText(baseUnitsToInput(available, decimalsOf(paid)));
                    }}
                  >
                    Max
                  </button>
                )}
              </div>
            )}
          </Field>
          {available !== null && available > 0n && (
            <PercentPicker
              partsOnly
              legend={`How much of your ${name(paid)}`}
              valueBps={pctBps}
              disabled={phase.kind !== 'form'}
              onChange={({ bps }) => {
                tick();
                setPctBps(bps);
                if (bps !== null) setText(baseUnitsToInput((available * bps) / 10_000n, decimalsOf(paid)));
              }}
            />
          )}
          {sharePct !== null && !bad && (
            <div data-testid="lp-one-share">
              <div
                className="h-2 rounded-full overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.10)' }}
                role="img"
                aria-label={`About ${shareText(sharePct)} of the pool`}
              >
                <div
                  className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300"
                  style={{ width: `${Math.min(100, sharePct)}%`, minWidth: '3px', background: '#31d0aa' }}
                />
              </div>
              <p className="text-white/70 text-[12px] mt-1">About {shareText(sharePct)} of the pool, at its price now.</p>
            </div>
          )}
          <SlippagePicker valueBps={slippageBps} onChange={setSlippageBps} hint="Used by both steps. If a price moves more than this first, that step is refused and only its network fee is spent." />
          {over && available !== null && <Notice tone="warn">That is more than you can use. The most is {exact(paid, available)}.</Notice>}
          {shortOfSol && setAside !== null && <Notice tone="warn">Your wallet needs {solExact(setAside)} for both steps’ fees and deposits.</Notice>}
          {health.deposits.warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
          {coin.risk && <Notice tone="warn">{coin.risk}</Notice>}
          <p className="text-white/60" data-testid="lp-one-line">
            {ONE_COIN_LINE}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              ref={reviewRef}
              type="button"
              className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60 disabled:grayscale"
              disabled={!canReview}
              onClick={() => {
                tick();
                void plan();
              }}
            >
              Review: add with one coin
            </button>
            <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onClose}>
              Close
            </button>
          </div>
          {/* Off the page (owner, 2026-10-17: "remove this warning from everywhere"), one press away. */}
          <FinePrint summary="Risks" testId="lp-one-risk">
            <p>{RISK_SHORT}</p>
          </FinePrint>
          {onPair && (
            <button type="button" className="min-h-[44px] text-[13px] text-white/85 underline underline-offset-2 text-left" onClick={onPair}>
              I have both coins
            </button>
          )}
          {signer && loadingOwn && phase.kind === 'form' && (
            <p role="status" className="text-white/60" data-testid="lp-one-loading">
              Getting this pool’s swap ready, so Review can compare it with Jupiter…
            </p>
          )}
          <FinePrint summary="How it works">
            <p>
              Step 1 swaps part of your coin for the other one, through whichever pays more for that swap: Jupiter or this pool. It is an ordinary swap
              with the swap page’s rules and fees. Through Jupiter the site fee is taken where it can be; in this pool you pay the pool’s own fee.
            </p>
            <p>
              The part swapped is worked out from that route’s fresh quote, and from this pool’s price after the swap when the swap is in this pool, so it
              is not always half. Step 2 adds what you kept and what came back at the pool’s ratio, through the usual Add liquidity review.
            </p>
            <p>
              Whatever is not used of either coin stays in your wallet; the review says about how much. Two transactions, two signatures. If step 2 is
              cancelled or fails, step 1 stays done and step 2 is offered again here.
            </p>
          </FinePrint>
        </>
      )}
    </PanelFrame>
  );
}

/** The share bar's words: two decimals, and never a zero for a share that is not one. */
function shareText(pct: number): string {
  return pct < 0.01 ? 'under 0.01%' : `${pct.toFixed(2)}%`;
}

/** What step 1 costs in price, from Jupiter's own figure, and the swap page's warning when it is large. */
function PriceChangeRows({ quote }: { quote: JupiterQuote }) {
  const change = priceChangeOf(quote);
  const w = change ? impactWarning(change.bps) : null;
  return (
    <>
      <Row label="Price change" value={change?.text ?? 'could not be read'} mono={false} />
      {w && <Notice tone={w.tone}>{w.text}</Notice>}
    </>
  );
}

/** Step 2 as the review of step 1 expects it, and what stays in the wallet. */
function StepTwoRows({ plan, about, quoteIsToken0, lpDecimals }: { plan: Plan; about: (side: Side, v: bigint) => string; quoteIsToken0: boolean; lpDecimals: number }) {
  const two = plan.two;
  if (!two) return <Notice tone="warn">What step 2 adds could not be worked out from these figures. It has its own review.</Notice>;
  const cost = { quote: quoteIsToken0 ? two.plan.cost0 : two.plan.cost1, token: quoteIsToken0 ? two.plan.cost1 : two.plan.cost0 };
  return (
    <div className="space-y-1.5" data-testid="lp-one-step2-plan">
      <p className="text-white font-semibold">Step 2: add</p>
      <Row label="You put in about" value={`${about('quote', cost.quote)} and ${about('token', cost.token)}`} mono={false} />
      <Row label="You get about" value={`${unitsExact(two.plan.lp, lpDecimals)} pool shares`} mono={false} />
      <Row label="Left in your wallet, about" value={`${about('quote', two.left.quote)} and ${about('token', two.left.token)}`} mono={false} />
    </div>
  );
}
