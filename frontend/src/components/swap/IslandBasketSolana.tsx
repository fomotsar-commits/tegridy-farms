import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PublicKey, VersionedTransaction, type Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { SOL_MINT, SOLANA_PLATFORM_FEE_BPS, isSolanaFeeConfigured } from '../../lib/solana';
import { NoRouteError, buildSwapTransaction, fromBaseUnits, getQuote, getUsdPrices, simulateSwap, swapCarriesPlatformFee, type JupiterQuote, type PriorityLevel } from '../../lib/jupiter';
import { MIN_USD_PER_COIN, SOL_BASKET, shortAmount, splitEvenly, usdText, usdToBaseUnits, type SolBasketCoin } from '../../lib/islandBasket';
import { pinnedGetQuote, prepareSolLeg, retryingGetQuote, sendSigned, signatureOf, solLegRoute, stampBlockhash, BASKET_COPY, PoolNotNamedError, type PreparedSolLeg } from '../../lib/solana/swap/islandBasketSol';
import { freshDecision, within } from '../../lib/solana/swap/ownPoolRoute';
import { whileJupiterBusy } from '../../lib/solana/swap/jupiterBusy';
import type { VenuePoolCandidate } from '../../lib/solana/swap/venuePools';
import { pollConfirm } from '../../lib/solana/confirm';
import { readSendThrow, signThrowCopy } from '../../lib/solana/walletThrow';
import { HELD_NOT_SENT, LOST_ANSWER_TITLE, lostAnswerCopy } from '../../lib/solana/swap/walletCopy';
import { jupiterLastValidAtMost } from '../../lib/solana/swap/jupiterNote';
import { blockhashSeen, recentBlockhashOf, type NoteBlockhash } from '../../lib/solana/blockhashWindow';
import { swapPendingScope } from '../solana/curve/pendingTrade';
import type { PendingTradesState } from '../solana/curve/usePendingTrades';
import type { PreparedTx, SwapOpenGate, TxSigner, VenueSwapApi } from '../solana/curve/ports';
import { recordActivity } from '../../lib/solanaActivity';
import { setLastBuy } from '../../lib/heat/lastBuy';
import { bungalowByAddress } from '../../lib/bungalows';
import { surfaceUnconfirmedTx } from '../../lib/txErrors';
import { readOwnPoolsFor } from './useSolanaRoute';
import { BasketCta, IslandBasketButton, IslandBasketDialog, type BasketRow, type RowTone } from './IslandBasket';

/**
 * The order's figures are asked for again this often while it is open. Longer than the
 * swap's 30 s: five coins a round against Jupiter's rate limit (see QUOTE_GAP_MS). What is
 * sent is quoted again at the press and held to these figures.
 */
const REQUOTE_MS = 60_000;
/** While a price is missing, it is asked for again this soon. */
const RETRY_MS = 15_000;
/**
 * While SOL's price is missing, it is asked for again this soon: without it the order
 * cannot be sized at all. It is one call the relay shares between visitors (PRICE_IDS).
 */
const PRICE_RETRY_MS = 4_000;
/**
 * Between one coin's Jupiter quote and the next. Jupiter's free key allows the whole site
 * one request a second, every visitor and every call alike (developers.jup.ag rate limits,
 * 2026-10-23), and refuses a burst: the five quotes cannot all be asked at once. The
 * figures do not wait for them (PRICE_IDS).
 */
const QUOTE_GAP_MS = 1_100;
/**
 * SOL's and every island coin's USD price, in one read the relay shares between visitors
 * for 30 s (`shared`, api/aggregator.js). Read as soon as the order's stub is on screen,
 * so the order opens sized, with every coin's figure at its market price; each quote
 * replaces its coin's figure as it lands, and Buy waits for every quote.
 */
const PRICE_IDS = [SOL_MINT, ...SOL_BASKET.map((c) => c.mint)];
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
/** A coin's build, asked again while Jupiter refuses the call (jupiterBusy.ts). */
const pressBuild = whileJupiterBusy((p: Parameters<typeof buildSwapTransaction>[0]) => buildSwapTransaction(p));
/** How long a sent coin is watched before the order says it cannot tell (the swap's own wait). */
const CONFIRM_TIMEOUT_MS = 90_000;
/** About what opening one coin's account costs (rent, refunded if it is closed), plus its fees. */
const PER_COIN_RESERVE_LAMPORTS = 3_000_000n;

