import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { VersionedTransaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { SOL_MINT, SOLANA_PLATFORM_FEE_BPS, isSolanaFeeConfigured } from '../../lib/solana';
import { NoRouteError, buildSwapTransaction, fromBaseUnits, getQuote, getUsdPrices, simulateSwap, swapCarriesPlatformFee, type JupiterQuote, type PriorityLevel } from '../../lib/jupiter';
import { MIN_USD_PER_COIN, SOL_BASKET, shortAmount, splitEvenly, usdText, usdToBaseUnits, type SolBasketCoin } from '../../lib/islandBasket';
import { pinnedGetQuote, prepareSolLeg, retryingGetQuote, solLegRoute, BASKET_COPY, PoolNotNamedError } from '../../lib/solana/swap/islandBasketSol';
import { within } from '../../lib/solana/swap/ownPoolRoute';
import type { VenuePoolCandidate } from '../../lib/solana/swap/venuePools';
import { pollConfirm } from '../../lib/solana/confirm';
import { readSendThrow } from '../../lib/solana/walletThrow';
import { HELD_NOT_SENT, LOST_ANSWER_TITLE, lostAnswerCopy } from '../../lib/solana/swap/walletCopy';
import { jupiterLastValidAtMost } from '../../lib/solana/swap/jupiterNote';
import { blockhashSeen, recentBlockhashOf, type NoteBlockhash } from '../../lib/solana/blockhashWindow';
import { swapPendingScope } from '../solana/curve/pendingTrade';
import type { PendingTradesState } from '../solana/curve/usePendingTrades';
import { recordActivity } from '../../lib/solanaActivity';
import { setLastBuy } from '../../lib/heat/lastBuy';
import { bungalowByAddress } from '../../lib/bungalows';
import { surfaceUnconfirmedTx } from '../../lib/txErrors';
import { readOwnPoolsFor } from './useSolanaRoute';
import { BasketCta, IslandBasketButton, IslandBasketDialog, type BasketRow, type RowTone } from './IslandBasket';

/**
 * The order's figures are asked for again this often while it is open. Longer than the
 * swap's 30 s: five coins a round against Jupiter's rate limit (the site's relay allows 60
 * calls a minute). What is sent is quoted again at the press and held to these figures.
 */
const REQUOTE_MS = 60_000;
/** While a price is missing, it is asked for again this soon. */
const RETRY_MS = 15_000;
/** Between one coin's Jupiter quote and the next: Jupiter's keyless tier refuses a burst. */
const QUOTE_GAP_MS = 1_100;
/** How long one coin's Jupiter quote (retries included) may take before it counts as unread. */
const QUOTE_TIMEOUT_MS = 15_000;
const PRESS_QUOTE_TIMEOUT_MS = 30_000;
/** How long a read of our pools may take: the order view waits longer than a press does (the swap's OWN_CHECK_MS). */
const OWN_READ_MS = 8_000;
const OWN_CHECK_MS = 4_000;
/** `p`, or a rejection after `ms`: a public endpoint that stalls must not hold the order. */
const timed = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timed out')), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
});
/**
 * Jupiter's quote within a time limit, asked again after a refusal (a rate limit is a wait,
 * not a missing price): once for the figures on screen, up to three times for a coin being
 * bought, which is better late than skipped.
 */
const shownRetry = retryingGetQuote(getQuote, [2_500]);
const pressRetry = retryingGetQuote(getQuote, [2_500, 5_000, 10_000]);
const quoteJupiter: typeof shownRetry = (q) => timed(shownRetry(q), QUOTE_TIMEOUT_MS);
const quoteForPress: typeof pressRetry = (q) => timed(pressRetry(q), PRESS_QUOTE_TIMEOUT_MS);
/** How long a sent coin is watched before the order says it cannot tell (the swap's own wait). */
const CONFIRM_TIMEOUT_MS = 90_000;
/** About what opening one coin's account costs (rent, refunded if it is closed), plus its fees. */
const PER_COIN_RESERVE_LAMPORTS = 3_000_000n;

