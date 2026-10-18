import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatUnits } from 'viem';
import { useAccount, useBalance, usePublicClient, useSendTransaction } from 'wagmi';
import { useTOWELIPriceOptional } from '../../contexts/PriceContext';
import { swapVenueOn } from '../../lib/chains/swapVenue';
import { getTxUrl } from '../../lib/explorer';
import { evmBasketFor, MIN_USD_PER_COIN, minOut, shortAmount, splitEvenly, usdText, usdToBaseUnits } from '../../lib/islandBasket';
import { buildEvmOrder, quoteEvmLegs, routeEvmLeg, type EvmLegQuote, type EvmLegRoute, type QuoteClient } from '../../lib/evm/islandBasketEvm';
import { extractErrorMessage, isUserRejection, surfaceReceiptNotice, waitForReceiptOutcome } from '../../lib/txErrors';
import { BasketCta, IslandBasketButton, IslandBasketDialog, type BasketRow, type RowTone } from './IslandBasket';

/** A quote older than this is asked for again while the order is open (the swap's own window). */
const REQUOTE_MS = 30_000;
/** While a price is missing, it is asked for again this soon. */
const RETRY_MS = 15_000;
/** How long the order's transactions stay valid once signed. */
const DEADLINE_SECS = 10 * 60;

type LegStatus = { tone: RowTone; text: string };

function venueWord(r: EvmLegRoute | undefined): string | null {
  if (!r) return null;
  if (r.via === 'ours') return 'Our pool';
  if (r.via === 'none') return r.why === 'unread' ? 'Price not read' : 'No pool answered';
  return r.pool.dex === 'uniswap-v3' ? 'Uniswap V3' : 'Uniswap V2';
}

/** The leg's route on fresh quotes is not the one shown, or pays less than its floor: the trader has not agreed to it. */
function moved(shown: EvmLegRoute | undefined, fresh: EvmLegRoute, slippageBps: number): boolean {
  if (!shown || shown.via === 'none' || fresh.via === 'none' || shown.via !== fresh.via) return true;
  const floor = minOut(shown.out, slippageBps);
  return floor === null || fresh.out < floor;
}

/**
 * The island order on Ethereum or Base: renders nothing on a chain with no island coins.
 * `slippagePct` is the swap form's own setting.
 */
