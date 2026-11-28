import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { encodeFunctionData, erc20Abi } from 'viem';
import { useSignTypedData } from 'wagmi';
import { HYPEREVM_TOKENS, WHYPE, hyperEvmAddressUrl, hyperEvmVenue, type HyperEvmToken, type HyperEvmVenue } from '../../lib/chains/hyperEvm';
import { PERMIT2, PERMIT2_ALLOWANCE_ABI, PERMIT_SINGLE_TYPES, permit2Domain, type PermitSingle } from '../../lib/evm/universalRouter';
import { amountText, bpsText, parseAmount, withDeadline } from '../../lib/hyperevm/format';
import { feeSplitText, feeTierText } from '../../lib/hyperevm/pools';
import { buildSwapTx, minReceived, priceImpactBps, quoteSwap, type QuoteResult } from '../../lib/hyperevm/swap';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { asReader, useBalance, useHyperEvmClient, useHyperEvmSend, usePools } from './useHyperEvm';
import { CoinLine, CoinSelect, Line, SendStatus } from './parts';
import { PRIMARY_BTN, PRIMARY_STYLE, deadlineIn } from './styles';

const SLIPPAGE_CHOICES = [10, 50, 100] as const;
const IMPACT_WARN_BPS = 300;

/**
 * The HyperEVM swap: our own pools only, priced by our QuoterV2, signed through our Universal
 * Router with the site fee paid to the treasury Safe in the same transaction. A press of Review
 * always comes first (owner, 2026-10-13: a swap in our own pool is always a review).
 * `pageHeading`: on /hyperevm its title is the page's h1; in the sheet it stays an h2.
 */
export function HyperEvmSwapCard({ lead, pageHeading = false }: { lead?: ReactNode; pageHeading?: boolean }) {
  const venue = hyperEvmVenue();
  if (!venue) return null;
  return <SwapForm venue={venue} lead={lead} pageHeading={pageHeading} />;
}