type Leg = { coin: SolBasketCoin; amountIn: bigint };
type LegQuote = { jupiter: JupiterQuote | null; own: VenuePoolCandidate[] | null; why: string | null };
type LegState =
  | { kind: 'busy'; text: string }
  | { kind: 'bought' }
  | { kind: 'own' }
  | { kind: 'not-sent'; why: string }
  | { kind: 'refused' }
  | { kind: 'unknown' };

const sol = (lamports: bigint) => Number(fromBaseUnits(lamports.toString(), 9));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A coin a press may (re)buy: never one bought, one left for our pool's review, or one we cannot tell about. */
const buyable = (s: LegState | undefined): boolean => !s || s.kind === 'not-sent' || s.kind === 'refused';

/**
 * Where a coin goes on the quotes shown, and what it is quoted to pay there. A Jupiter price
 * that could not be read is `unread`: never a route for our pool by default.
 */
function shownRoute(q: LegQuote | undefined): { decision: 'own' | 'jupiter' | 'none' | 'unread'; out: bigint | null } | null {
  if (!q) return null;
  if (!q.jupiter && !q.why) return { decision: 'unread', out: null };
  let jup: bigint | null;
  try { jup = q.jupiter ? BigInt(q.jupiter.outAmount) : null; } catch { jup = null; }
  const decision = solLegRoute(jup, q.own ?? []);
  return { decision, out: decision === 'own' ? (q.own?.[0]?.outAmount ?? null) : jup };
}

/**
 * The island order on Solana. Each coin is its own transaction, built and test-run just
 * before its own wallet prompt. A coin our own pool wins is handed to the swap form, whose
 * review buys it (`onOwnLeg`). The page's pending notes hold this order exactly as they
 * hold Buy: one sent swap that is not confirmed stops the rest.
 */