export function IslandBasketEvm({ chainId, slippagePct }: { chainId: number; slippagePct: number }) {
  const coins = evmBasketFor(chainId);
  const venue = swapVenueOn(chainId);
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: balance, refetch: refetchBalance } = useBalance({ address, chainId, query: { enabled: !!address } });
  const { sendTransactionAsync } = useSendTransaction();
  // The price only sizes how much ETH the dollars are (the ETH figure is shown before anything is
  // signed, and every coin is held to its on-chain floor). So the feed's own heartbeat is fresh
  // enough: the 300 s window of `ethUsd` would leave the order unsized most of each hour.
  const ethUsd = useTOWELIPriceOptional()?.ethUsdForDisplay ?? 0;

  const [open, setOpen] = useState(false);
  const [usd, setUsd] = useState('10');
  const [quotes, setQuotes] = useState<{ key: string; legs: EvmLegQuote[]; at: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [running, setRunning] = useState(false);
  const [statuses, setStatuses] = useState<Record<number, LegStatus>>({});
  const [notice, setNotice] = useState<{ tone: RowTone; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  // The split a press bought with: it stands until the amount changes, so a new ETH price
  // never re-sizes, or wipes, the order on screen.
  const [frozen, setFrozen] = useState<{ usd: string; chainId: number; shares: bigint[] } | null>(null);
  const slippageBps = Math.round(slippagePct * 100);

  const n = coins?.length ?? 0;
  const dollars = Number(usd);
  const tooSmall = n > 0 && Number.isFinite(dollars) && dollars > 0 && dollars < MIN_USD_PER_COIN * n;
  const computed = useMemo(() => {
    const t = tooSmall ? null : usdToBaseUnits(usd, ethUsd > 0 ? ethUsd : null, 18);
    return t !== null && n > 0 ? splitEvenly(t, n) : null;
  }, [usd, ethUsd, tooSmall, n]);
  const shares = frozen && frozen.usd === usd && frozen.chainId === chainId ? frozen.shares : computed;
  const total = shares ? shares.reduce((s, x) => s + x, 0n) : null;
  // The order these quotes are for: a figure for another amount or chain is never shown as this one's.
  const orderKey = shares ? `${chainId}|${shares.join(',')}|${slippageBps}` : null;

  const client = useMemo<QuoteClient | null>(() => (publicClient
    ? {
        readContract: (a) => publicClient.readContract(a as never) as Promise<unknown>,
        simulateContract: (a) => publicClient.simulateContract(a as never) as Promise<{ result: unknown }>,
      }
    : null), [publicClient]);

  const legsFor = useCallback(
    () => (coins && shares ? coins.map((coin, i) => ({ coin, amountIn: shares[i]! })) : null),
    [coins, shares],
  );

  // Quote on open, on a new amount (after typing settles), and every REQUOTE_MS while idle.
  const latest = useRef(0);
  useEffect(() => {
    if (!open || running || !client || !venue || !orderKey) return;
    const legs = legsFor();
    if (!legs) return;
    const id = ++latest.current;
    const t = setTimeout(() => {
      setQuoting(true);
      void quoteEvmLegs(client, venue, legs).then((q) => {
        if (latest.current !== id) return;
        setQuotes({ key: orderKey, legs: q, at: Date.now() });
        setQuoting(false);
      });
    }, 500);
    return () => clearTimeout(t);
  }, [open, running, client, venue, orderKey, legsFor, tick]);
  // A new amount, chain or wallet is a new order: the last one's results go (never mid-run).
  const orderOf = `${usd}|${chainId}|${address ?? ''}`;
  const [resultsFor, setResultsFor] = useState(orderOf);
  if (resultsFor !== orderOf && !running) {
    setResultsFor(orderOf);
    setStatuses({});
    setNotice(null);
    setFrozen(null);
  }

  const shown = quotes && quotes.key === orderKey ? quotes.legs : null;
  const routes = useMemo(() => (shown ? shown.map((q) => routeEvmLeg(q, chainId)) : null), [shown, chainId]);
  // Asked again every REQUOTE_MS while idle, and every RETRY_MS while a price is missing: one
  // unread coin holds the whole order, so it is not left waiting a full round.
  const anyUnread = routes?.some((r) => r.via === 'none' && r.why === 'unread') ?? false;
  useEffect(() => {
    if (!open || running) return;
    const iv = setInterval(() => setTick((x) => x + 1), anyUnread ? RETRY_MS : REQUOTE_MS);
    return () => clearInterval(iv);
  }, [open, running, anyUnread]);

  if (!coins || !venue) return null;

  const mark = (legs: number[], s: LegStatus) => setStatuses((was) => ({ ...was, ...Object.fromEntries(legs.map((i) => [i, s])) }));

  async function buy() {
    if (!client || !publicClient || !venue || !address || !shown || !routes || running) return;
    const legs = legsFor();
    if (!legs) return;
    setRunning(true);
    setNotice(null);
    setStatuses({});
    if (shares) setFrozen({ usd, chainId, shares });
    const all = legs.map((_, i) => i);
    try {
      mark(all, { tone: 'busy', text: 'Checking prices…' });
      // Fresh quotes, held to the ones shown: a price that moved past slippage is shown, never sent.
      const fresh = await quoteEvmLegs(client, venue, legs);
      const freshRoutes = fresh.map((q) => routeEvmLeg(q, chainId));
      if (freshRoutes.some((r, i) => moved(routes[i], r, slippageBps))) {
        if (orderKey) setQuotes({ key: orderKey, legs: fresh, at: Date.now() });
        setStatuses({});
        setNotice({ tone: 'warn', text: freshRoutes.some((r) => r.via === 'none')
          ? 'A price could not be read just now, so nothing was sent. Press again.'
          : 'Prices moved since they were shown, so nothing was sent. Check the new figures and press again.' });
        return;
      }
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECS);
      const order = buildEvmOrder({ venue, quotes: fresh, routes: freshRoutes, recipient: address, slippageBps, deadline });
      if (!order) {
        setStatuses({});
        setNotice({ tone: 'err', text: 'The order could not be built from these prices, so nothing was sent.' });
        return;
      }
      // The test run: every transaction is estimated as this wallet before the first prompt.
      mark(all, { tone: 'busy', text: 'Test run…' });
      let gas = 0n;
      for (const tx of order) {
        try {
          gas += await publicClient.estimateGas({ account: address, to: tx.to, data: tx.data, value: tx.value });
        } catch (e) {
          setStatuses({});
          setNotice({ tone: 'err', text: `The order failed its test run, so nothing was sent (${extractErrorMessage(e, 'no reason given').slice(0, 140)}).` });
          return;
        }
      }
      let perGas: bigint | null = null;
      try {
        const fees = await publicClient.estimateFeesPerGas();
        perGas = fees.maxFeePerGas ?? fees.gasPrice ?? null;
      } catch { /* the wallet prices gas itself; only the balance check below is skipped */ }
      const spend = order.reduce((s, tx) => s + tx.value, 0n);
      const have = balance?.value ?? null;
      if (have !== null && perGas !== null && have < spend + gas * perGas) {
        setStatuses({});
        setNotice({ tone: 'err', text: `Not enough ETH: this order needs about ${Number(formatUnits(spend + gas * perGas, 18)).toFixed(5)} ETH with the network fee.` });
        return;
      }
      mark(all, { tone: 'muted', text: 'Waiting' });
      for (let k = 0; k < order.length; k++) {
        const tx = order[k]!;
        mark(tx.legs, { tone: 'busy', text: 'At your wallet…' });
        let hash: `0x${string}`;
        try {
          hash = await sendTransactionAsync({ chainId, to: tx.to, data: tx.data, value: tx.value });
        } catch (e) {
          const declined = isUserRejection(e);
          mark(tx.legs, { tone: declined ? 'muted' : 'err', text: declined ? 'You declined' : 'Not sent' });
          mark(order.slice(k + 1).flatMap((t) => t.legs), { tone: 'muted', text: 'Not sent' });
          if (!declined) setNotice({ tone: 'err', text: `Your wallet did not send it (${extractErrorMessage(e, 'no reason given').slice(0, 140)}).` });
          return;
        }
        mark(tx.legs, { tone: 'busy', text: 'Confirming…' });
        const outcome = await waitForReceiptOutcome(publicClient, hash);
        const view = { label: 'View', onClick: () => window.open(getTxUrl(chainId, hash), '_blank', 'noopener,noreferrer') };
        const names = tx.legs.map((i) => fresh[i]!.coin.symbol).join(', ');
        if (outcome.kind === 'success') {
          mark(tx.legs, { tone: 'ok', text: 'Bought' });
          toast.success(`Bought ${names}`, { action: view });
        } else if (outcome.kind === 'reverted') {
          mark(tx.legs, { tone: 'err', text: 'Refused on chain' });
          toast.error('Refused on chain', { description: `${names}: nothing was bought; only the network fee was spent. Usually a price moved past your slippage.`, action: view });
        } else {
          // Unread or replaced: nothing is known, or what ran was not this. Stop here and say so.
          mark(tx.legs, { tone: 'warn', text: outcome.kind === 'replaced' ? 'Replaced in your wallet' : 'Sent, not confirmed' });
          mark(order.slice(k + 1).flatMap((t) => t.legs), { tone: 'muted', text: 'Not sent' });
          surfaceReceiptNotice(toast, outcome, { hash, chainId, repeatCost: 'buying again buys these coins a second time.' });
          return;
        }
      }
    } finally {
      setRunning(false);
      void refetchBalance();
      setTick((x) => x + 1);
    }
  }

  const rows: BasketRow[] = coins.map((coin, i) => {
    const r = routes?.[i];
    const out = r && r.via !== 'none' ? r.out : null;
    return {
      key: `${coin.room}-${coin.token}`,
      symbol: coin.symbol,
      tag: coin.bridged ? `from ${coin.bridged.from === 'ethereum' ? 'Ethereum' : 'Solana'}` : undefined,
      venue: venueWord(r),
      pays: out !== null ? `≈ ${shortAmount(Number(formatUnits(out, coin.decimals)))}` : quoting || (!shown && orderKey) ? null : '–',
      status: statuses[i],
    };
  });

  const ours = routes?.flatMap((r, i) => (r.via === 'ours' ? [i] : [])) ?? [];
  const oursFee = ours.length ? shown?.[ours[0]!]?.ours?.feeBps : undefined;
  const feeLine = ours.length && oursFee !== undefined
    ? `${ours.map((i) => coins[i]!.symbol).join(', ')} through our pool: its ${(Number(oursFee) / 100).toFixed(2)}% site fee goes to the venue. The rest go through Uniswap: no site fee, the venue earns nothing on them.`
    : 'No site fee: every coin goes through Uniswap, so the venue earns nothing on this order. Uniswap’s pool fee is inside each quote.';

  const perCoin = Number.isFinite(dollars) && dollars > 0 && n > 0 ? dollars / n : 0;
  const summary = total !== null ? `${n} coins · ${usdText(perCoin)} each · ≈ ${Number(formatUnits(total, 18)).toFixed(5)} ETH` : null;
  const unread = routes?.some((r) => r.via === 'none') ?? false;
  const insufficient = total !== null && balance !== undefined && balance.value < total;

  let label = `Buy all ${n}`;
  let disabled = false;
  if (running) [label, disabled] = ['Buying…', true];
  else if (!isConnected) [label, disabled] = ['Connect a wallet to buy', true];
  else if (!dollars) [label, disabled] = ['Enter an amount', true];
  else if (tooSmall) [label, disabled] = [`Enter at least ${usdText(MIN_USD_PER_COIN * n)}`, true];
  else if (ethUsd <= 0) [label, disabled] = ['ETH price unavailable', true];
  else if (insufficient) [label, disabled] = ['Not enough ETH', true];
  else if (!routes || quoting) [label, disabled] = ['Getting prices…', true];
  else if (unread) [label, disabled] = ['A price could not be read', true];

  const shownNotice = notice
    ?? (ethUsd <= 0 && dollars > 0 && !tooSmall ? { tone: 'warn' as const, text: 'The ETH price could not be read, so the order cannot be sized right now.' } : null)
    ?? (unread && !quoting ? { tone: 'warn' as const, text: 'A price could not be read. It is asked again in a moment.', action: { label: 'Try again', onClick: () => setTick((x) => x + 1) } } : null);
  const v2Leg = routes?.some((r) => r.via === 'v2-router') ?? false;
  const oursLeg = ours.length > 0;
  const txCount = (routes?.some((r) => r.via === 'batch') ? 1 : 0) + (routes?.filter((r) => r.via !== 'batch' && r.via !== 'none').length ?? 0);

  return (
    <>
      <IslandBasketButton count={n} onOpen={() => setOpen(true)} />
      <IslandBasketDialog
        open={open}
        onClose={() => setOpen(false)}
        closable={!running}
        chainName={venue.name}
        usd={usd}
        setUsd={setUsd}
        locked={running}
        summary={summary}
        rows={rows}
        feeLine={feeLine}
        notice={shownNotice}
        cta={<BasketCta label={label} disabled={disabled} onClick={() => void buy()} />}
        after={txCount > 1 && !running ? <span className="text-white/60 text-[10px]">{txCount} wallet prompts for this order.</span> : null}
        finePrint={
          <>
            <p>Every pool here was read on chain. The order quotes each coin’s pools, takes the one that pays most, and takes our own pool when it pays at least as much after its fee, the same rule as the swap.</p>
            <p>The coins Uniswap carries go in one transaction through Uniswap’s own router. If any of them would get less than its minimum, that whole transaction is refused and none of them is bought.{v2Leg ? ' Uniswap’s router on Base cannot reach V2 pools, so a coin whose best pool is V2 is a second transaction.' : ''}{oursLeg ? ' A coin bought in our pool is its own transaction, through the same router as the swap.' : ''}</p>
            {coins.some((c) => c.bridged) && <p>TOWELI and RIZZ here are the Wormhole copies of the coins on Ethereum and Solana: Wormhole’s bridge contract names both.</p>}
            <p>Slippage is your swap setting ({slippagePct.toFixed(2)}%). The amount is split at the ETH price from Chainlink. At least {usdText(MIN_USD_PER_COIN)} a coin, so fees do not eat the buy. You also pay the network fee; your wallet shows it.</p>
          </>
        }
      />
    </>
  );
}
