import { useEffect, useMemo, useState } from 'react';
import { HYPEREVM_TOKENS, V3_FEE_TIERS, hyperEvmAddressUrl, poolSide, type HyperEvmToken, type HyperEvmVenue } from '../../lib/chains/hyperEvm';
import { readCoins } from '../../lib/hyperevm/coins';
import { amountText, withDeadline } from '../../lib/hyperevm/format';
import { listTx, openTx, openerTerms, parsePrice, poolAt, sortedPair, startSqrtPrice, usingBigBlocks, type PoolAt } from '../../lib/hyperevm/opener';
import { feeTierText, readOpenedStates, type V3Pool } from '../../lib/hyperevm/pools';
import { poolPriceText } from '../../lib/hyperevm/positions';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { asReader, useBalance, useHyperEvmClient, type useHyperEvmSend } from './useHyperEvm';
import { CoinLine, CoinSelect, Line, SendStatus } from './parts';
import { PRIMARY_BTN, PRIMARY_STYLE, QUIET_BTN } from './styles';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** What a pool can be paired with: HYPE and the two dollar coins (WHYPE is HYPE's pool side). */
const PARTNERS = HYPEREVM_TOKENS.filter((t) => t.isNative || t.symbol !== 'WHYPE');
const HYPE = HYPEREVM_TOKENS.find((t) => t.isNative)!;
const DUAL_BLOCK_DOCS = 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture';

type CoinRead = { kind: 'none' } | { kind: 'reading' } | { kind: 'bad' } | { kind: 'unread' } | { kind: 'read'; coin: HyperEvmToken };
type Terms = { fee: bigint; treasury: `0x${string}` };
type Send = ReturnType<typeof useHyperEvmSend>;

/**
 * Open a pool: paste a coin, pair it with HYPE, USDC or USD₮0, pick the fee and the starting
 * price, and pay the opener's fee (0.23 HYPE, read from the contract with the treasury it pays).
 * The pool opens empty; liquidity is added after, from the pool list. Owner, 2026-11-26: from
 * the wallet's own account, so the wallet needs Hyperliquid's big-block setting on, which the
 * site reads and explains but never switches. A pool someone already opened straight on the
 * factory (off the list) can be listed for the same fee, at its own price, with no big blocks.
 */
export function OpenPoolCard({ venue, opener, pools, send, onAdd, onDone }: {
  venue: HyperEvmVenue; opener: `0x${string}`; pools: readonly V3Pool[] | null; send: Send;
  onAdd: (pool: V3Pool) => void; onDone: () => void;
}) {
  const client = useHyperEvmClient();
  const [pasted, setPasted] = useState('');
  const [read, setRead] = useState<CoinRead>({ kind: 'none' });
  const [partner, setPartner] = useState<HyperEvmToken>(HYPE);
  const [fee, setFee] = useState(3000);
  const [priceText, setPriceText] = useState('');
  const [terms, setTerms] = useState<Terms | null | 'reading'>('reading');
  const [at, setAt] = useState<PoolAt | 'unread' | 'reading'>('reading');
  const [existing, setExisting] = useState<V3Pool | null | 'reading'>(null);
  const [bigBlocks, setBigBlocks] = useState<boolean | null | 'reading'>(null);
  const [review, setReview] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Bumped by "Check again": the setting is switched outside the site, so nothing here changes when it is.
  const [bigBlocksAsk, setBigBlocksAsk] = useState(0);
  const hype = useBalance(HYPE, send.address, refresh);
  const coin = read.kind === 'read' ? read.coin : null;
  const sameSide = coin !== null && poolSide(coin).toLowerCase() === poolSide(partner).toLowerCase();

  // The coin, from its own contract.
  useEffect(() => {
    const a = pasted.trim();
    setReview(false);
    if (!client || !ADDRESS.test(a)) {
      setRead({ kind: 'none' });
      return;
    }
    let live = true;
    setRead({ kind: 'reading' });
    const addr = a as `0x${string}`;
    const unread: CoinRead = { kind: 'unread' };
    // Left out of the map = could not be read (reads.ts), which is not "not a coin".
    void withDeadline(readCoins(asReader(client), [addr]).then((m): CoinRead => {
      const k = addr.toLowerCase();
      if (!m.has(k)) return unread;
      const c = m.get(k);
      return c ? { kind: 'read', coin: c } : { kind: 'bad' };
    }), unread).then((r) => {
      if (live) setRead(r);
    });
    return () => {
      live = false;
    };
  }, [client, pasted]);

  // The opener's own fee, and the treasury it pays.
  useEffect(() => {
    if (!client) return;
    let live = true;
    void withDeadline(openerTerms(asReader(client), opener), null).then((t) => live && setTerms(t));
    return () => {
      live = false;
    };
  }, [client, opener, refresh]);

  // Whether the pool is open already, and if it is, its state so it can be added to or listed.
  useEffect(() => {
    setExisting(null);
    if (!client || !coin || sameSide) {
      setAt('reading');
      return;
    }
    let live = true;
    setAt('reading');
    void withDeadline(poolAt(asReader(client), venue, coin, partner, fee), null).then(async (r) => {
      if (!live) return;
      setAt(r ?? 'unread');
      if (r?.kind !== 'open') return;
      const shown = pools?.find((p) => p.address.toLowerCase() === r.address.toLowerCase());
      if (shown) return setExisting(shown);
      setExisting('reading');
      const [t0, t1] = sortedPair(coin, partner);
      const tier = V3_FEE_TIERS.find((t) => t.fee === fee)!;
      const s = await withDeadline(readOpenedStates(asReader(client), [{ address: r.address, token0: t0, token1: t1, fee, tickSpacing: tier.tickSpacing }]), []);
      if (live) setExisting(s[0] ?? null);
    });
    return () => {
      live = false;
    };
  }, [client, venue, coin, partner, fee, sameSide, pools, refresh]);

  // The wallet's big-block setting.
  useEffect(() => {
    if (!client || !send.address) {
      setBigBlocks(null);
      return;
    }
    let live = true;
    setBigBlocks('reading');
    const request = client.request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    void withDeadline(usingBigBlocks(request, send.address), null).then((b) => live && setBigBlocks(b));
    return () => {
      live = false;
    };
  }, [client, send.address, refresh, bigBlocksAsk]);

  const price = useMemo(() => parsePrice(priceText), [priceText]);
  const sqrt = useMemo(() => (coin && !sameSide ? startSqrtPrice(priceText, coin, partner) : null), [coin, sameSide, priceText, partner]);
  const working = send.state.kind === 'wallet' || send.state.kind === 'mining';
  const t = terms !== 'reading' ? terms : null;
  const short = t !== null && hype !== null && hype < t.fee;
  const pair = coin ? `${coin.symbol} / ${partner.symbol} ${feeTierText(fee)}` : '';
  const isOpen = typeof at === 'object' && at.kind === 'open';
  const onList = isOpen && existing !== null && existing !== 'reading' && !!pools?.some((p) => p.address.toLowerCase() === existing.address.toLowerCase());
  const mode: 'open' | 'list' | 'shown' = !isOpen ? 'open' : onList ? 'shown' : 'list';

  let block: string | null = null;
  if (!coin) block = read.kind === 'reading' ? 'Reading the coin…' : read.kind === 'bad' ? 'This address does not answer as a coin.' : read.kind === 'unread' ? 'Could not read this coin just now.' : 'Paste the coin’s contract address.';
  else if (sameSide) block = 'Pick two different coins.';
  else if (at === 'reading') block = 'Checking whether this pool is open…';
  else if (at === 'unread') block = 'Could not read whether this pool is open.';
  else if (mode === 'shown') block = 'This pool is already open, and on the list above.';
  else if (mode === 'list' && existing === 'reading') block = 'Reading the pool…';
  else if (mode === 'list' && existing === null) block = 'This pool is open, but its coins could not be read.';
  else if (mode === 'open' && !price.ok) block = price.why === 'empty' ? 'Type the starting price.' : price.why === 'grouped' ? 'Type the price without thousands marks: 1000, not 1,000.' : 'Type the starting price as a plain number.';
  else if (mode === 'open' && sqrt === null) block = 'That price is outside what a pool can hold.';
  else if (terms === 'reading') block = 'Reading the opening fee…';
  else if (t === null) block = 'Could not read the opening fee just now.';
  else if (t.treasury.toLowerCase() !== venue.treasury.toLowerCase()) block = 'This opener pays a treasury the site does not know. Nothing can be sent.';
  else if (mode === 'open' && send.isConnected && send.address && bigBlocks === 'reading') block = 'Reading your wallet’s big-block setting…';
  else if (mode === 'open' && send.isConnected && bigBlocks === null) block = 'Could not read your wallet’s big-block setting just now.';
  else if (mode === 'open' && send.isConnected && bigBlocks === false) block = 'Your wallet needs Hyperliquid’s big-block setting on to open a pool.';
  else if (short) block = `It pays ${amountText(t.fee, 18)} HYPE. This wallet holds ${amountText(hype!, 18)}.`;
  const warn = !!block && /^(Your wallet needs|It pays|This opener pays)/.test(block);
  const recheckBigBlocks = mode === 'open' && send.isConnected && !!send.address && (bigBlocks === false || bigBlocks === null);

  const go = async () => {
    // The same blocks as Review: a wallet switched after Review (say, to one without big blocks) sends nothing.
    if (!coin || !t || block) return;
    let ok = false;
    if (mode === 'open' && sqrt !== null) {
      ok = await send.run([{ label: 'Open the pool', tx: async () => openTx(opener, coin, partner, fee, sqrt, t.fee) }]);
    } else if (mode === 'list' && existing && existing !== 'reading') {
      ok = await send.run([{ label: 'List the pool', tx: async () => listTx(opener, existing.address, t.fee) }]);
    }
    if (ok) {
      setReview(false);
      setRefresh((n) => n + 1);
      onDone();
    }
  };

  const shownPool = existing && existing !== 'reading' ? existing : null;

  return (
    <section className="relative isolate overflow-hidden rounded-2xl p-5" style={{ border: '1px solid rgba(255,255,255,0.12)' }} data-testid="hyperevm-open" data-ui-card="">
      <CardArt pageId="liquidity" idx={0} />
      <div className="relative z-10 space-y-3 text-[12px]">
        <h2 className="text-white font-semibold text-[15px]">Open a pool</h2>
        <p className="text-white/75">Any coin, paired with HYPE, USDC or USD₮0. Opening pays the venue {t === null ? '0.23' : amountText(t.fee, 18)} HYPE.</p>
        <input
          placeholder="Paste the coin’s contract address" aria-label="Coin’s contract address" value={pasted} spellCheck={false}
          onChange={(e) => setPasted(e.target.value)} className="w-full min-w-0 rounded-lg bg-black/55 px-3 py-2 text-white text-[16px] font-mono outline-none" data-testid="hyperevm-open-coin"
        />
        {coin && <CoinLine token={coin} />}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-white/80">Paired with</span>
          <CoinSelect label="Coin it is paired with" value={partner} onChange={(x) => { setPartner(x); setReview(false); }} tokens={PARTNERS} />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Pool fee">
          {V3_FEE_TIERS.map((x) => (
            <button key={x.fee} type="button" aria-pressed={fee === x.fee} onClick={() => { setFee(x.fee); setReview(false); }} className="min-h-[36px] px-3 rounded-full text-[12px]" style={fee === x.fee ? { background: 'rgba(139,92,246,0.35)', color: '#fff' } : { background: 'rgba(0,0,0,0.45)', color: 'rgba(255,255,255,0.8)' }}>
              {feeTierText(x.fee)}
            </button>
          ))}
        </div>
        {coin && !sameSide && mode === 'open' && (
          <>
            <label className="flex flex-wrap items-center gap-2 text-white/80">
              <span>1 {coin.symbol} =</span>
              <input inputMode="decimal" placeholder="0.0" aria-label={`Starting price: ${partner.symbol} per ${coin.symbol}`} value={priceText} onChange={(e) => { setPriceText(e.target.value); setReview(false); }} className="w-40 min-w-0 rounded-lg bg-black/55 px-3 py-2 text-white text-[16px] outline-none" data-testid="hyperevm-open-price" />
              <span>{partner.symbol}</span>
            </label>
            {price.ok && <Line label="Read as" value={`1 ${coin.symbol} = ${price.shown} ${partner.symbol}`} />}
          </>
        )}

        {isOpen && typeof at === 'object' && at.kind === 'open' && (
          <div className="rounded-lg bg-black/55 p-3 space-y-1.5" data-testid="hyperevm-open-exists">
            <Line label="Pool" value={<a className="underline" href={hyperEvmAddressUrl(at.address)} target="_blank" rel="noopener noreferrer">{at.address}</a>} mono />
            {shownPool && <Line label="Price now" value={`1 ${shownPool.token0.symbol} = ${poolPriceText(shownPool)} ${shownPool.token1.symbol}`} />}
            {mode === 'list' && <p className="text-white/75">Opened straight on the factory, so it is not on the list. Listing it puts it there at this price, for the same fee. Once it is listed, you can add to it.</p>}
            {/* Only a pool on the list: a position in one off it would not show on the site. List it first. */}
            {shownPool && mode === 'shown' && <button type="button" className={QUIET_BTN} onClick={() => onAdd(shownPool)}>Add to it</button>}
          </div>
        )}

        {block && <p className={warn ? 'text-amber-300/90' : 'text-white/75'} data-testid="hyperevm-open-block">{block}</p>}
        {recheckBigBlocks && <button type="button" className={QUIET_BTN} onClick={() => setBigBlocksAsk((n) => n + 1)} data-testid="hyperevm-open-bigblocks-recheck">Check again</button>}

        {!send.isConnected ? (
          <p className="text-white/75">Connect a wallet to open a pool.</p>
        ) : !send.onChain ? (
          <button type="button" className={PRIMARY_BTN} style={PRIMARY_STYLE} onClick={() => void send.switchToHyperEvm()}>Switch wallet to HyperEVM</button>
        ) : !review ? (
          <button type="button" className={PRIMARY_BTN} style={PRIMARY_STYLE} disabled={!!block || working} onClick={() => setReview(true)} data-testid="hyperevm-open-review-button">{mode === 'list' ? 'Review listing' : 'Review'}</button>
        ) : (
          coin && t && (
            <div className="rounded-lg bg-black/55 p-3 space-y-1.5" data-testid="hyperevm-open-review">
              <div className="text-white font-semibold text-[13px]">Review</div>
              <Line label={mode === 'list' ? 'List the pool' : 'Pool'} value={pair} />
              {mode === 'open' && price.ok && <Line label="Starting price" value={`1 ${coin.symbol} = ${price.shown} ${partner.symbol}`} />}
              {mode === 'list' && shownPool && <Line label="It keeps its price" value={`1 ${shownPool.token0.symbol} = ${poolPriceText(shownPool)} ${shownPool.token1.symbol}`} />}
              <Line label="You pay the venue" value={`${amountText(t.fee, 18)} HYPE, to the treasury Safe`} />
              <Line label="Treasury Safe (read from the opener)" value={t.treasury} mono />
              {mode === 'open' && <Line label="It holds" value="Nothing yet: add liquidity after it opens" />}
              <Line label="Opener" value={opener} mono />
              <div className="flex gap-2">
                <button type="button" className={QUIET_BTN} onClick={() => setReview(false)} disabled={working}>Back</button>
                <button type="button" className={PRIMARY_BTN} style={PRIMARY_STYLE} onClick={() => void go()} disabled={working || !!block} data-testid="hyperevm-open-send">{mode === 'list' ? 'List pool' : 'Open pool'}</button>
              </div>
            </div>
          )
        )}
        <SendStatus state={send.state} />
        <FinePrint summary="How opening works">
          <p>One transaction to our opener contract: it opens the pool on our Uniswap V3 factory at your starting price, switches the venue’s cut of the pool fee on, and passes the opening fee to the treasury Safe. It has no owner and keeps nothing. A pool someone opened straight on the factory can be listed instead, at the price it has, for the same fee.</p>
          <p>An opening takes about 4.6 million gas. A HyperEVM wallet’s transactions go in fast blocks of 3 million until it switches Hyperliquid’s big-block setting on. That needs an account on Hyperliquid itself, and is set from the wallet, never through this site: <a className="underline" href={DUAL_BLOCK_DOCS} target="_blank" rel="noopener noreferrer">Hyperliquid’s docs</a>. A listing is small and needs nothing.</p>
          <p>A coin off the site’s list shows the ticker it gives itself and its whole address. A ticker copying HYPE, USDC or USD₮0 reads “fake USDC”. An empty pool’s price can be moved by anyone for free, so check “Price now” before you add.</p>
        </FinePrint>
      </div>
    </section>
  );
}