function SwapForm({ venue, lead, pageHeading }: { venue: HyperEvmVenue; lead?: ReactNode; pageHeading: boolean }) {
  const Title = pageHeading ? 'h1' : 'h2';
  const client = useHyperEvmClient();
  const { state: poolsState } = usePools(venue);
  const send = useHyperEvmSend();
  const { signTypedDataAsync } = useSignTypedData();
  const [from, setFrom] = useState<HyperEvmToken>(HYPEREVM_TOKENS[0]!);
  const [to, setTo] = useState<HyperEvmToken>(HYPEREVM_TOKENS[2]!);
  const [text, setText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const [quote, setQuote] = useState<QuoteResult | { ok: false; why: 'loading' } | null>(null);
  const [review, setReview] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const balance = useBalance(from, send.address, refresh);
  const amountIn = parseAmount(text, from.decimals);
  const pools = poolsState.status === 'ready' ? poolsState.pools : null;
  // The listed coins, then every coin someone opened a pool for (each shows its whole address below).
  const coins = useMemo(() => {
    const out: HyperEvmToken[] = [...HYPEREVM_TOKENS];
    for (const p of pools ?? []) for (const t of [p.token0, p.token1]) if (t.unlisted && !out.some((x) => x.address.toLowerCase() === t.address.toLowerCase())) out.push(t);
    return out;
  }, [pools]);

  useEffect(() => {
    setReview(false);
    if (!client || !pools || amountIn === null) {
      setQuote(null);
      return;
    }
    let live = true;
    setQuote({ ok: false, why: 'loading' });
    const t = setTimeout(() => {
      void withDeadline(quoteSwap(asReader(client), venue, pools, from, to, amountIn), { ok: false as const, why: 'unread' as const }).then((q) => live && setQuote(q));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // amountIn is a bigint: compare by value through `text`.
  }, [client, pools, venue, from, to, text, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const best = quote && quote.ok ? quote.best : null;
  const minOut = best ? minReceived(best.out, slippageBps) : null;
  const impact = best ? priceImpactBps(best) : 0;
  const tooMuch = amountIn !== null && balance !== null && amountIn > balance;

  const flip = () => {
    setFrom(to);
    setTo(from);
    setText('');
  };

  const pickFrom = (t: HyperEvmToken) => {
    if (t.address === to.address) setTo(from);
    setFrom(t);
  };
  const pickTo = (t: HyperEvmToken) => {
    if (t.address === from.address) setFrom(to);
    setTo(t);
  };

  const sendSwap = async () => {
    if (!best || minOut === null || !send.address || !client) return;
    const owner = send.address;
    const deadline = deadlineIn(20);
    const steps: Parameters<typeof send.run>[0] = [];
    let permit: { permit: PermitSingle; signature: `0x${string}` } | undefined;
    if (!best.from.isNative) {
      const coin = best.from.address;
      // The router takes the coin through Permit2: Permit2 needs an allowance for this amount first.
      steps.push({
        label: `Allow Permit2 to move ${best.from.symbol}`,
        tx: async () => {
          const allowed = await client.readContract({ address: coin, abi: erc20Abi, functionName: 'allowance', args: [owner, PERMIT2] });
          if (allowed >= best.amountIn) return null;
          return { to: coin, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, best.amountIn] }) };
        },
      });
    }
    steps.push({
      label: 'The swap',
      tx: async () => {
        if (!best.from.isNative) {
          const [allowed, expiration, nonce] = await client.readContract({ address: PERMIT2, abi: PERMIT2_ALLOWANCE_ABI, functionName: 'allowance', args: [owner, best.from.address, venue.universalRouter] });
          if (allowed < best.amountIn || BigInt(expiration) <= deadline) {
            const now = Math.floor(Date.now() / 1000);
            const message: PermitSingle = { details: { token: best.from.address, amount: best.amountIn, expiration: now + 30 * 60, nonce }, spender: venue.universalRouter, sigDeadline: BigInt(now + 30 * 60) };
            const signature = await signTypedDataAsync({ domain: permit2Domain(venue.chainId), types: PERMIT_SINGLE_TYPES, primaryType: 'PermitSingle', message });
            permit = { permit: message, signature };
          }
        }
        return buildSwapTx({ venue, quote: best, minOut, deadline, permit });
      },
    });
    const ok = await send.run(steps);
    if (ok) {
      setText('');
      setReview(false);
      setRefresh((n) => n + 1);
    }
  };

  const split = best ? feeSplitText(best.pool.fee, sideShare(best)) : null;

  return (
    <section className="relative isolate overflow-hidden rounded-2xl p-5" style={{ border: '1px solid rgba(255,255,255,0.12)' }} data-testid="hyperevm-swap" data-ui-card="">
      <CardArt pageId="trade" idx={1} />
      <div className="relative z-10 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Title className="text-white font-semibold text-[15px]">Swap on HyperEVM</Title>
          {lead}
        </div>
        <p className="text-white/75 text-[12px]">Our own pools. The site keeps {bpsText(venue.siteFeeBps)} of each swap, paid to the venue's treasury in the same transaction.</p>

        <div className="rounded-xl bg-black/45 p-3 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-white/70">
            <span>You pay</span>
            {balance !== null && (
              <button type="button" className="underline underline-offset-2 min-h-[32px]" onClick={() => setText(amountText(balance, from.decimals, 18).replace(/,/g, ''))}>
                Balance {amountText(balance, from.decimals)} {from.symbol}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              inputMode="decimal" autoComplete="off" placeholder="0.0" aria-label={`Amount of ${from.symbol} to pay`}
              value={text} onChange={(e) => setText(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-white text-[22px] outline-none" data-testid="hyperevm-swap-amount"
            />
            <CoinSelect label="Coin you pay" value={from} onChange={pickFrom} tokens={coins} />
          </div>
          {tooMuch && <p className="text-amber-300/90 text-[11px]">More than this wallet holds.</p>}
        </div>

        <div className="flex justify-center -my-1">
          <button type="button" onClick={flip} aria-label="Swap the two coins" className="min-h-[36px] min-w-[36px] rounded-full bg-black/55 text-white/80" style={{ border: '1px solid rgba(255,255,255,0.18)' }}>↓</button>
        </div>

        <div className="rounded-xl bg-black/45 p-3 space-y-2">
          <div className="text-[11px] text-white/70">You get</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 text-white text-[22px] truncate" data-testid="hyperevm-swap-out">
              {best ? amountText(best.out, to.decimals) : quote && !quote.ok && quote.why === 'loading' ? '…' : '0'}
            </div>
            <CoinSelect label="Coin you get" value={to} onChange={pickTo} tokens={coins} />
          </div>
        </div>

        {[from, to].filter((t) => t.unlisted).map((t) => <CoinLine key={t.address} token={t} />)}

        <QuoteNote quote={quote} poolsUnread={poolsState.status === 'unread'} noPools={pools !== null && pools.length === 0} />

        {best && minOut !== null && (
          <div className="space-y-1 text-[12px]">
            <Line label="At least" value={`${amountText(minOut, to.decimals)} ${to.symbol}`} />
            <Line label="Site fee" value={`${amountText(best.siteFee.amount, best.siteFee.token.decimals)} ${best.siteFee.token.symbol} (${bpsText(venue.siteFeeBps)}) to the treasury`} />
            <Line label="Pool fee" value={split?.venue ? `${feeTierText(best.pool.fee)}: ${split.lps} to LPs, ${split.venue} to the venue` : `${feeTierText(best.pool.fee)}, all to LPs`} />
            {impact >= IMPACT_WARN_BPS && <Line label="Price impact" value={bpsText(impact)} tone="warn" />}
          </div>
        )}

        <div className="flex items-center gap-2 text-[11px] text-white/70">
          <span>Slippage</span>
          {SLIPPAGE_CHOICES.map((b) => (
            <button key={b} type="button" aria-pressed={slippageBps === b} onClick={() => setSlippageBps(b)} className="min-h-[32px] px-2.5 rounded-full" style={slippageBps === b ? { background: 'rgba(139,92,246,0.35)', color: '#fff' } : { background: 'rgba(0,0,0,0.4)' }}>
              {bpsText(b)}
            </button>
          ))}
        </div>

        <SwapAction
          send={send} best={best !== null} blocked={tooMuch || amountIn === null}
          review={review} onReview={() => setReview(true)} onBack={() => setReview(false)} onSwap={sendSwap}
          reviewBody={best && minOut !== null ? (
            <div className="rounded-xl bg-black/55 p-3 space-y-1.5 text-[12px]" data-testid="hyperevm-swap-review">
              <div className="text-white font-semibold text-[13px]">Review</div>
              <Line label="You pay" value={`${amountText(best.amountIn, from.decimals)} ${from.symbol}`} />
              <Line label="You get at least" value={`${amountText(minOut, to.decimals)} ${to.symbol}`} />
              <Line label="Site fee" value={`${amountText(best.siteFee.amount, best.siteFee.token.decimals)} ${best.siteFee.token.symbol}, to the treasury Safe`} />
              <Line label="Pool" value={<a className="underline break-all" href={hyperEvmAddressUrl(best.pool.address)} target="_blank" rel="noopener noreferrer">{best.pool.address}</a>} mono />
              <Line label="Router" value={venue.universalRouter} mono />
              <Line label="Treasury" value={venue.treasury} mono />
            </div>
          ) : null}
        />
        <SendStatus state={send.state} />

        <FinePrint summary="How this swap works">
          <p>The quote is our QuoterV2's, for our pools of these two coins at every fee tier; the pool that pays you most is used. Your wallet signs one transaction to our Universal Router (Uniswap's v2.2.0, unchanged), which swaps in that pool and pays the site fee to the treasury Safe. If you would get less than "At least", the swap is refused and nothing moves.</p>
          <p>The site fee is taken from the HYPE going in when you pay in HYPE, and from the coin going in when you buy a coin off the site's list; otherwise from the coin coming out. Selling a coin first asks your wallet to let Permit2 (Uniswap's approval contract) move exactly this amount, then to sign a permit for the router that lasts 30 minutes.</p>
          <p>The pool fee goes to the pool's LPs. Where the venue's cut is on for that pool, a fixed share of it goes to the treasury, read from the pool itself. Gas is paid in HYPE.</p>
        </FinePrint>
        <FinePrint summary="The coins">
          {coins.map((t) => <CoinLine key={t.address} token={t} />)}
        </FinePrint>
      </div>
    </section>
  );
}

/** The venue's 1/n on the side this trade pays its fee in (the coin going in). */
function sideShare(q: { pool: { token0: HyperEvmToken; venueShare0: number; venueShare1: number }; from: HyperEvmToken }): number {
  const inSide = q.from.isNative ? WHYPE : q.from.address;
  return inSide.toLowerCase() === q.pool.token0.address.toLowerCase() ? q.pool.venueShare0 : q.pool.venueShare1;
}

function QuoteNote({ quote, poolsUnread, noPools }: { quote: QuoteResult | { ok: false; why: 'loading' } | null; poolsUnread: boolean; noPools: boolean }) {
  let text: string | null = null;
  if (poolsUnread) text = 'Our pools could not be read just now.';
  else if (noPools) text = 'No pools are open on HyperEVM yet.';
  else if (quote && !quote.ok) {
    text = {
      loading: null,
      zero: null,
      'same-coin': 'Pick two different coins.',
      wrap: 'HYPE and WHYPE are one coin: wrap or unwrap it in your wallet.',
      'no-pool': 'We have no pool of these two coins with liquidity.',
      unread: 'The quote could not be read just now. Try again in a moment.',
    }[quote.why];
  }
  return text ? <p className="text-white/75 text-[12px]" role="status">{text}</p> : null;
}

function SwapAction(p: {
  send: ReturnType<typeof useHyperEvmSend>; best: boolean; blocked: boolean; review: boolean;
  onReview: () => void; onBack: () => void; onSwap: () => void; reviewBody: ReactNode;
}) {
  const btn = PRIMARY_BTN;
  const style = PRIMARY_STYLE;
  const working = p.send.state.kind === 'wallet' || p.send.state.kind === 'mining';
  if (!p.send.isConnected) return <p className="text-white/75 text-[12px]">Connect a wallet to swap.</p>;
  if (!p.send.onChain) return <button type="button" className={btn} style={style} onClick={() => void p.send.switchToHyperEvm()}>Switch wallet to HyperEVM</button>;
  if (!p.review) return <button type="button" className={btn} style={style} disabled={!p.best || p.blocked || working} onClick={p.onReview} data-testid="hyperevm-swap-review-button">Review swap</button>;
  return (
    <div className="space-y-2">
      {p.reviewBody}
      <div className="flex gap-2">
        <button type="button" className="min-h-[48px] px-4 rounded-xl text-[13px] text-white/80 bg-black/45" onClick={p.onBack} disabled={working}>Back</button>
        <button type="button" className={btn} style={style} disabled={!p.best || p.blocked || working} onClick={p.onSwap} data-testid="hyperevm-swap-send">Swap</button>
      </div>
    </div>
  );
}
