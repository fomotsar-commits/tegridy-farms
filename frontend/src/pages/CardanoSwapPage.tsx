import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { FinePrint } from '../components/ui/FinePrint';
import { CopyButton } from '../components/ui/CopyButton';
import { ChainSwitch } from '../components/swap/ChainSwitch';
import { CardanoWalletModal } from '../components/cardano/CardanoWalletModal';
import { loadCsl, type Csl } from '../lib/cardano/csl';
import { ADA, feePercentText, isAda, type CardanoAsset } from '../lib/cardano/minswapV2';
import { readFingerprint, readPolicyCoins, readTokenInfo, type PolicyCoin, type Read, type TokenInfo } from '../lib/cardano/chain';
import { isPoolShare, namesCoin, parseCoinInput, type CoinInput } from '../lib/cardano/coinInput';
import { prepareSwap, quoteNow, signAndSend, type Prepared } from '../lib/cardano/swapFlow';
import type { SwapQuote } from '../lib/cardano/quote';
import { venueFeeAddress, venueFeeText } from '../lib/cardano/venueFee';
import { cardanoscanToken, cardanoscanTx, formatAda, formatAmount, LOVELACE_DECIMALS, parseAmount } from '../lib/cardano/format';
import { dropOrderNote, markOrderSettled, pollDelayMs, readOrderNotes, readOrderStatus, settledStatus, type CoinLabel, type OrderStatus, type PendingOrder } from '../lib/cardano/orderWatch';
import { restoreCardanoWallet, subscribeCardanoWalletList, takeCardanoWalletListRequest, useCardanoWallet } from '../lib/cardano/walletStore';
import { shortCardanoAddress } from '../lib/cardano/address';

/**
 * The Cardano swap (owner, 2026-10-24: "cardano integrated in every aspect of this app,
 * start with swap"). ADA for a coin, or a coin for ADA, through that pair's Minswap V2 pool,
 * with the venue's own fee line. How it works, and why each check exists: lib/cardano/.
 */

type Side = 'buy' | 'sell';

type QuoteState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'quote'; quote: SwapQuote }
  | { kind: 'no-pool' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unread'; reason: string };

/** The coins of one review, fixed when Review is pressed: the card never borrows the live form's. */
interface ReviewLabels {
  inLabel: CoinLabel;
  outLabel: CoinLabel;
  /** The coin that is not ADA, for its whole id on the card. */
  coin: CardanoAsset;
}

type Flow =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'review'; prepared: Extract<Prepared, { kind: 'review' }>; labels: ReviewLabels }
  | { kind: 'moved'; quote: SwapQuote }
  | { kind: 'stopped'; message: string; problems?: string[] }
  | { kind: 'signing'; labels: ReviewLabels }
  | { kind: 'done'; message: string; tone: 'ok' | 'warn' };

const SLIPPAGES = [50, 100, 300] as const;
/** "Expired" is believed only when this many polls in a row say so (orderWatch.ts EXPIRY_MARGIN_SLOTS). */
const EXPIRED_POLLS = 2;

