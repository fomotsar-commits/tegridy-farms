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
import { readTokenInfo, type Read, type TokenInfo } from '../lib/cardano/chain';
import { prepareSwap, quoteNow, signAndSend, type Prepared } from '../lib/cardano/swapFlow';
import type { SwapQuote } from '../lib/cardano/quote';
import { venueFeeText } from '../lib/cardano/venueFee';
import { cardanoscanToken, cardanoscanTx, formatAda, formatAmount, LOVELACE_DECIMALS, parseAmount, parseTokenId } from '../lib/cardano/format';
import { dropOrderNote, readOrderNotes, readOrderStatus, type OrderStatus, type PendingOrder } from '../lib/cardano/orderWatch';
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

type Flow =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'review'; prepared: Extract<Prepared, { kind: 'review' }> }
  | { kind: 'moved'; quote: SwapQuote }
  | { kind: 'stopped'; message: string; problems?: string[] }
  | { kind: 'signing' }
  | { kind: 'done'; message: string; tone: 'ok' | 'warn' };

const SLIPPAGES = [50, 100, 300] as const;
const POLL_MS = 10_000;

const CARD = { border: '1px solid rgba(255,255,255,0.12)' } as const;
const FIELD = { background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' } as const;
const PRIMARY = { background: 'var(--color-stan)', border: '1px solid var(--color-stan)' } as const;

function coinName(info: TokenInfo | null): string {
  return info?.ticker ?? info?.name ?? 'This coin';
}

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

function statusText(s: OrderStatus | undefined, order: PendingOrder, out: { name: string; decimals: number }): { text: string; final: boolean } {
  if (!s) return { text: 'Reading…', final: false };
  switch (s.kind) {
    case 'not-seen':
      return { text: 'Sent. The chain has not shown it yet.', final: false };
    case 'expired':
      return { text: 'Never placed: its expiry has passed, so it can no longer land. Nothing left your wallet. Safe to try again.', final: true };
    case 'placed':
      return { text: `Order placed${s.depth > 0 ? ` (${s.depth} block${s.depth === 1 ? '' : 's'} deep)` : ''}. Waiting for Minswap’s batcher to fill it.`, final: false };
    case 'filled':
      return {
        text: isAda(order.assetOut)
          ? `Filled: ${formatAda(s.received)} came back, with your 2 ADA deposit.`
          : `Filled: ${formatAmount(s.received, out.decimals)} ${out.name}, with ${formatAda(s.depositBack)} back.`,
        final: true,
      };
    case 'returned':
      return { text: 'Returned: the price moved past your minimum, so the batcher sent your coins back, keeping its fee.', final: true };
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
  const token = useMemo(() => parseTokenId(tokenText), [tokenText]);
  const tokenKey = token ? token.policyId + token.assetName : null;
  // Every read is kept with the inputs it answered, and shown only while they are still the
  // form's: an answer for an earlier coin or amount is never on screen for the current one.
  const [infoRead, setInfoRead] = useState<{ key: string; value: Read<TokenInfo | null> } | null>(null);
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [quoteRead, setQuoteRead] = useState<{ key: string; value: QuoteState } | null>(null);
  const [flow, setFlow] = useState<Flow>({ kind: 'form' });
  const [notesVersion, notesChanged] = useReducer((n: number) => n + 1, 0);
  const [statuses, setStatuses] = useState<Record<string, OrderStatus>>({});

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
  const assetIn: CardanoAsset | null = token ? (side === 'buy' ? ADA : token) : null;
  const inDecimals = side === 'buy' ? LOVELACE_DECIMALS : tokenDecimals;
  const tokenKnown = tokenInfo !== null && tokenInfo !== 'loading' && tokenInfo.status === 'ok' && tokenInfo.data !== null;
  const amountIn = tokenKnown ? parseAmount(amountText, inDecimals) : null;

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

  // This wallet's orders, followed until each one ends.
  const traderHex = wallet.status === 'connected' ? wallet.address.hex : null;
  const orders = useMemo<PendingOrder[]>(
    () => (traderHex ? readOrderNotes().filter((n) => n.traderHex === traderHex) : []),
    // flow.kind: a send just wrote a note; notesVersion: one was cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [traderHex, flow.kind, notesVersion],
  );
  const finals = useRef(new Set<string>());
  useEffect(() => {
    if (orders.length === 0) return;
    let stopped = false;
    const ac = new AbortController();
    const tick = async () => {
      for (const o of orders) {
        if (finals.current.has(o.txHash)) continue;
        const s = await readOrderStatus(o, ac.signal);
        if (stopped) return;
        setStatuses((prev) => ({ ...prev, [o.txHash]: s }));
        if (s.kind === 'filled' || s.kind === 'returned' || s.kind === 'expired' || s.kind === 'spent') finals.current.add(o.txHash);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      ac.abort();
      clearInterval(timer);
    };
  }, [orders]);

  const onReview = useCallback(async () => {
    if (!csl || wallet.status !== 'connected' || !token || !assetIn || amountIn === null || quote.kind !== 'quote') return;
    setFlow({ kind: 'preparing' });
    const p = await prepareSwap(csl, wallet.api, wallet.address, token, assetIn, amountIn, slippageBps, quote.quote);
    if (p.kind === 'review') setFlow({ kind: 'review', prepared: p });
    else if (p.kind === 'moved') {
      if (quoteKey) setQuoteRead({ key: quoteKey, value: { kind: 'quote', quote: p.quote } });
      setFlow({ kind: 'moved', quote: p.quote });
    } else setFlow({ kind: 'stopped', message: p.message, problems: p.problems });
  }, [csl, wallet, token, assetIn, amountIn, slippageBps, quote, quoteKey]);

  const onSign = useCallback(async () => {
    if (!csl || wallet.status !== 'connected' || flow.kind !== 'review') return;
    const prepared = flow.prepared;
    setFlow({ kind: 'signing' });
    const r = await signAndSend(csl, wallet.api, prepared);
    if (r.kind === 'sent') setFlow({ kind: 'done', tone: 'ok', message: 'Order sent. Minswap’s batcher fills it a few blocks after it lands; it is followed below.' });
    else if (r.kind === 'unsure') setFlow({ kind: 'done', tone: 'warn', message: r.message });
    else if (r.kind === 'declined') setFlow({ kind: 'done', tone: 'warn', message: 'You declined in the wallet. Nothing was sent.' });
    else setFlow({ kind: 'done', tone: 'warn', message: r.message });
  }, [csl, wallet, flow]);

  const outName = side === 'buy' ? coinName(info) : 'ADA';
  const fmtOut = (n: bigint) => (side === 'buy' ? `${formatAmount(n, tokenDecimals)} ${outName}` : formatAda(n));
  const fmtIn = (n: bigint) => (side === 'buy' ? formatAda(n) : `${formatAmount(n, tokenDecimals)} ${coinName(info)}`);
  const busy = flow.kind === 'preparing' || flow.kind === 'signing';

  let cta: { label: string; disabled: boolean; onClick?: () => void };
  if (wallet.status !== 'connected') cta = { label: 'Connect a Cardano wallet', disabled: false, onClick: () => setWalletOpen(true) };
  else if (!csl) cta = { label: cslError ? 'Reload the page to try again' : 'Loading…', disabled: !cslError, onClick: cslError ? retryCsl : undefined };
  else if (!token) cta = { label: 'Paste a coin’s policy id and name', disabled: true };
  else if (quote.kind === 'loading') cta = { label: 'Getting a price…', disabled: true };
  else if (quote.kind !== 'quote') cta = { label: 'Enter an amount', disabled: true };
  else cta = { label: flow.kind === 'preparing' ? 'Building and checking…' : 'Review swap', disabled: busy, onClick: () => void onReview() };

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
                disabled={busy}
                onClick={() => {
                  setSide(s);
                  setAmountText('');
                  setFlow({ kind: 'form' });
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
              The coin: its policy id and name, as hex
            </label>
            <input
              id="cardano-coin"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="policy id (56 hex) + asset name (hex)"
              value={tokenText}
              onChange={(e) => {
                setTokenText(e.target.value);
                setFlow({ kind: 'form' });
              }}
              className="w-full rounded-xl p-3 bg-transparent text-white text-[12px] font-mono outline-none"
              style={FIELD}
            />
            {tokenText.trim() !== '' && !token && <p className="mt-1 text-[11px] text-danger">That is not a coin id: 56 hex characters of policy id, then the asset name in hex.</p>}
            {token && (
              <div className="mt-2 rounded-xl p-3 space-y-1.5" style={FIELD} data-testid="cardano-coin-identity">
                {tokenInfo === 'loading' && <p className="text-[12px] text-white/65">Reading the coin…</p>}
                {tokenInfo !== null && tokenInfo !== 'loading' && tokenInfo.status === 'unread' && (
                  <p className="text-[12px] text-danger">The coin could not be read just now ({tokenInfo.reason}). No price is shown for a coin this page cannot name.</p>
                )}
                {tokenInfo !== null && tokenInfo !== 'loading' && tokenInfo.status === 'ok' && tokenInfo.data === null && (
                  <p className="text-[12px] text-danger">No coin with this id has ever been minted.</p>
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
              value={amountText}
              disabled={!tokenKnown}
              onChange={(e) => {
                setAmountText(e.target.value);
                setFlow({ kind: 'form' });
              }}
              className="w-full rounded-xl p-3 bg-transparent text-right text-white text-[20px] font-mono outline-none disabled:opacity-50"
              style={FIELD}
            />
            {amountText.trim() !== '' && tokenKnown && amountIn === null && <p className="mt-1 text-[11px] text-danger">Not an amount this coin can hold (at most {inDecimals} decimals).</p>}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-white/70" role="group" aria-label="Slippage">
            <span>Slippage</span>
            {SLIPPAGES.map((bps) => (
              <button
                key={bps}
                type="button"
                aria-pressed={slippageBps === bps}
                onClick={() => setSlippageBps(bps)}
                className="min-h-[44px] px-3 rounded-md text-white"
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
              <Line label="You get about" value={fmtOut(quote.quote.expectedOut)} note={`at least ${fmtOut(quote.quote.minimumReceive)}, or your coins come back`} />
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

          {(flow.kind === 'review' || flow.kind === 'signing') && quote.kind === 'quote' && (
            <ReviewCard
              prepared={flow.kind === 'review' ? flow.prepared : null}
              signing={flow.kind === 'signing'}
              fmtIn={fmtIn}
              fmtOut={fmtOut}
              onSign={() => void onSign()}
              onBack={() => setFlow({ kind: 'form' })}
            />
          )}
          {flow.kind === 'done' && (
            <p role="status" className={`text-[12px] ${flow.tone === 'ok' ? 'text-success' : 'text-white/85'}`}>
              {flow.message}
            </p>
          )}

          <FinePrint summary="How a Cardano swap works">
            <p>
              Your transaction does not trade. It places an order at Minswap V2’s order contract, saying which pool, how much, the least you accept, and that only you are paid. Minswap’s batcher fills it a few blocks later. The contract lets it only if you get at least your minimum; if the price has moved past it, the batcher must send your coins back, keeping its fee of up to 2 ADA.
            </p>
            <p>The venue fee is paid with the order, not with the fill, so an order that comes back has still paid it.</p>
            <p>
              Before your wallet is asked to sign, this page reads the transaction back out of its own bytes and refuses it unless it pays only the order, the venue fee to the venue’s registered address, and your change to your own address. It never changes your stake or your vote.
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
              const s = statusText(statuses[o.txHash], o, { name: o.assetOut.policyId === token?.policyId && o.assetOut.assetName === token?.assetName ? coinName(info) : 'coins', decimals: tokenDecimals });
              return (
                <div key={o.txHash} className="text-[12px] text-white/85 space-y-1" data-testid="cardano-order">
                  <p>{s.text}</p>
                  <div className="flex flex-wrap gap-x-4">
                    <a href={cardanoscanTx(o.txHash)} target="_blank" rel="noopener noreferrer nofollow" className="min-h-[44px] inline-flex items-center underline">
                      Order on Cardanoscan <span aria-hidden="true">↗</span>
                    </a>
                    {s.final && (
                      <button
                        type="button"
                        className="min-h-[44px] underline text-white/70"
                        onClick={() => {
                          dropOrderNote(o.txHash);
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
  signing,
  fmtIn,
  fmtOut,
  onSign,
  onBack,
}: {
  prepared: Extract<Prepared, { kind: 'review' }> | null;
  signing: boolean;
  fmtIn: (n: bigint) => string;
  fmtOut: (n: bigint) => string;
  onSign: () => void;
  onBack: () => void;
}) {
  if (!prepared) return <p role="status" className="text-[12px] text-white/75">Waiting for your wallet…</p>;
  const c = prepared.checked;
  return (
    <div className="rounded-xl p-3 space-y-2" style={FIELD} data-testid="cardano-review">
      <p className="text-white text-[13px] font-semibold">Check, then sign</p>
      <Line label="You pay" value={fmtIn(prepared.plan.swapAmount)} />
      <Line label="You get at least" value={fmtOut(prepared.plan.minimumReceive)} note="or your coins come back" />
      <Line label="Leaves your wallet, all in" value={formatAda(c.paidLovelace)} note={c.paidToken ? `and ${fmtIn(c.paidToken.quantity)}` : undefined} />
      <Line label="Of that: the order" value={formatAda(c.orderLovelace)} note="the swap, up to 2 ADA batcher fee, and the 2 ADA deposit that comes back" />
      <Line label="Venue fee" value={c.venueFeeLovelace > 0n ? formatAda(c.venueFeeLovelace) : 'None'} />
      <Line label="Network fee" value={formatAda(c.networkFee)} />
      <Line label="Paid to" value={shortCardanoAddress(prepared.plan.trader.bech32)} note="your own address, whole, as the order says" />
      <p className="text-[11px] text-white/60">Checked: nothing in this transaction pays anyone else or touches your stake.</p>
      <div className="flex gap-2">
        <button type="button" onClick={onBack} disabled={signing} className="flex-1 min-h-[48px] rounded-xl text-white text-[13px] disabled:opacity-50" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)' }}>
          Back
        </button>
        <button type="button" onClick={onSign} disabled={signing} className="flex-[2] min-h-[48px] rounded-xl text-white text-[14px] font-semibold disabled:opacity-50" style={PRIMARY}>
          {signing ? 'Waiting for your wallet…' : 'Sign in wallet'}
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