type Leg = { coin: SolBasketCoin; amountIn: bigint };
/** One coin's reads: Jupiter's quote (null with `why` for no route, null alone for a read that failed) and our pools' (null for a read that did not answer). */
type LegQuote = { jupiter: JupiterQuote | null; own: VenuePoolCandidate[] | null; why: string | null };
/** The same while the reads are on their way: a field still `undefined` has not answered. */
type LegRead = Partial<LegQuote>;
/** Every read of the coin has answered, or given up: what a press holds its price to. */
const settled = (q: LegRead): q is LegQuote => q.jupiter !== undefined && q.own !== undefined;
type LegState =
  | { kind: 'busy'; text: string }
  | { kind: 'bought'; via: Via }
  | { kind: 'not-sent'; why: string }
  | { kind: 'refused' }
  | { kind: 'unknown' };
/** Where a coin was bought: our own pool, or its pool through Jupiter. */
type Via = 'own' | 'jupiter';
/** Our pools' swap code and its gate, open on the program the page reads pools from (useVenueSwap). */
type OwnSwap = { api: VenueSwapApi; gate: SwapOpenGate };
/** One coin built and test-run, ready for the wallet. `words`: what it is quoted to buy. */
type Built = { i: number; leg: Leg; words: string } & ({ via: 'jupiter'; tx: VersionedTransaction } | { via: 'own'; prepared: PreparedTx });
/** What one coin's send came to: bought, done without buying, or a stop for the coins after it. */
type Sent = 'bought' | 'next' | 'stop';

const sol = (lamports: bigint) => Number(fromBaseUnits(lamports.toString(), 9));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A coin a press may (re)buy: never one bought, or one we cannot tell about. */
const buyable = (s: LegState | undefined): boolean => !s || s.kind === 'not-sent' || s.kind === 'refused';

/**
 * Where a coin goes on the quotes shown, and what it is quoted to pay there. Null until
 * Jupiter has answered. A Jupiter price that could not be read is `unread`: never a route
 * for our pool by default. Our pools still on their way, or unread, are no pool for now:
 * the row says which, and the order waits for the read before anything is bought.
 */
function shownRoute(q: LegRead | undefined): { decision: 'own' | 'jupiter' | 'none' | 'unread'; out: bigint | null } | null {
  if (!q || q.jupiter === undefined) return null;
  if (!q.jupiter && !q.why) return { decision: 'unread', out: null };
  let jup: bigint | null;
  try { jup = q.jupiter ? BigInt(q.jupiter.outAmount) : null; } catch { jup = null; }
  const decision = solLegRoute(jup, q.own ?? []);
  return { decision, out: decision === 'own' ? (q.own?.[0]?.outAmount ?? null) : jup };
}

/**
 * The island order on Solana. Buy buys every coin, here: each is its own transaction,
 * through Jupiter or, where it pays at least as much, our own pool, built and test-run
 * first. A wallet that signs several transactions at once is asked once for the whole
 * order; any other wallet once per coin, just after that coin is built. The page's pending
 * notes hold this order exactly as they hold Buy: a sent swap the chain has not answered
 * for keeps the wallet from being asked again.
 */