const CARD = { border: '1px solid rgba(255,255,255,0.12)' } as const;
const FIELD = { background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' } as const;
const PRIMARY = { background: 'var(--color-stan)', border: '1px solid var(--color-stan)' } as const;
const NETWORK_FEE_NOTE = 'set by the transaction’s size; goes to Cardano’s fee pot, paid out to stake pools, stakers and the treasury';

const ADA_LABEL: CoinLabel = { ticker: 'ADA', decimals: LOVELACE_DECIMALS };

/** What a pasted policy id or asset1… id was looked up as. */
type CoinLookup = { kind: 'policy'; coins: PolicyCoin[]; cut: boolean } | { kind: 'fingerprint'; coin: { policyId: string; assetName: string } | null };

/** The most coins one policy's pick-list shows (chain.ts POLICY_READ_ROWS is one more). */
const PICK_LIST_MAX = 50;

/**
 * The coin the box names, once known: the whole id as pasted, a fingerprint's coin, or the coin
 * under a policy id (the one its name in letters names; else the only one, or the one picked).
 */
function resolvedCoin(input: CoinInput | null, lookup: Read<CoinLookup> | null, pickedName: string | null): { policyId: string; assetName: string } | null {
  if (input?.kind === 'coin') return input;
  if (!lookup || lookup.status !== 'ok') return null;
  const found = lookup.data;
  if (input?.kind === 'fingerprint' && found.kind === 'fingerprint') return found.coin && !isPoolShare(found.coin.policyId) ? found.coin : null;
  if (input?.kind === 'policy' && found.kind === 'policy') {
    const { name } = input;
    // A name given is the coin it names, or none: never another coin under the same policy.
    // Without one, the only coin under the policy, when the list is whole, is the coin.
    const auto = name !== undefined ? found.coins.find((c) => namesCoin(c.assetName, name)) : !found.cut && found.coins.length === 1 ? found.coins[0] : undefined;
    // A pick made under this very text outranks the name the text gave: the visitor chose.
    const assetName = pickedName ?? auto?.assetName ?? null;
    return assetName !== null ? { policyId: input.policyId, assetName } : null;
  }
  return null;
}

function coinName(info: TokenInfo | null): string {
  return info?.ticker ?? info?.name ?? 'This coin';
}

function amountText(n: bigint, label: CoinLabel): string {
  return label.ticker === 'ADA' ? formatAda(n) : `${formatAmount(n, label.decimals)} ${label.ticker ?? 'units'}`;
}

/** Whether a venue fee address is registered: the explainer only speaks of a fee that is charged. */
const VENUE_FEE_ON = venueFeeAddress() !== null;

function Line({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[12px]">
      <span className="text-white/65">{label}</span>
      <span className="text-right text-white">
        {value}
        {note && <span className="block text-[11px] text-white/55">{note}</span>}
      </span>
    </div>
  );
}

function statusText(s: OrderStatus | undefined, order: PendingOrder, expiredPolls: number): { text: string; final: boolean } {
  if (!s) return { text: 'Reading…', final: false };
  switch (s.kind) {
    case 'not-seen':
      return { text: order.submitted ? 'Sent. The chain has not shown it yet.' : 'Not seen on the chain yet; it may not have been sent.', final: false };
    case 'expired':
      return expiredPolls >= EXPIRED_POLLS
        ? { text: 'Never placed: it is well past its expiry, so it can no longer land. Nothing left your wallet. Safe to try again.', final: true }
        : { text: 'Not seen on the chain, and past its expiry. Checking once more before calling it.', final: false };
    case 'placed':
      return { text: `Order placed${s.depth > 0 ? ` (${s.depth} block${s.depth === 1 ? '' : 's'} deep)` : ''}. Waiting for Minswap’s batcher to fill it.`, final: false };
    case 'filled':
      return {
        text: isAda(order.assetOut)
          ? `Filled: ${formatAda(s.received)} came back, with your 2 ADA deposit.`
          : `Filled: ${amountText(s.received, order.outLabel)}, with ${formatAda(s.depositBack)} back.`,
        final: true,
      };
    case 'returned':
      // The same status covers a batcher's return (it keeps its fee) and the trader's own cancel (no batcher fee).
      return { text: 'Returned: your coins came back. If Minswap’s batcher returned it (the price moved past your minimum), it kept its fee of up to 2 ADA.', final: true };
    case 'spent':
      return { text: 'The order was spent, and this page could not tell how. Your wallet shows what arrived.', final: true };
    case 'unknown':
      return { text: `Could not read the chain just now (${s.reason}). The order may well have filled; this page keeps checking.`, final: false };
  }
}

function CardanoSwapInner({ csl, cslError, retryCsl }: { csl: Csl | null; cslError: string | null; retryCsl: () => void }) {
  const wallet = useCardanoWallet();
  // The top bar's Connect opens this page's list; a press made before the page loaded waits for it.
  const [walletOpen, setWalletOpen] = useState(() => takeCardanoWalletListRequest());
  const [side, setSide] = useState<Side>('buy');
  const [tokenText, setTokenText] = useState('');
  const input = useMemo(() => parseCoinInput(tokenText), [tokenText]);
  // A policy id alone, or an asset1… id, is looked up first; the answer is kept with what it answered.
  const lookupKey = input?.kind === 'policy' ? `policy:${input.policyId}` : input?.kind === 'fingerprint' ? `fp:${input.fingerprint}` : null;
  const [lookupRead, setLookupRead] = useState<{ key: string; value: Read<CoinLookup> } | null>(null);
  // A pick holds only for the text it was made under: new text, even under the same policy, picks again.
  const [picked, setPicked] = useState<{ text: string; assetName: string } | null>(null);
  useEffect(() => {
    if (!lookupKey) return;
    const ac = new AbortController();
    // Keyed on lookupKey alone: text that changes nothing it asks (spaces, a name in letters) reads nothing again.
    const id = lookupKey.slice(lookupKey.indexOf(':') + 1);
    const read: Promise<Read<CoinLookup>> = lookupKey.startsWith('policy:')
      ? readPolicyCoins(id, ac.signal).then((r) => (r.status === 'ok' ? { status: 'ok', data: { kind: 'policy', ...r.data } } : r))
      : readFingerprint(id, ac.signal).then((r) => (r.status === 'ok' ? { status: 'ok', data: { kind: 'fingerprint', coin: r.data } } : r));
    void read.then((value) => {
      if (!ac.signal.aborted) setLookupRead({ key: lookupKey, value });
    });
    return () => ac.abort();
  }, [lookupKey]);
  const lookup = lookupKey && lookupRead?.key === lookupKey ? lookupRead.value : null;
  const policyList = lookup?.status === 'ok' && lookup.data.kind === 'policy' ? lookup.data : null;
  const fingerprintCoin = lookup?.status === 'ok' && lookup.data.kind === 'fingerprint' ? lookup.data.coin : undefined;
  const namesPair = input?.kind === 'pair' || (fingerprintCoin != null && isPoolShare(fingerprintCoin.policyId));
  const resolved = resolvedCoin(input, lookup, picked && picked.text === tokenText ? picked.assetName : null);
  // A name in letters that names none of the policy's coins: the list is shown, and nothing is taken.
  const wantedName = input?.kind === 'policy' ? input.name : undefined;
  const nameMissed = wantedName !== undefined && policyList !== null && !policyList.coins.some((c) => namesCoin(c.assetName, wantedName));
  const showPicks = policyList !== null && policyList.coins.length > 0 && (policyList.cut || policyList.coins.length > 1 || nameMissed);
  const tokenKey = resolved ? resolved.policyId + resolved.assetName : null;
  const token = useMemo(() => (tokenKey ? { policyId: tokenKey.slice(0, 56), assetName: tokenKey.slice(56) } : null), [tokenKey]);
  // Every read is kept with the inputs it answered, and shown only while they are still the
  // form's: an answer for an earlier coin or amount is never on screen for the current one.
  const [infoRead, setInfoRead] = useState<{ key: string; value: Read<TokenInfo | null> } | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [quoteRead, setQuoteRead] = useState<{ key: string; value: QuoteState } | null>(null);
  const [flow, setFlow] = useState<Flow>({ kind: 'form' });
  const [notesVersion, notesChanged] = useReducer((n: number) => n + 1, 0);
  // Orders sent from this page, held here too: a browser that will not keep notes still follows them.
  const [sessionOrders, setSessionOrders] = useState<PendingOrder[]>([]);
  const [statuses, setStatuses] = useState<Record<string, OrderStatus>>({});
  const [expiredPolls, setExpiredPolls] = useState<Record<string, number>>({});

  useEffect(() => {
    void restoreCardanoWallet();
    return subscribeCardanoWalletList(() => {
      if (takeCardanoWalletListRequest()) setWalletOpen(true);
    });
  }, []);

  // The coin's name and decimals, read from the chain and the registry.
  useEffect(() => {
    if (!token || !tokenKey) return;
    const ac = new AbortController();
    void readTokenInfo(token.policyId, token.assetName, ac.signal).then((value) => {
      if (!ac.signal.aborted) setInfoRead({ key: tokenKey, value });
    });
    return () => ac.abort();
  }, [token, tokenKey]);
  const tokenInfo: Read<TokenInfo | null> | 'loading' | null = !tokenKey ? null : infoRead?.key === tokenKey ? infoRead.value : 'loading';

  const info = tokenInfo !== null && tokenInfo !== 'loading' && tokenInfo.status === 'ok' ? tokenInfo.data : null;
  const tokenDecimals = info?.decimals ?? 0;
  const tokenLabelTicker = info?.ticker ?? info?.name ?? null;
  const tokenLabel = useMemo<CoinLabel>(() => ({ ticker: tokenLabelTicker, decimals: tokenDecimals }), [tokenLabelTicker, tokenDecimals]);
  const assetIn: CardanoAsset | null = token ? (side === 'buy' ? ADA : token) : null;
  const inDecimals = side === 'buy' ? LOVELACE_DECIMALS : tokenDecimals;
  const tokenKnown = tokenInfo !== null && tokenInfo !== 'loading' && tokenInfo.status === 'ok' && tokenInfo.data !== null;
  const amountIn = tokenKnown ? parseAmount(amountInput, inDecimals) : null;
  const traderHex = wallet.status === 'connected' ? wallet.address.hex : null;

  // The quote, a moment after the form stops changing.
  const quoteKey = csl && tokenKey && tokenKnown && amountIn !== null && amountIn > 0n ? [tokenKey, side, amountIn.toString(), slippageBps].join('|') : null;
  useEffect(() => {
    if (!csl || !token || !assetIn || !quoteKey || amountIn === null) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      void quoteNow(csl, token, assetIn, amountIn, slippageBps, ac.signal).then((r) => {
        if (ac.signal.aborted) return;
        setQuoteRead({ key: quoteKey, value: r.kind === 'quote' ? { kind: 'quote', quote: r.quote } : r });
      });
    }, 400);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
    // quoteKey carries every input (amountIn is a bigint, so it is keyed as text).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);
  const quote = useMemo<QuoteState>(
    () => (!quoteKey ? { kind: 'idle' } : quoteRead?.key === quoteKey ? quoteRead.value : { kind: 'loading' }),
    [quoteKey, quoteRead],
  );

  // The whole form, and the wallet, as one key: a review built for any other key is dropped.
  const formKey = [tokenKey, side, amountInput, slippageBps, traderHex].join('|');
  const formKeyRef = useRef(formKey);
  useEffect(() => {
    formKeyRef.current = formKey;
  }, [formKey]);

  // This wallet's orders, followed until each one ends.
  const orders = useMemo<PendingOrder[]>(() => {
    if (!traderHex) return [];
    const noted = readOrderNotes().filter((n) => n.traderHex === traderHex);
    const extra = sessionOrders.filter((o) => o.traderHex === traderHex && !noted.some((n) => n.txHash === o.txHash));
    return [...extra, ...noted];
    // notesVersion: a note was cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traderHex, sessionOrders, notesVersion]);
  const finals = useRef(new Set<string>());
  useEffect(() => {
    if (orders.length === 0) return;
    let stopped = false;
    const ac = new AbortController();
    const tick = async () => {
      for (const o of orders) {
        if (finals.current.has(o.txHash)) continue;
        // Ended on an earlier visit: shown as it was saved, never read again.
        const saved = settledStatus(o);
        if (saved) {
          finals.current.add(o.txHash);
          setStatuses((prev) => ({ ...prev, [o.txHash]: saved }));
          continue;
        }
        const s = await readOrderStatus(o, ac.signal);
        if (stopped) return;
        setStatuses((prev) => ({ ...prev, [o.txHash]: s }));
        setExpiredPolls((prev) => {
          const n = s.kind === 'expired' ? (prev[o.txHash] ?? 0) + 1 : 0;
          if (s.kind === 'expired' && n >= EXPIRED_POLLS) finals.current.add(o.txHash);
          return { ...prev, [o.txHash]: n };
        });
        if (s.kind === 'filled' || s.kind === 'returned' || s.kind === 'spent') {
          finals.current.add(o.txHash);
          markOrderSettled(o.txHash, s);
        }
      }
    };
    // The next round starts after this one ENDS: rounds never overlap, so a slow read never has
    // two or three rounds reading the same orders at once (orderWatch.ts pollDelayMs).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      try {
        await tick();
      } catch {
        /* a round that threw is tried again next round, never the end of following */
      }
      if (!stopped) timer = setTimeout(() => void loop(), pollDelayMs(orders, (tx) => finals.current.has(tx), Date.now()));
    };
    void loop();
    return () => {
      stopped = true;
      ac.abort();
      clearTimeout(timer);
    };
  }, [orders]);

  const onReview = useCallback(async () => {
    if (!csl || wallet.status !== 'connected' || !token || !assetIn || amountIn === null || quote.kind !== 'quote') return;
    const pressedFor = formKeyRef.current;
    const labels: ReviewLabels = side === 'buy' ? { inLabel: ADA_LABEL, outLabel: tokenLabel, coin: token } : { inLabel: tokenLabel, outLabel: ADA_LABEL, coin: token };
    setFlow({ kind: 'preparing' });
    const p = await prepareSwap(csl, wallet.api, wallet.address, token, assetIn, amountIn, slippageBps, quote.quote);
    // The form or the wallet changed while this was built: it answers a question no longer asked.
    if (formKeyRef.current !== pressedFor) {
      setFlow({ kind: 'form' });
      return;
    }
    if (p.kind === 'review') {
      if (quoteKey) setQuoteRead({ key: quoteKey, value: { kind: 'quote', quote: p.quote } });
      setFlow({ kind: 'review', prepared: p, labels });
    } else if (p.kind === 'moved') {
      if (quoteKey) setQuoteRead({ key: quoteKey, value: { kind: 'quote', quote: p.quote } });
      setFlow({ kind: 'moved', quote: p.quote });
    } else setFlow({ kind: 'stopped', message: p.message, problems: p.problems });
  }, [csl, wallet, token, assetIn, amountIn, slippageBps, quote, quoteKey, side, tokenLabel]);

  const onSign = useCallback(async () => {
    if (!csl || wallet.status !== 'connected' || flow.kind !== 'review') return;
    const { prepared, labels } = flow;
    setFlow({ kind: 'signing', labels });
    const r = await signAndSend(csl, wallet.api, prepared, { inLabel: labels.inLabel, outLabel: labels.outLabel });
    const notKept = ' This browser will not keep a note of it, so after a reload it is not followed here: find it on Cardanoscan.';
    if (r.kind === 'sent' || r.kind === 'unsure') setSessionOrders((prev) => [r.order, ...prev.filter((o) => o.txHash !== r.order.txHash)]);
    if (r.kind === 'sent') setFlow({ kind: 'done', tone: 'ok', message: `Order sent. Minswap’s batcher fills it a few blocks after it lands; it is followed below.${r.kept ? '' : notKept}` });
    else if (r.kind === 'unsure') setFlow({ kind: 'done', tone: 'warn', message: `${r.message}${r.kept ? '' : notKept}` });
    else if (r.kind === 'declined') setFlow({ kind: 'done', tone: 'warn', message: 'You declined in the wallet. Nothing was sent.' });
    else setFlow({ kind: 'done', tone: 'warn', message: r.message });
  }, [csl, wallet, flow]);

  const outLabel = side === 'buy' ? tokenLabel : ADA_LABEL;
  // While a review is built or signed, the form holds still: what is signed is what was asked.
  const locked = flow.kind === 'preparing' || flow.kind === 'signing';
  const toForm = () => setFlow({ kind: 'form' });

  let cta: { label: string; disabled: boolean; onClick?: () => void };
  if (wallet.status !== 'connected') cta = { label: 'Connect a Cardano wallet', disabled: false, onClick: () => setWalletOpen(true) };
  else if (!csl) cta = { label: cslError ? 'Reload the page to try again' : 'Loading…', disabled: !cslError, onClick: cslError ? retryCsl : undefined };
  else if (!token) cta = { label: lookupKey && lookup === null ? 'Finding the coin…' : showPicks ? 'Pick the coin above' : 'Paste a coin’s address', disabled: true };
  else if (quote.kind === 'loading') cta = { label: 'Getting a price…', disabled: true };
  else if (quote.kind !== 'quote') cta = { label: 'Enter an amount', disabled: true };
  else cta = { label: flow.kind === 'preparing' ? 'Building and checking…' : 'Review swap', disabled: locked, onClick: () => void onReview() };

  return (
    <div className="relative">
      <m.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="rounded-2xl p-5 relative overflow-hidden" style={CARD}>
        <div className="absolute inset-0">
          <ArtImg pageId="cardano-swap" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.87)' }} />
        </div>
        <div className="relative z-10 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="heading-luxury text-[18px] text-white">Cardano Swap</h1>
              <p className="text-white/60 text-[11px]">ADA for a coin, or a coin for ADA, through its Minswap V2 pool.</p>
            </div>
            {wallet.status === 'connected' && (
              <button type="button" onClick={() => setWalletOpen(true)} className="text-white/70 text-[11px] font-mono px-2 min-h-[44px] rounded-md" style={{ background: 'var(--color-purple-15)' }} title={wallet.address.bech32}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mr-1.5 align-middle" />
                {shortCardanoAddress(wallet.address.bech32)}
              </button>
            )}
          </div>

          <div className="flex gap-1" role="group" aria-label="Buy or sell">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={side === s}
                disabled={locked}
                onClick={() => {
                  setSide(s);
                  setAmountInput('');
                  toForm();
                }}
                className="flex-1 min-h-[44px] rounded-lg text-[12px] font-medium text-white disabled:opacity-60"
                style={side === s ? PRIMARY : { background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
              >
                {s === 'buy' ? 'Buy with ADA' : 'Sell for ADA'}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="cardano-coin" className="block text-white text-[11px] mb-1.5">
              The coin’s address
            </label>
            <input
              id="cardano-coin"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the coin’s contract address"
              value={tokenText}
              disabled={locked}
              onChange={(e) => {
                setTokenText(e.target.value);
                toForm();
              }}
              className="w-full rounded-xl p-3 bg-transparent text-white text-[12px] font-mono outline-none disabled:opacity-60"
              style={FIELD}
            />
            {(input?.kind === 'unknown' || namesPair) && (
              <>
                <p className="mt-1 text-[11px] text-danger">
                  {namesPair ? 'That names a trading pair, not a coin. Copy the coin’s own address instead.' : 'That isn’t a Cardano coin’s address.'}
                </p>
                <FinePrint summary="What counts as its address">
                  <p className="text-[11px] text-white/65">
                    A Cardano coin has no contract of its own. Its address is its policy id, usually with its name added: DexScreener shows it that way. The policy id alone works too, and so do an asset1… id and a Cardanoscan, Cexplorer or pool.pm link to the coin.
                  </p>
                </FinePrint>
              </>
            )}
            {lookupKey && lookup === null && <p className="mt-1 text-[11px] text-white/65">Finding the coin…</p>}
            {lookup?.status === 'unread' && <p className="mt-1 text-[11px] text-danger">The coin could not be looked up just now ({lookup.reason}).</p>}
            {fingerprintCoin === null && <p className="mt-1 text-[11px] text-danger">The chain has no record of that asset1… id yet. Check it.</p>}
            {policyList && policyList.coins.length === 0 && (
              <p className="mt-1 text-[11px] text-danger">
                {policyList.cut ? 'No coin among the first things listed under this id. Paste the coin’s whole address.' : 'The chain lists no coin under this id yet (NFTs aren’t listed). Check the id.'}
              </p>
            )}
            {policyList && showPicks && (
              <div className="mt-2 space-y-1.5" role="group" aria-label="Coins under this id" data-testid="cardano-coin-picks">
                <p className="text-[11px] text-white/75 break-all">
                  {wantedName !== undefined && nameMissed
                    ? `Nothing under this id is called “${Array.from(wantedName).slice(0, 32).join('')}”. Pick yours:`
                    : policyList.cut
                      ? 'Many things share this id. Pick your coin:'
                      : 'Several coins share this id. Pick yours:'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {policyList.coins.slice(0, PICK_LIST_MAX).map((c) => (
                    <button
                      key={c.assetName}
                      type="button"
                      aria-pressed={token?.assetName === c.assetName}
                      disabled={locked}
                      onClick={() => {
                        setPicked({ text: tokenText, assetName: c.assetName });
                        toForm();
                      }}
                      className="min-h-[44px] min-w-[44px] max-w-full break-all px-3 rounded-md text-[12px] text-white disabled:opacity-60"
                      style={token?.assetName === c.assetName ? PRIMARY : { background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
                    >
                      {c.label ?? (c.assetName.slice(0, 16) || '(no name)')}
                    </button>
                  ))}
                </div>
                {policyList.cut && <p className="text-[11px] text-white/60">Not everything under this id is listed. If yours isn’t here, paste its whole address.</p>}
              </div>
            )}
            {token && (
              <div className="mt-2 rounded-xl p-3 space-y-1.5" style={FIELD} data-testid="cardano-coin-identity">
                {tokenInfo === 'loading' && <p className="text-[12px] text-white/65">Reading the coin…</p>}
                {tokenInfo !== null && tokenInfo !== 'loading' && tokenInfo.status === 'unread' && (
                  <p className="text-[12px] text-danger">The coin could not be read just now ({tokenInfo.reason}). No price is shown for a coin this page cannot name.</p>
                )}
                {tokenInfo !== null && tokenInfo !== 'loading' && tokenInfo.status === 'ok' && tokenInfo.data === null && (
                  <p className="text-[12px] text-danger">The chain has no record of this coin yet. Check the id.</p>
                )}
                {info && (
                  <>
                    <p className="text-[14px] text-white font-semibold">
                      {coinName(info)}
                      {info.name && info.ticker && info.name !== info.ticker && <span className="ml-2 text-[11px] font-normal text-white/60">{info.name}</span>}
                    </p>
                    <p className="font-mono text-[10.5px] text-white/80 break-all">
                      {token.policyId}
                      <span className="text-white/45">.</span>
                      {token.assetName || '(no name)'}
                    </p>
                    <div className="flex flex-wrap gap-x-4">
                      <CopyButton text={token.policyId + token.assetName} display="Copy the whole id" className="min-h-[44px] text-[11px] underline" />
                      <a href={cardanoscanToken(token.policyId, token.assetName)} target="_blank" rel="noopener noreferrer nofollow" className="min-h-[44px] inline-flex items-center text-[11px] underline">
                        Coin on Cardanoscan <span aria-hidden="true">↗</span>
                      </a>
                    </div>
                    <p className="text-[11px] text-white/60">Anyone can mint a coin with any name. The policy id is what makes it this coin.</p>
                    {info.decimals === null && <p className="text-[11px] text-white/60">No decimals on record: amounts are whole units.</p>}
                  </>
                )}
              </div>
            )}
          </div>

          <div>
            <label htmlFor="cardano-amount" className="block text-white text-[11px] mb-1.5">
              You pay ({side === 'buy' ? 'ADA' : coinName(info)})
            </label>
            <input
              id="cardano-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={amountInput}
              disabled={!tokenKnown || locked}
              onChange={(e) => {
                setAmountInput(e.target.value);
                toForm();
              }}
              className="w-full rounded-xl p-3 bg-transparent text-right text-white text-[20px] font-mono outline-none disabled:opacity-50"
              style={FIELD}
            />
            {amountInput.trim() !== '' && tokenKnown && amountIn === null && <p className="mt-1 text-[11px] text-danger">Not an amount this coin can hold (at most {inDecimals} decimals).</p>}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-white/70" role="group" aria-label="Slippage">
            <span>Slippage</span>
            {SLIPPAGES.map((bps) => (
              <button
                key={bps}
                type="button"
                aria-pressed={slippageBps === bps}
                disabled={locked}
                onClick={() => {
                  setSlippageBps(bps);
                  toForm();
                }}
                className="min-h-[44px] min-w-[44px] px-3 rounded-md text-white disabled:opacity-60"
                style={slippageBps === bps ? PRIMARY : { background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
              >
                {bps / 100}%
              </button>
            ))}
          </div>

          {quote.kind === 'no-pool' && <p className="text-[12px] text-white/75">No Minswap V2 pool holds ADA and this coin.</p>}
          {quote.kind === 'refused' && <p className="text-[12px] text-danger">{quote.reason}</p>}
          {quote.kind === 'unread' && <p className="text-[12px] text-danger">The pool could not be read just now ({quote.reason}). That does not mean there is none.</p>}

          {quote.kind === 'quote' && (
            <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-quote">
              <Line label="You get about" value={amountText(quote.quote.expectedOut, outLabel)} note={`at least ${amountText(quote.quote.minimumReceive, outLabel)}, or your coins come back`} />
              <Line label="Venue fee" value={venueFeeText(quote.quote.venueFee)} note={quote.quote.venueFee.kind === 'charged' ? formatAda(quote.quote.venueFee.lovelace) : undefined} />
              <Line
                label="Pool fee"
                value={`${feePercentText(quote.quote.poolFeeNumerator)} of what you pay in`}
                note={quote.quote.minswapShareNumerator !== null ? `to the pool’s LPs; Minswap keeps ${feePercentText(quote.quote.minswapShareNumerator)} of it` : 'to the pool’s LPs'}
              />
              <Line label="Batcher fee" value="up to 2 ADA" note="to Minswap’s batcher, which fills the order" />
              <Line label="Order deposit" value="2 ADA" note="comes back with your coins" />
              <Line label="Price impact" value={`${(quote.quote.priceImpactBps / 100).toFixed(2)}%`} />
              {quote.quote.priceImpactBps > 300 && <p className="text-[11px] text-danger">This trade moves the pool’s price by more than 3%.</p>}
            </div>
          )}

          {flow.kind === 'moved' && <p className="text-[12px] text-danger" role="alert">The pool moved: it now pays less than the minimum you saw. Nothing was built. The new price is above.</p>}
          {flow.kind === 'stopped' && (
            <div role="alert" className="text-[12px] text-danger space-y-1">
              <p>{flow.message}</p>
              {flow.problems && (
                <ul className="list-disc pl-5">
                  {flow.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {flow.kind === 'review' || flow.kind === 'signing' ? null : (
            <button type="button" disabled={cta.disabled} onClick={cta.onClick} className="w-full min-h-[48px] rounded-xl text-white text-[14px] font-semibold disabled:opacity-50" style={PRIMARY}>
              {cta.label}
            </button>
          )}

          {flow.kind === 'review' && <ReviewCard prepared={flow.prepared} labels={flow.labels} onSign={() => void onSign()} onBack={toForm} />}
          {flow.kind === 'signing' && (
            <p role="status" className="text-[12px] text-white/75">
              Waiting for your wallet…
            </p>
          )}
          {flow.kind === 'done' && (
            <p role="status" className={`text-[12px] ${flow.tone === 'ok' ? 'text-success' : 'text-white/85'}`}>
              {flow.message}
            </p>
          )}

          <FinePrint summary="How a Cardano swap works">
            <p>
              Your transaction does not trade. It places an order at Minswap V2’s order contract, saying which pool, how much, the least you accept, and that only you are paid. Minswap’s batcher fills it a few blocks later. The contract lets it fill only if you get at least your minimum; if the price has moved past it, the order lets the batcher send your coins back instead, keeping its fee of up to 2 ADA. Until then the order stays yours: only your wallet can cancel it.
            </p>
            {VENUE_FEE_ON && <p>The venue fee is paid with the order, not with the fill, so an order that comes back has still paid it.</p>}
            <p>
              Before your wallet is asked to sign, this page reads the transaction back out of its own bytes and refuses it unless it pays only the order
              {VENUE_FEE_ON ? ', the venue fee to the venue’s registered address,' : ''} and your change to your own address. It never changes your stake or your vote.
            </p>
            <p>
              Minswap V2’s contracts were audited by CertiK and Anastasia Labs. This page writes Minswap’s own order format, checked byte for byte against real orders Minswap filled.
            </p>
            <p>On a phone, open this page inside your wallet’s own browser (Eternl or VESPR): Cardano wallets connect to pages through their browser extension or their in-app browser.</p>
          </FinePrint>
        </div>
      </m.div>

      {orders.length > 0 && (
        <section className="mt-4 rounded-2xl p-5 relative overflow-hidden" style={CARD} aria-label="Your Cardano orders">
          <div className="absolute inset-0">
            <ArtImg pageId="cardano-swap" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.87)' }} />
          </div>
          <div className="relative z-10 space-y-3">
            <h2 className="text-white text-[14px] font-semibold">Your orders</h2>
            {orders.map((o) => {
              const s = statusText(statuses[o.txHash], o, expiredPolls[o.txHash] ?? 0);
              const coin = isAda(o.assetIn) ? o.assetOut : o.assetIn;
              return (
                <div key={o.txHash} className="text-[12px] text-white/85 space-y-1" data-testid="cardano-order">
                  <p className="text-white">
                    {amountText(BigInt(o.amountIn), o.inLabel)} for at least {amountText(BigInt(o.minimumReceive), o.outLabel)}
                  </p>
                  <p className="font-mono text-[10px] text-white/55 break-all">
                    {(isAda(o.assetIn) ? o.outLabel : o.inLabel).ticker ?? 'Coin'}: {coin.policyId}.{coin.assetName || '(no name)'}
                  </p>
                  <p>{s.text}</p>
                  <div className="flex flex-wrap gap-x-4">
                    <a href={cardanoscanTx(o.txHash)} target="_blank" rel="noopener noreferrer nofollow" className="min-h-[44px] inline-flex items-center underline">
                      Order on Cardanoscan <span aria-hidden="true">↗</span>
                    </a>
                    {s.final && (
                      <button
                        type="button"
                        className="min-h-[44px] px-2 underline text-white/70"
                        onClick={() => {
                          dropOrderNote(o.txHash);
                          setSessionOrders((prev) => prev.filter((x) => x.txHash !== o.txHash));
                          notesChanged();
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <CardanoWalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
    </div>
  );
}

function ReviewCard({
  prepared,
  labels,
  onSign,
  onBack,
}: {
  prepared: Extract<Prepared, { kind: 'review' }>;
  labels: ReviewLabels;
  onSign: () => void;
  onBack: () => void;
}) {
  const c = prepared.checked;
  const fmtIn = (n: bigint) => amountText(n, labels.inLabel);
  const fmtOut = (n: bigint) => amountText(n, labels.outLabel);
  const selling = !isAda(prepared.plan.assetIn);
  const coinTicker = (selling ? labels.inLabel : labels.outLabel).ticker ?? 'Coin';
  return (
    <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-review">
      <p className="text-white text-[13px] font-semibold">Check, then sign</p>
      <p className="font-mono text-[10px] text-white/60 break-all">
        {coinTicker}: {labels.coin.policyId}.{labels.coin.assetName || '(no name)'}
      </p>
      <Line label="You pay" value={fmtIn(prepared.plan.swapAmount)} />
      <Line label="You get about" value={fmtOut(prepared.quote.expectedOut)} note="from the pool as read just now" />
      <Line label="You get at least" value={fmtOut(prepared.plan.minimumReceive)} note="or your coins come back" />
      <Line label="Leaves your wallet, all in" value={formatAda(c.paidLovelace)} note={c.paidToken ? `and ${fmtIn(c.paidToken.quantity)}` : undefined} />
      {/* On a sell the swap is the coin, locked in the order beside the ADA (checkSwapTx holds it to swapAmount). */}
      <Line
        label="Of that: the order"
        value={formatAda(c.orderLovelace)}
        note={
          selling
            ? `and the ${fmtIn(prepared.plan.swapAmount)} you sell; the ADA is up to 2 ADA batcher fee and the 2 ADA deposit that comes back`
            : 'the swap, up to 2 ADA batcher fee, and the 2 ADA deposit that comes back'
        }
      />
      <Line label="Venue fee" value={c.venueFeeLovelace > 0n ? formatAda(c.venueFeeLovelace) : 'None'} note={venueFeeText(prepared.plan.venueFee)} />
      <Line
        label="Network fee"
        value={formatAda(c.networkFee)}
        note={c.networkFeeExcess > 0n ? `${NETWORK_FEE_NOTE}. It includes ${formatAda(c.networkFeeExcess)} left over: too little to send back as change` : NETWORK_FEE_NOTE}
      />
      {/* Whole, so it can be matched against the wallet's own screen (the datum check holds it to the order). */}
      <Line label="Paid to" value="your own address" note="as the order says, staking key included:" />
      <p className="font-mono text-[10px] text-white/60 break-all" data-testid="cardano-review-paid-to">
        {prepared.plan.trader.bech32}
      </p>
      <p className="text-[11px] text-white/60">Checked: nothing in this transaction pays anyone else or touches your stake.</p>
      <div className="flex gap-2">
        <button type="button" onClick={onBack} className="flex-1 min-h-[48px] rounded-xl text-white text-[13px]" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)' }}>
          Back
        </button>
        <button type="button" onClick={onSign} className="flex-[2] min-h-[48px] rounded-xl text-white text-[14px] font-semibold" style={PRIMARY}>
          Sign in wallet
        </button>
      </div>
    </div>
  );
}

export default function CardanoSwapPage() {
  usePageTitle('Cardano Swap', 'Swap Cardano coins on memetics.finance, through Minswap V2 pools.');
  useEffect(() => {
    trackPageView('cardano-swap');
  }, []);
  const [csl, setCsl] = useState<Csl | null>(null);
  const [cslError, setCslError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadCsl().then(
      (c) => live && setCsl(c),
      (err: unknown) => live && setCslError(err instanceof Error ? err.message : 'The Cardano library did not load.'),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <PageArtBackdrop pageId="cardano-swap" />
      <div className="relative max-w-md mx-auto px-4 py-8">
        <ChainSwitch />
        {cslError && (
          <p role="alert" className="mb-3 text-[12px] text-danger">
            {cslError}
          </p>
        )}
        <CardanoSwapInner csl={csl} cslError={cslError} retryCsl={() => window.location.reload()} />
      </div>
    </>
  );
}