export function IslandBasketSolana(p: {
  slippageBps: number;
  priority: PriorityLevel;
  pending: Pick<PendingTradesState, 'hold' | 'release' | 'holdsNow'>;
  /** Put this coin's share on the swap form, where our pool's review buys it. */
  onOwnLeg: (coin: SolBasketCoin, lamports: bigint) => void;
  /** The swap form has a trade on its way, or a sent one holds this wallet. */
  busy: boolean;
  /** Tests pass 0; QUOTE_GAP_MS otherwise. */
  quoteGapMs?: number;
}) {
  const gap = p.quoteGapMs ?? QUOTE_GAP_MS;
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [open, setOpen] = useState(false);
  const [usd, setUsd] = useState('10');
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [lamports, setLamports] = useState<bigint | null>(null);
  const [quotes, setQuotes] = useState<{ key: string; legs: LegQuote[] } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [running, setRunning] = useState(false);
  const [states, setStates] = useState<Record<number, LegState>>({});
  // The split a press bought with. It stands until the amount is changed: a new SOL price
  // must not re-size, or wipe, an order already part bought.
  const [frozen, setFrozen] = useState<{ usd: string; shares: bigint[] } | null>(null);
  const [notice, setNotice] = useState<{ tone: RowTone; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const stopAfter = useRef(false);
  const wallet = publicKey?.toBase58() ?? null;

  const n = SOL_BASKET.length;
  const dollars = Number(usd);
  const tooSmall = Number.isFinite(dollars) && dollars > 0 && dollars < MIN_USD_PER_COIN * n;
  const computed = useMemo(() => {
    const total = tooSmall ? null : usdToBaseUnits(usd, solUsd, 9);
    return total !== null ? splitEvenly(total, n) : null;
  }, [usd, solUsd, tooSmall, n]);
  const shares = frozen && frozen.usd === usd ? frozen.shares : computed;
  const total = shares ? shares.reduce((s, x) => s + x, 0n) : null;
  const orderKey = shares ? `${shares.join(',')}|${p.slippageBps}` : null;
  const legs = useMemo<Leg[] | null>(() => (shares ? SOL_BASKET.map((coin, i) => ({ coin, amountIn: shares[i]! })) : null), [shares]);

  // A new amount or wallet is a new order: the last one's results go (never mid-run).
  const orderOf = `${usd}|${wallet ?? ''}`;
  const [resultsFor, setResultsFor] = useState(orderOf);
  if (resultsFor !== orderOf && !running) {
    setResultsFor(orderOf);
    setStates({});
    setNotice(null);
    setFrozen(null);
  }

  // SOL's price and this wallet's SOL while the order is open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const read = () => {
      void getUsdPrices([SOL_MINT]).then((pr) => { if (!cancelled) setSolUsd(pr[SOL_MINT] ?? null); }).catch(() => { /* the last price stands */ });
      if (publicKey) void connection.getBalance(publicKey, 'confirmed').then((b) => { if (!cancelled) setLamports(BigInt(b)); }).catch(() => { if (!cancelled) setLamports(null); });
    };
    read();
    const iv = running ? null : setInterval(read, REQUOTE_MS);
    return () => { cancelled = true; if (iv) clearInterval(iv); };
  }, [open, running, publicKey, connection, tick]);

  // Our pools for every coin at once (they are not Jupiter's), then Jupiter one coin at a time.
  const quoteAll = useCallback(async (ls: Leg[], live: () => boolean): Promise<LegQuote[] | null> => {
    const own = await Promise.all(ls.map((l) => within(readOwnPoolsFor(SOL_MINT, l.coin.mint, l.amountIn), OWN_READ_MS, null)));
    const out: LegQuote[] = [];
    for (let i = 0; i < ls.length; i++) {
      if (!live()) return null;
      if (i > 0 && gap > 0) await wait(gap);
      const l = ls[i]!;
      try {
        const jupiter = await pinnedGetQuote(quoteJupiter, l.coin)({ inputMint: SOL_MINT, outputMint: l.coin.mint, amount: l.amountIn.toString(), slippageBps: p.slippageBps });
        out.push({ jupiter, own: own[i] ?? null, why: null });
      } catch (e) {
        const why = e instanceof PoolNotNamedError ? BASKET_COPY.poolNotNamed : e instanceof NoRouteError ? BASKET_COPY.noRoute : null;
        out.push({ jupiter: null, own: own[i] ?? null, why });
      }
    }
    return out;
  }, [p.slippageBps, gap]);

  const latest = useRef(0);
  useEffect(() => {
    if (!open || running || !legs || !orderKey) return;
    const id = ++latest.current;
    const t = setTimeout(() => {
      setQuoting(true);
      void quoteAll(legs, () => latest.current === id).then((q) => {
        if (latest.current !== id || !q) return;
        setQuotes({ key: orderKey, legs: q });
        setQuoting(false);
      });
    }, 500);
    return () => clearTimeout(t);
  }, [open, running, legs, orderKey, quoteAll, tick]);

  const shown = quotes && quotes.key === orderKey ? quotes.legs : null;
  const setLeg = (i: number, s: LegState) => setStates((was) => ({ ...was, [i]: s }));
  // Asked again every REQUOTE_MS while idle, and every RETRY_MS while a price is missing: one
  // unread coin holds the whole order, so it is not left waiting a full round.
  const anyUnread = shown?.some((q) => shownRoute(q)?.decision === 'unread') ?? false;
  useEffect(() => {
    if (!open || running) return;
    const iv = setInterval(() => setTick((x) => x + 1), anyUnread ? RETRY_MS : REQUOTE_MS);
    return () => clearInterval(iv);
  }, [open, running, anyUnread]);

  async function buy() {
    if (!publicKey || !legs || !shares || !shown || running) return;
    const user = publicKey.toBase58();
    const scope = swapPendingScope(user);
    const before = states;
    setRunning(true);
    setNotice(null);
    setFrozen({ usd, shares });
    stopAfter.current = false;
    let bought = 0;
    try {
      for (let i = 0; i < legs.length; i++) {
        if (!buyable(before[i])) continue;
        if (stopAfter.current) break;
        const leg = legs[i]!;
        const q = shown[i]!;
        if (!q.jupiter) {
          // No Jupiter price was shown for it: our pool takes it if it quoted, otherwise nothing is sent.
          if (shownRoute(q)?.decision === 'own') setLeg(i, { kind: 'own' });
          else setLeg(i, { kind: 'not-sent', why: q.why ?? 'It had no price when the order was shown.' });
          continue;
        }
        setLeg(i, { kind: 'busy', text: 'Checking…' });
        const prepared = await prepareSolLeg(
          {
            getQuote: pinnedGetQuote(quoteForPress, leg.coin),
            buildSwapTransaction,
            simulateSwap: (b64) => simulateSwap(b64),
            swapCarriesPlatformFee,
            ownPools: () => within(readOwnPoolsFor(SOL_MINT, leg.coin.mint, leg.amountIn), OWN_CHECK_MS, null),
          },
          { coin: leg.coin, inputMint: SOL_MINT, amountIn: leg.amountIn, shown: q.jupiter, shownOwn: q.own, slippageBps: p.slippageBps, user, priority: p.priority },
        );
        if (prepared.kind === 'own') { setLeg(i, { kind: 'own' }); continue; }
        if (prepared.kind === 'not-sent') { setLeg(i, { kind: 'not-sent', why: prepared.why }); continue; }
        // A swap this wallet sent, in any tab, that the chain has not answered for holds the
        // rest. From this read to the wallet's prompt nothing is awaited.
        if (p.pending.holdsNow(scope)) {
          setLeg(i, { kind: 'not-sent', why: HELD_NOT_SENT });
          setNotice({ tone: 'warn', text: HELD_NOT_SENT });
          break;
        }
        const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.swapTransaction), (c) => c.charCodeAt(0)));
        const outWords = `≈${shortAmount(Number(fromBaseUnits(prepared.quote.outAmount, leg.coin.decimals)))} ${leg.coin.symbol}`;
        // The note that holds Buy for this wallet until the chain answers: the swap's own.
        const lastValid: { at: number | null } = { at: null };
        const heightRead = jupiterLastValidAtMost(() => connection.getBlockHeight('confirmed')).then((h) => (lastValid.at = h));
        const proof: { bh: NoteBlockhash | null } = { bh: null };
        const bhRead = blockhashSeen(connection, recentBlockhashOf(tx)).then((b) => (proof.bh = b));
        const note = (signature: string | null) => {
          const sentAt = Date.now();
          const write = () => p.pending.hold({ kind: 'jupiter-swap', signature, lastValidBlockHeight: signature ? lastValid.at : null, blockhash: proof.bh, sentAt }, scope);
          write();
          const had = { at: lastValid.at, bh: proof.bh };
          void Promise.all([heightRead, bhRead]).then(() => {
            if ((signature !== null && had.at === null && lastValid.at !== null) || (had.bh === null && proof.bh !== null)) write();
          });
        };
        setLeg(i, { kind: 'busy', text: 'At your wallet…' });
        let sig: string;
        try {
          sig = await sendTransaction(tx, connection);
        } catch (e) {
          const t = readSendThrow(e);
          if (t.kind === 'unsure') {
            note(null);
            setLeg(i, { kind: 'unknown' });
            toast.warning(LOST_ANSWER_TITLE, { description: lostAnswerCopy(t.reason, `it sent ${outWords} for ${sol(leg.amountIn).toFixed(4)} SOL`) });
          } else {
            setLeg(i, { kind: 'not-sent', why: t.message });
          }
          // A cancel, a wallet that did not sign, or an answer that went missing stops the order.
          break;
        }
        note(sig);
        setLeg(i, { kind: 'busy', text: 'Confirming…' });
        const { outcome } = await pollConfirm(connection, sig, CONFIRM_TIMEOUT_MS);
        if (outcome !== 'unknown') p.pending.release(sig, scope);
        if (outcome === 'reverted') {
          setLeg(i, { kind: 'refused' });
          continue;
        }
        if (outcome === 'unknown') {
          setLeg(i, { kind: 'unknown' });
          surfaceUnconfirmedTx(toast, { hash: sig, explorerUrl: `https://solscan.io/tx/${sig}`, repeatCost: `buying again buys ${leg.coin.symbol} a second time.` });
          recordActivity(user, { sig, ts: Date.now(), kind: 'swap', summary: `Sent, not confirmed: ${outWords} (island order)` });
          // Its note holds this wallet now: the rest wait until the chain answers.
          break;
        }
        bought++;
        setLeg(i, { kind: 'bought' });
        recordActivity(user, { sig, ts: Date.now(), kind: 'swap', summary: `Bought ${outWords} (island order)` });
        const room = bungalowByAddress('solana', leg.coin.mint);
        if (room) setLastBuy({ hash: sig, symbol: room.symbol, tokenAddress: leg.coin.mint, chain: room.chain, buyer: user, atUnix: Math.floor(Date.now() / 1000) });
      }
    } finally {
      setRunning(false);
      if (bought > 0) toast.success(`Bought ${bought} of ${legs.length} island coins`);
      setTick((x) => x + 1);
    }
  }

  const rows: BasketRow[] = SOL_BASKET.map((coin, i) => {
    const r = shownRoute(shown?.[i]);
    const s = states[i];
    const venue = !r ? null : r.decision === 'own' ? 'Our pool' : r.decision === 'jupiter' ? `${coin.pool.dex === 'pumpswap' ? 'PumpSwap' : 'Raydium'} via Jupiter` : r.decision === 'unread' ? 'Price not read' : 'No route';
    const status: BasketRow['status'] =
      !s ? (shown?.[i] && shown[i]!.own === null ? { tone: 'muted', text: 'Our pools not read' } : undefined)
      : s.kind === 'busy' ? { tone: 'busy', text: s.text }
      : s.kind === 'bought' ? { tone: 'ok', text: 'Bought' }
      : s.kind === 'own' ? { tone: 'warn', text: 'Our pool: review below' }
      : s.kind === 'refused' ? { tone: 'err', text: 'Refused on chain' }
      : s.kind === 'unknown' ? { tone: 'warn', text: 'Sent, not confirmed' }
      : { tone: 'err', text: s.why };
    return {
      key: coin.room,
      room: coin.room,
      symbol: coin.symbol,
      venue,
      pays: r?.out != null ? `≈ ${shortAmount(Number(fromBaseUnits(r.out.toString(), coin.decimals)))}` : quoting || (!shown && orderKey) ? null : '–',
      status,
    };
  });

  const ownLegs = SOL_BASKET.flatMap((coin, i) => (states[i]?.kind === 'own' ? [{ coin, i }] : []));
  const feeLine = isSolanaFeeConfigured()
    ? `Site fee: ${(SOLANA_PLATFORM_FEE_BPS / 100).toFixed(2)}% of each coin bought through Jupiter goes to the venue. A coin bought in our own pool pays its pool fee instead, inside its quote.`
    : 'No site fee is taken here. A coin bought in our own pool pays its pool fee, inside its quote.';
  const perCoin = Number.isFinite(dollars) && dollars > 0 ? dollars / n : 0;
  const summary = total !== null ? `${n} coins · ${usdText(perCoin)} each · ≈ ${sol(total).toFixed(4)} SOL` : null;
  const left = legs ? legs.filter((_, i) => buyable(states[i])).length : n;
  const started = Object.keys(states).length > 0;
  // A coin whose Jupiter price could not be read: the order waits for it, whatever our pools quote.
  const unread = shown?.some((q) => shownRoute(q)?.decision === 'unread') ?? false;
  const reserve = PER_COIN_RESERVE_LAMPORTS * BigInt(n);
  const short = total !== null && lamports !== null && lamports < total;
  const tight = total !== null && lamports !== null && !short && lamports < total + reserve;

  let label = started && left > 0 && left < n ? `Buy the ${left} left` : `Buy all ${n}`;
  let disabled = false;
  if (running) [label, disabled] = ['Buying…', true];
  else if (!publicKey) [label, disabled] = ['Connect a wallet to buy', true];
  else if (!dollars) [label, disabled] = ['Enter an amount', true];
  else if (tooSmall) [label, disabled] = [`Enter at least ${usdText(MIN_USD_PER_COIN * n)}`, true];
  else if (solUsd === null && !frozen) [label, disabled] = ['SOL price unavailable', true];
  else if (short) [label, disabled] = ['Not enough SOL', true];
  else if (p.busy) [label, disabled] = ['A swap is on its way', true];
  else if (!shown || quoting) [label, disabled] = ['Getting prices…', true];
  else if (left === 0) [label, disabled] = ['Nothing left to buy', true];
  else if (unread) [label, disabled] = ['A price could not be read', true];

  const shownNotice = notice
    ?? (solUsd === null && !frozen && dollars > 0 && !tooSmall && open ? { tone: 'warn' as const, text: 'SOL’s price could not be read yet, so the order cannot be sized.' } : null)
    ?? (unread && !quoting ? { tone: 'warn' as const, text: 'A price could not be read. It is asked again in a moment.', action: { label: 'Try again', onClick: () => setTick((x) => x + 1) } } : null)
    ?? (tight ? { tone: 'warn' as const, text: `Keep about ${sol(reserve).toFixed(3)} SOL more than this for fees and new coin accounts, or a coin may not go through.` } : null);

  return (
    <>
      <IslandBasketButton count={n} symbols={SOL_BASKET.map((c) => c.symbol)} onOpen={() => setOpen(true)} />
      <IslandBasketDialog
        open={open}
        onClose={() => setOpen(false)}
        closable={!running}
        chainName="Solana"
        usd={usd}
        setUsd={setUsd}
        locked={running}
        summary={summary}
        rows={rows}
        feeLine={feeLine}
        notice={shownNotice}
        cta={<BasketCta label={label} disabled={disabled} onClick={() => void buy()} />}
        after={
          running ? (
            <button type="button" onClick={() => { stopAfter.current = true; }} className="text-white/70 text-[11px] underline underline-offset-2 min-h-[36px]">
              Stop after this coin
            </button>
          ) : ownLegs.length > 0 && legs ? (
            <span className="flex flex-col gap-1.5" data-testid="island-basket-own">
              {ownLegs.map(({ coin, i }) => (
                <button
                  key={coin.room}
                  type="button"
                  onClick={() => { setOpen(false); p.onOwnLeg(coin, legs[i]!.amountIn); }}
                  className="w-full py-2 min-h-[40px] rounded-lg text-[12px] font-semibold text-white"
                  style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid var(--color-stan)' }}
                >
                  Review {coin.symbol} in our pool
                </button>
              ))}
            </span>
          ) : null
        }
        finePrint={
          <>
            <p>Each coin is bought through one pool, read on chain: PumpSwap for BAYLA, BOBO, SOY and BRAINLET, Raydium for RIZZ. Jupiter is asked for that pool only, and an answer through any other pool is refused. Old launch pools that migrated are never touched.</p>
            <p>Each coin is its own transaction, built and test-run just before its own wallet prompt. A coin already bought stays bought if a later one is not sent. If one is sent but not confirmed, the rest wait, so nothing is bought twice.</p>
            <p>Our own pool takes a coin when it pays at least as much, the swap’s rule. Every swap in our pool shows its review first, so that coin opens in the swap form.</p>
            <p>Slippage is your swap setting ({(p.slippageBps / 100).toFixed(2)}%). The amount is split at SOL’s price from Jupiter. At least {usdText(MIN_USD_PER_COIN)} a coin. A coin you do not hold yet opens an account for about 0.002 SOL, which you get back if you close it.</p>
          </>
        }
      />
    </>
  );
}