export function IslandBasketSolana(p: {
  slippageBps: number;
  priority: PriorityLevel;
  pending: Pick<PendingTradesState, 'hold' | 'release' | 'holdsNow' | 'sent' | 'record'>;
  /** Our pools' swap, once its code is loaded and its gate open; null until then, or while it cannot be used here. */
  ownSwap: OwnSwap | null;
  /** The order is open: load our pools' swap, so a coin our pool wins is bought there. */
  wantOwnSwap?: () => void;
  /** The swap form has a trade on its way, or a sent one holds this wallet. */
  busy: boolean;
  /** Tests pass 0; QUOTE_GAP_MS otherwise. */
  quoteGapMs?: number;
}) {
  const gap = p.quoteGapMs ?? QUOTE_GAP_MS;
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction, signAllTransactions } = useWallet();
  const [open, setOpen] = useState(false);
  const [usd, setUsd] = useState('10');
  // USD prices by mint (PRICE_IDS), the last read that answered.
  const [prices, setPrices] = useState<Record<string, number> | null>(null);
  const solUsd = prices?.[SOL_MINT] ?? null;
  const [lamports, setLamports] = useState<bigint | null>(null);
  const [quotes, setQuotes] = useState<{ key: string; legs: LegRead[] } | null>(null);
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

  // The prices (PRICE_IDS): once as soon as the stub is on screen, then each REQUOTE_MS
  // while the order is open. A read younger than that is not made again on opening: a new
  // SOL price re-sizes the split, and a new split starts its quotes over.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pricesAt = useRef(0);
  const pricesBusy = useRef(false);
  const readPrices = useCallback(() => {
    if (pricesBusy.current) return;
    pricesBusy.current = true;
    void getUsdPrices(PRICE_IDS, undefined, { shared: true })
      .then((pr) => { if (alive.current) { pricesAt.current = Date.now(); setPrices(pr); } })
      .catch(() => { /* the last prices stand */ })
      .finally(() => { pricesBusy.current = false; });
  }, []);
  useEffect(() => { readPrices(); }, [readPrices]);
  // Without SOL's price nothing can be sized: it is asked again within seconds, not a round.
  const solMissing = solUsd === null;
  useEffect(() => {
    if (!open) return;
    if (solMissing || Date.now() - pricesAt.current >= REQUOTE_MS) readPrices();
    const iv = running ? null : setInterval(readPrices, solMissing ? PRICE_RETRY_MS : REQUOTE_MS);
    return () => { if (iv) clearInterval(iv); };
  }, [open, running, tick, readPrices, solMissing]);

  // Our pools' swap is loaded once the order is opened, and read at the press as it is then.
  const { wantOwnSwap } = p;
  useEffect(() => { if (open) wantOwnSwap?.(); }, [open, wantOwnSwap]);
  const ownAt = useRef(p.ownSwap);
  useEffect(() => { ownAt.current = p.ownSwap; }, [p.ownSwap]);

  // This wallet's SOL while the order is open.
  useEffect(() => {
    if (!open || !publicKey) return;
    let cancelled = false;
    const read = () => { void connection.getBalance(publicKey, 'confirmed').then((b) => { if (!cancelled) setLamports(BigInt(b)); }).catch(() => { if (!cancelled) setLamports(null); }); };
    read();
    const iv = running ? null : setInterval(read, REQUOTE_MS);
    return () => { cancelled = true; if (iv) clearInterval(iv); };
  }, [open, running, publicKey, connection, tick]);

  // Our pools for every coin at once (they are not Jupiter's) and Jupiter one coin at a
  // time, started together, each answer handed over as it lands: the first coin's figure
  // waits for no other read, and a read of our pools that stalls (up to OWN_READ_MS) holds
  // only its own coin's comparison. Before 2026-10-22 the Jupiter quotes waited for every
  // pool read and the figures were shown together, after the last of them.
  const quoteAll = useCallback((ls: Leg[], live: () => boolean, landed: (i: number, read: LegRead) => void): Promise<void> => {
    const own = ls.map((l, i) => within(readOwnPoolsFor(SOL_MINT, l.coin.mint, l.amountIn), OWN_READ_MS, null).then((o) => { if (live()) landed(i, { own: o }); }));
    const jupiter = (async () => {
      for (let i = 0; i < ls.length; i++) {
        if (!live()) return;
        if (i > 0 && gap > 0) await wait(gap);
        const l = ls[i]!;
        let read: LegRead;
        try {
          read = { jupiter: await pinnedGetQuote(quoteJupiter, l.coin)({ inputMint: SOL_MINT, outputMint: l.coin.mint, amount: l.amountIn.toString(), slippageBps: p.slippageBps }), why: null };
        } catch (e) {
          read = { jupiter: null, why: e instanceof PoolNotNamedError ? BASKET_COPY.poolNotNamed : e instanceof NoRouteError ? BASKET_COPY.noRoute : null };
        }
        if (live()) landed(i, read);
      }
    })();
    return Promise.all([...own, jupiter]).then(() => undefined);
  }, [p.slippageBps, gap]);

  const latest = useRef(0);
  // The order last asked for: an amount being typed waits half a second before its quotes
  // are asked; an order opened, or asked again, is asked at once.
  const askedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!open || running || !legs || !orderKey) return;
    const id = ++latest.current;
    const key = orderKey;
    const delay = askedKey.current !== null && askedKey.current !== key ? 500 : 0;
    askedKey.current = key;
    const t = setTimeout(() => {
      setQuoting(true);
      // The same order asked again keeps its figures on screen while they are re-read; another order starts blank.
      setQuotes((was) => (was && was.key === key ? was : { key, legs: legs.map(() => ({})) }));
      const landed = (i: number, read: LegRead) => setQuotes((was) => (was && was.key === key ? { key, legs: was.legs.map((q, j) => (j === i ? { ...q, ...read } : q)) } : was));
      void quoteAll(legs, () => latest.current === id, landed).then(() => { if (latest.current === id) setQuoting(false); });
    }, delay);
    return () => clearTimeout(t);
  }, [open, running, legs, orderKey, quoteAll, tick]);

  const shown = quotes && quotes.key === orderKey ? quotes.legs : null;
  // Every coin's reads have answered: the figures a press holds each price to.
  const ready = shown && shown.every(settled) ? shown : null;
  const setLeg = (i: number, s: LegState) => setStates((was) => ({ ...was, [i]: s }));
  // Asked again every REQUOTE_MS while idle, and every RETRY_MS while a price is missing: one
  // unread coin holds the whole order, so it is not left waiting a full round.
  const anyUnread = shown?.some((q) => shownRoute(q)?.decision === 'unread') ?? false;
  useEffect(() => {
    if (!open || running) return;
    const iv = setInterval(() => setTick((x) => x + 1), anyUnread ? RETRY_MS : REQUOTE_MS);
    return () => clearInterval(iv);
  }, [open, running, anyUnread]);

  // Not one prompt per coin: one for the whole order, when the wallet can sign several at once.
  const oneApproval = signAllTransactions !== undefined;

  /**
   * One coin, checked and built the way the swap builds a trade: quoted again, held to the
   * figure shown, compared with our pools, test-run. Null, with the row saying why, when
   * nothing is to be sent for it. `own`: our pools' swap, null when it cannot be used here,
   * and then our pools take nothing (as on the swap: the trade goes through Jupiter).
   */
  async function buildLeg(i: number, leg: Leg, q: LegQuote, owner: PublicKey, own: OwnSwap | null): Promise<Built | null> {
    setLeg(i, { kind: 'busy', text: 'Checking…' });
    const user = owner.toBase58();
    const ownPools = () => (own ? within(readOwnPoolsFor(SOL_MINT, leg.coin.mint, leg.amountIn), OWN_CHECK_MS, null) : Promise.resolve([]));
    const words = (out: bigint | string) => `≈${shortAmount(Number(fromBaseUnits(out.toString(), leg.coin.decimals)))} ${leg.coin.symbol}`;
    let route: PreparedSolLeg;
    if (!q.jupiter) {
      // Jupiter had no price through its pool: our pool takes it if one quotes now, otherwise nothing is sent.
      const chosen = freshDecision((await ownPools()) ?? (own ? (q.own ?? []) : []), null).chosen;
      if (chosen?.venue !== 'own-pool' || !chosen.poolAddress) {
        setLeg(i, { kind: 'not-sent', why: q.why ?? 'It had no price when the order was shown.' });
        return null;
      }
      route = { kind: 'own', pool: chosen.poolAddress, aggregator: q.why === BASKET_COPY.noRoute ? { kind: 'no-route' } : { kind: 'unreachable' } };
    } else {
      route = await prepareSolLeg(
        {
          getQuote: pinnedGetQuote(quoteForPress, leg.coin),
          buildSwapTransaction: pressBuild,
          simulateSwap: (b64) => simulateSwap(b64),
          swapCarriesPlatformFee,
          ownPools,
        },
        { coin: leg.coin, inputMint: SOL_MINT, amountIn: leg.amountIn, shown: q.jupiter, shownOwn: own ? q.own : [], slippageBps: p.slippageBps, user, priority: p.priority },
      );
    }
    if (route.kind === 'not-sent') {
      setLeg(i, { kind: 'not-sent', why: route.why });
      return null;
    }
    if (route.kind === 'ready') {
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(route.swapTransaction), (c) => c.charCodeAt(0)));
      return { i, leg, via: 'jupiter', tx, words: words(route.quote.outAmount) };
    }
    // Our pool takes it: its swap is built from a fresh read of that pool, and is not built
    // when the pool now pays less than Jupiter was just seen to.
    let built: Awaited<ReturnType<OwnSwap['api']['prepareVenueSwap']>>;
    try {
      if (!own) throw new Error('our pools cannot be used here');
      built = await own.api.prepareVenueSwap(connection, own.gate, {
        owner,
        pool: new PublicKey(route.pool),
        inputMint: new PublicKey(SOL_MINT),
        outputMint: new PublicKey(leg.coin.mint),
        amountIn: leg.amountIn,
        slippageBps: BigInt(p.slippageBps),
        aggregator: route.aggregator,
      });
    } catch {
      setLeg(i, { kind: 'not-sent', why: 'Our pool’s swap for it could not be built just now, so nothing was sent for it.' });
      return null;
    }
    if (!built.ok) {
      setLeg(i, { kind: 'not-sent', why: built.outcome.message });
      return null;
    }
    const s = built.prepared.summary;
    return { i, leg, via: 'own', prepared: built.prepared, words: s.kind === 'venue-swap' ? words(s.quoted.outAmount) : leg.coin.symbol };
  }

  /** A coin the chain confirmed: kept in "Your recent activity" and on the heat strip, as the swap keeps one. */
  function boughtIt(b: Built, sig: string, user: string) {
    setLeg(b.i, { kind: 'bought', via: b.via });
    recordActivity(user, { sig, ts: Date.now(), kind: 'swap', summary: `Bought ${b.words}${b.via === 'own' ? ', in our own pool' : ''} (island order)` });
    const room = bungalowByAddress('solana', b.leg.coin.mint);
    if (room) setLastBuy({ hash: sig, symbol: room.symbol, tokenAddress: b.leg.coin.mint, chain: room.chain, buyer: user, atUnix: Math.floor(Date.now() / 1000) });
  }

  /** Sent, and the chain did not answer while the order watched: its note holds the wallet. */
  function notConfirmed(b: Built, sig: string, user: string) {
    setLeg(b.i, { kind: 'unknown' });
    surfaceUnconfirmedTx(toast, { hash: sig, explorerUrl: `https://solscan.io/tx/${sig}`, repeatCost: `buying again buys ${b.leg.coin.symbol} a second time.` });
    recordActivity(user, { sig, ts: Date.now(), kind: 'swap', summary: `Sent, not confirmed: ${b.words} (island order)` });
  }

  /**
   * The note that holds Buy for this wallet until the chain answers for a Jupiter coin: the
   * swap's own. Its reads start now, before the wallet is asked; the returned function
   * writes it once there is a signature (null: the wallet's answer went missing).
   */
  function jupiterNote(tx: VersionedTransaction, scope: string) {
    const lastValid: { at: number | null } = { at: null };
    const heightRead = jupiterLastValidAtMost(() => connection.getBlockHeight('confirmed')).then((h) => (lastValid.at = h));
    const proof: { bh: NoteBlockhash | null } = { bh: null };
    const bhRead = blockhashSeen(connection, recentBlockhashOf(tx)).then((b) => (proof.bh = b));
    return (signature: string | null) => {
      const sentAt = Date.now();
      const write = () => p.pending.hold({ kind: 'jupiter-swap', signature, lastValidBlockHeight: signature ? lastValid.at : null, blockhash: proof.bh, sentAt }, scope);
      write();
      const had = { at: lastValid.at, bh: proof.bh };
      void Promise.all([heightRead, bhRead]).then(() => {
        if ((signature !== null && had.at === null && lastValid.at !== null) || (had.bh === null && proof.bh !== null)) write();
      });
    };
  }

  /** A watched coin's ending, said on its row. A sent coin the chain did not answer for stops the coins after it. */
  function settleJupiter(b: Built, sig: string, outcome: 'confirmed' | 'reverted' | 'unknown', user: string, scope: string): Sent {
    if (outcome !== 'unknown') p.pending.release(sig, scope);
    if (outcome === 'reverted') {
      setLeg(b.i, { kind: 'refused' });
      return 'next';
    }
    if (outcome === 'unknown') {
      notConfirmed(b, sig, user);
      return 'stop';
    }
    boughtIt(b, sig, user);
    return 'bought';
  }

  /**
   * One coin in our own pool, through the write layer's own send (submit.ts): the wallet
   * signs (`signer`), what it signed is checked against what was built, our RPC sends and
   * watches it. Its note is the swap's own (`sent`, then `record`).
   */
  async function sendOwn(b: Built & { via: 'own' }, signer: TxSigner, own: OwnSwap, user: string): Promise<Sent> {
    let sig: string | null = null;
    const outcome = await own.api.submitPrepared(connection, signer, b.prepared, {
      onSent: (s) => { sig = s; p.pending.sent(s, b.prepared); },
      timeoutMs: CONFIRM_TIMEOUT_MS,
    });
    p.pending.record(outcome, b.prepared, sig);
    switch (outcome.status) {
      case 'confirmed':
        boughtIt(b, outcome.signature, user);
        return 'bought';
      case 'reverted':
        setLeg(b.i, { kind: 'refused' });
        return 'next';
      case 'unknown':
        notConfirmed(b, outcome.signature, user);
        return 'stop';
      case 'expired':
        setLeg(b.i, { kind: 'not-sent', why: outcome.message });
        return 'next';
      default:
        setLeg(b.i, { kind: 'not-sent', why: outcome.message });
        // A cancel, or a wallet that did not sign, stops the order; a refusal at the first send does not.
        return outcome.stage === 'sign' ? 'stop' : 'next';
    }
  }

  /** One coin through Jupiter, its own wallet prompt: the wallet signs and sends it. */
  async function sendJupiterAlone(b: Built & { via: 'jupiter' }, user: string, scope: string): Promise<Sent> {
    const note = jupiterNote(b.tx, scope);
    let sig: string;
    try {
      sig = await sendTransaction(b.tx, connection);
    } catch (e) {
      const t = readSendThrow(e);
      if (t.kind === 'unsure') {
        note(null);
        setLeg(b.i, { kind: 'unknown' });
        toast.warning(LOST_ANSWER_TITLE, { description: lostAnswerCopy(t.reason, `it sent ${b.words} for ${sol(b.leg.amountIn).toFixed(4)} SOL`) });
      } else {
        setLeg(b.i, { kind: 'not-sent', why: t.message });
      }
      // A cancel, a wallet that did not sign, or an answer that went missing stops the order.
      return 'stop';
    }
    note(sig);
    setLeg(b.i, { kind: 'busy', text: 'Confirming…' });
    const { outcome } = await pollConfirm(connection, sig, CONFIRM_TIMEOUT_MS);
    return settleJupiter(b, sig, outcome, user, scope);
  }

  /**
   * Every built coin, one wallet prompt. All on one fresh blockhash first, so none runs
   * out while the wallet is open; nothing is awaited between the last read of this wallet's
   * notes and the prompt. Once signed, each is sent and watched on its own: a coin already
   * bought stays bought whatever another one does.
   */
  async function signAndSendAll(batch: Built[], signAll: NonNullable<typeof signAllTransactions>, owner: PublicKey, own: OwnSwap | null, scope: string): Promise<number> {
    const user = owner.toBase58();
    const txOf = (b: Built): Transaction | VersionedTransaction => (b.via === 'jupiter' ? b.tx : b.prepared.tx);
    const fresh = await connection.getLatestBlockhash('confirmed').catch(() => null);
    if (fresh) {
      stampBlockhash(batch.map(txOf), fresh.blockhash);
      for (const b of batch) if (b.via === 'own') b.prepared = { ...b.prepared, blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight };
    }
    const notes = new Map(batch.flatMap((b) => (b.via === 'jupiter' ? [[b.i, jupiterNote(b.tx, scope)] as const] : [])));
    if (p.pending.holdsNow(scope)) {
      for (const b of batch) setLeg(b.i, { kind: 'not-sent', why: HELD_NOT_SENT });
      setNotice({ tone: 'warn', text: HELD_NOT_SENT });
      return 0;
    }
    for (const b of batch) setLeg(b.i, { kind: 'busy', text: 'At your wallet…' });
    setNotice({ tone: 'busy', text: batch.length > 1 ? `One approval in your wallet buys all ${batch.length}.` : 'Approve it in your wallet.' });
    let signed: (Transaction | VersionedTransaction)[];
    try {
      signed = await signAll(batch.map(txOf));
    } catch (e) {
      // Signing alone: whatever the wallet says, nothing left the page.
      const why = signThrowCopy(e);
      for (const b of batch) setLeg(b.i, { kind: 'not-sent', why });
      setNotice(null);
      return 0;
    }
    setNotice(null);
    // Settled one by one: a coin whose bookkeeping throws takes no other coin's answer with it.
    const results = await Promise.allSettled(
      batch.map(async (b, k): Promise<Sent> => {
        const got = signed[k];
        if (b.via === 'own') {
          if (!own || !got) {
            setLeg(b.i, { kind: 'not-sent', why: 'Your wallet did not sign it, so nothing was sent for it.' });
            return 'next';
          }
          // The write layer's send, handed what the wallet already signed: every check it makes still runs.
          return sendOwn(b, { publicKey: owner, signTransaction: async <T extends Transaction>() => got as T }, own, user);
        }
        let tx: VersionedTransaction;
        let sig: string | null;
        try {
          // Read back from its bytes: a wallet bundling its own web3.js returns a lookalike class.
          tx = VersionedTransaction.deserialize(got!.serialize());
          sig = signatureOf(tx);
          if (!tx.message.staticAccountKeys[0]?.equals(owner)) sig = null;
        } catch {
          sig = null;
          tx = b.tx;
        }
        if (!sig) {
          setLeg(b.i, { kind: 'not-sent', why: 'Your wallet did not sign it, so nothing was sent for it.' });
          return 'next';
        }
        // The note exists before the first byte leaves: from here it may land even if the page goes.
        notes.get(b.i)?.(sig);
        setLeg(b.i, { kind: 'busy', text: 'Confirming…' });
        const r = await sendSigned(connection, tx.serialize(), sig, CONFIRM_TIMEOUT_MS);
        if (r.kind === 'not-sent') {
          p.pending.release(sig, scope);
          setLeg(b.i, { kind: 'not-sent', why: r.why });
          return 'next';
        }
        return settleJupiter(b, sig, r.outcome, user, scope);
      }),
    );
    return results.filter((r) => r.status === 'fulfilled' && r.value === 'bought').length;
  }

  async function buy() {
    if (!publicKey || !legs || !shares || !ready || running) return;
    const owner = publicKey;
    const user = owner.toBase58();
    const scope = swapPendingScope(user);
    const before = states;
    const own = ownAt.current;
    const signAll = signAllTransactions ?? null;
    setRunning(true);
    setNotice(null);
    setFrozen({ usd, shares });
    stopAfter.current = false;
    let bought = 0;
    try {
      // With one approval, every coin is built first and signed together; otherwise each
      // is sent as soon as it is built, so no blockhash waits on the others.
      const batch: Built[] = [];
      for (let i = 0; i < legs.length; i++) {
        if (!buyable(before[i])) continue;
        if (stopAfter.current) break;
        const b = await buildLeg(i, legs[i]!, ready[i]!, owner, own);
        if (!b) continue;
        if (signAll) {
          batch.push(b);
          setLeg(i, { kind: 'busy', text: 'Ready' });
          continue;
        }
        // A swap this wallet sent, in any tab, that the chain has not answered for holds the
        // rest. From this read to the wallet's prompt nothing is awaited.
        if (p.pending.holdsNow(scope)) {
          setLeg(i, { kind: 'not-sent', why: HELD_NOT_SENT });
          setNotice({ tone: 'warn', text: HELD_NOT_SENT });
          break;
        }
        setLeg(i, { kind: 'busy', text: 'At your wallet…' });
        let r: Sent;
        if (b.via === 'jupiter') r = await sendJupiterAlone(b, user, scope);
        else if (own && signTransaction) r = await sendOwn(b, { publicKey: owner, signTransaction }, own, user);
        else {
          setLeg(i, { kind: 'not-sent', why: 'This wallet cannot sign a transaction for this page to send, so nothing was sent for it.' });
          r = 'next';
        }
        if (r === 'bought') bought++;
        if (r === 'stop') break;
      }
      if (signAll && batch.length > 0) bought += await signAndSendAll(batch, signAll, owner, own, scope);
    } finally {
      setRunning(false);
      if (bought > 0) toast.success(`Bought ${bought} of ${legs.length} island coins`);
      setTick((x) => x + 1);
    }
  }

  // Until a coin's quote lands, its figure is its dollars at its market price, less the
  // site fee where one is taken: a figure to look at, never one a press is held to.
  const feeShare = isSolanaFeeConfigured() ? SOLANA_PLATFORM_FEE_BPS / 10_000 : 0;
  const usdEach = orderKey && Number.isFinite(dollars) && dollars > 0 ? dollars / n : 0;
  const rows: BasketRow[] = SOL_BASKET.map((coin, i) => {
    const q = shown?.[i];
    const r = shownRoute(q);
    const s = states[i];
    const coinUsd = prices?.[coin.mint];
    const estimate = !r && usdEach > 0 && typeof coinUsd === 'number' && Number.isFinite(coinUsd) && coinUsd > 0 ? (usdEach / coinUsd) * (1 - feeShare) : null;
    const viaJupiter = `${coin.pool.dex === 'pumpswap' ? 'PumpSwap' : 'Raydium'} via Jupiter`;
    // A bought coin names where it was bought, whatever the quotes on screen say by then.
    const venue = s?.kind === 'bought' ? (s.via === 'own' ? 'Our pool' : viaJupiter)
      : !r ? (estimate !== null ? 'market price' : null) : r.decision === 'own' ? 'Our pool' : r.decision === 'jupiter' ? viaJupiter : r.decision === 'unread' ? 'Price not read' : 'No route';
    const status: BasketRow['status'] =
      !s ? (q?.own === null ? { tone: 'muted', text: 'Our pools not read' } : r && q && q.own === undefined ? { tone: 'busy', text: 'Comparing our pool…' } : undefined)
      : s.kind === 'busy' ? { tone: 'busy', text: s.text }
      : s.kind === 'bought' ? { tone: 'ok', text: 'Bought' }
      : s.kind === 'refused' ? { tone: 'err', text: 'Refused on chain' }
      : s.kind === 'unknown' ? { tone: 'warn', text: 'Sent, not confirmed' }
      : { tone: 'err', text: s.why };
    return {
      key: coin.room,
      room: coin.room,
      symbol: coin.symbol,
      venue,
      // A coin not yet quoted shows its market-price figure, or nothing while there is an order to quote it for.
      pays: r?.out != null ? `≈ ${shortAmount(Number(fromBaseUnits(r.out.toString(), coin.decimals)))}` : estimate !== null ? `≈ ${shortAmount(estimate)}` : r || !orderKey ? '–' : null,
      estimate: estimate !== null,
      status,
    };
  });

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
  else if (!ready || quoting) [label, disabled] = ['Getting prices…', true];
  else if (left === 0) [label, disabled] = ['Nothing left to buy', true];
  else if (unread) [label, disabled] = ['A price could not be read', true];

  const shownNotice = notice
    ?? (solUsd === null && !frozen && dollars > 0 && !tooSmall && open ? { tone: 'warn' as const, text: 'SOL’s price could not be read yet, so the order cannot be sized. It is asked again every few seconds.', action: { label: 'Try again', onClick: () => setTick((x) => x + 1) } } : null)
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
          // With one approval every coin is already signed: there is no coin to stop after.
          running && !oneApproval ? (
            <button type="button" onClick={() => { stopAfter.current = true; }} className="text-white/70 text-[11px] underline underline-offset-2 min-h-[36px]">
              Stop after this coin
            </button>
          ) : null
        }
        finePrint={
          <>
            <p>Each coin is bought through one pool, read on chain: PumpSwap for BAYLA, BOBO, SOY and BRAINLET, Raydium for RIZZ, or our own pool for that coin when it pays at least as much (the swap’s rule). Jupiter is asked for the coin’s pool only, and an answer through any other pool is refused. Old launch pools that migrated are never touched.</p>
            <p>Each coin is its own transaction, built and test-run before your wallet is asked. Most wallets are asked once for the whole order; a wallet that cannot sign several at once is asked once per coin. A coin already bought stays bought if another one does not go through. If one is sent but not confirmed, Buy waits, so nothing is bought twice.</p>
            <p>Slippage is your swap setting ({(p.slippageBps / 100).toFixed(2)}%). The amount is split at SOL’s price from Jupiter. At least {usdText(MIN_USD_PER_COIN)} a coin. A coin you do not hold yet opens an account for about 0.002 SOL, which you get back if you close it.</p>
          </>
        }
      />
    </>
  );
}
