import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { useCowSwap, type CowSwapRecord } from '../../hooks/useCowSwap';
import { CHAIN_ID, WETH_ADDRESS } from '../../lib/constants';
import { type ParsedCowSwapQuote } from '../../lib/cowSwap';
import { type TokenInfo } from '../../lib/tokenList';
import { formatTokenAmountGrouped } from '../../lib/formatting';

interface Props {
  fromToken: TokenInfo | null;
  toToken: TokenInfo | null;
  inputAmount: string;
  slippage: number; // percent (0–20)
  /** The best on-chain "You Receive" (human units) for an honest side-by-side. */
  onChainOutputFormatted?: string;
}

const QUOTE_DEBOUNCE_MS = 700;

/**
 * Opt-in "Swap via CoW" panel for the Swap tab. Routes the same trade through
 * CoW Protocol's batch auction instead of the public mempool: one gasless
 * signature, no sandwich surface, and an unfilled order costs nothing.
 *
 * Self-gating & honest-framing: it only shows a CoW quote when one actually
 * comes back (never a fabricated number), sells ERC-20s only (prompts the user
 * to wrap ETH), and shows the live CoW quote next to the on-chain quote so the
 * choice is transparent.
 */
export function CowSwapPanel({ fromToken, toToken, inputAmount, slippage, onChainOutputFormatted }: Props) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const cow = useCowSwap();

  const [quote, setQuote] = useState<ParsedCowSwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const reqIdRef = useRef(0);

  const isNativeSell = !!fromToken?.isNative;
  const onRightChain = chainId === CHAIN_ID;
  const samePair =
    !!fromToken && !!toToken && (fromToken.isNative ? WETH_ADDRESS : fromToken.address).toLowerCase() ===
      (toToken.isNative ? WETH_ADDRESS : toToken.address).toLowerCase();

  const parsedSellAmount = useMemo(() => {
    if (!fromToken || !inputAmount) return 0n;
    try {
      const n = parseFloat(inputAmount);
      if (!Number.isFinite(n) || n <= 0) return 0n;
      return parseUnits(inputAmount, fromToken.decimals);
    } catch {
      return 0n;
    }
  }, [fromToken, inputAmount]);

  // Eligible = connected, right chain, ERC-20 sell, distinct pair, positive amount.
  const eligible =
    isConnected && onRightChain && !isNativeSell && !samePair && !!fromToken && !!toToken && parsedSellAmount > 0n;

  // Debounced indicative CoW quote.
  useEffect(() => {
    if (!eligible || !fromToken || !toToken) {
      setQuote(null);
      setQuoteLoading(false);
      return;
    }
    const currentReq = ++reqIdRef.current;
    const controller = new AbortController();
    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      const sell = fromToken.isNative ? WETH_ADDRESS : fromToken.address;
      const buy = toToken.isNative ? WETH_ADDRESS : toToken.address;
      const q = await cow.getQuote(sell, buy, parsedSellAmount, controller.signal);
      if (controller.signal.aborted || reqIdRef.current !== currentReq) return;
      setQuote(q);
      setQuoteLoading(false);
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, fromToken, toToken, parsedSellAmount, cow.getQuote]);

  const buyDecimals = toToken?.decimals ?? 18;
  const cowOutHuman = quote ? formatUnits(quote.buyAmount, buyDecimals) : null;
  const cowBeatsOnChain = useMemo(() => {
    if (!cowOutHuman || !onChainOutputFormatted) return null;
    const a = parseFloat(cowOutHuman);
    const b = parseFloat(onChainOutputFormatted);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
    return a >= b;
  }, [cowOutHuman, onChainOutputFormatted]);

  const handleSwap = async () => {
    if (!fromToken || !toToken) return;
    await cow.placeSwap({
      sellToken: { symbol: fromToken.symbol, address: fromToken.address, decimals: fromToken.decimals },
      buyToken: {
        symbol: toToken.isNative ? 'WETH' : toToken.symbol,
        address: toToken.isNative ? WETH_ADDRESS : toToken.address,
        decimals: toToken.decimals,
      },
      sellAmount: parsedSellAmount,
      slippagePct: slippage,
    });
  };

  return (
    <div
      className="mt-1 mb-1 px-3 py-2.5 rounded-lg"
      style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Swap via CoW <span className="text-emerald-300">(MEV-protected)</span>
        </span>
        {quoteLoading && (
          <span className="text-white/60 text-[10px]" aria-live="polite">Quoting…</span>
        )}
      </div>
      <p className="mt-1 text-[10px] text-white/70" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
        Signs one gasless order that CoW’s solvers settle off the public mempool — no sandwich surface,
        and an unfilled order costs nothing.
      </p>

      {/* Self-gated states — honest, never a fake number. */}
      {isNativeSell ? (
        <p className="mt-2 text-[10px] text-amber-300" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
          CoW sells ERC-20s. Wrap ETH to WETH (Liquidity tab) to route this trade through CoW.
        </p>
      ) : !isConnected ? (
        <p className="mt-2 text-[10px] text-white/60">Connect your wallet to price a CoW swap.</p>
      ) : !onRightChain ? (
        <p className="mt-2 text-[10px] text-amber-300">Switch to Ethereum Mainnet to swap via CoW.</p>
      ) : parsedSellAmount === 0n ? (
        <p className="mt-2 text-[10px] text-white/50">Enter an amount above to see a CoW quote.</p>
      ) : (
        <>
          {quote && cowOutHuman ? (
            <div className="mt-2 px-2 py-1.5 rounded text-[10px]" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)' }}>
              <div className="flex justify-between">
                <span className="text-white/80">CoW quote</span>
                <span className="text-white font-mono">
                  {formatTokenAmountGrouped(cowOutHuman)} {toToken?.isNative ? 'WETH' : toToken?.symbol}
                </span>
              </div>
              {onChainOutputFormatted && (
                <div className="flex justify-between mt-0.5">
                  <span className="text-white/60">On-chain quote</span>
                  <span className="text-white/70 font-mono">{formatTokenAmountGrouped(onChainOutputFormatted)}</span>
                </div>
              )}
              {cowBeatsOnChain !== null && (
                <div className="mt-1 text-[10px]">
                  {cowBeatsOnChain ? (
                    <span className="text-emerald-300">CoW quotes at least the on-chain route — and settles MEV-protected.</span>
                  ) : (
                    <span className="text-white/60">On-chain quotes more here; CoW still avoids sandwich risk. Your call.</span>
                  )}
                </div>
              )}
              <p className="mt-1 text-white/50">Guaranteed minimum applies your {slippage}% slippage; solvers keep any surplus.</p>
            </div>
          ) : !quoteLoading ? (
            <p className="mt-2 text-[10px] text-white/50">No CoW quote for this pair/size right now.</p>
          ) : null}

          <button
            type="button"
            onClick={handleSwap}
            disabled={cow.isPlacing || !quote}
            className="mt-2 w-full py-2.5 min-h-[40px] rounded-lg text-[12px] font-semibold text-white transition-all disabled:opacity-50"
            style={{ background: 'var(--color-stan)', border: '1px solid var(--color-stan)' }}
          >
            {cow.isPlacing ? 'Placing on CoW…' : 'Swap via CoW'}
          </button>
        </>
      )}

      {/* Recent CoW swaps */}
      {cow.records.length > 0 && (
        <div className="mt-3 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.10)' }}>
          <p className="text-white/70 text-[9px] uppercase tracking-wider mb-1">Recent CoW swaps</p>
          {cow.records.slice(0, 4).map((r) => (
            <CowSwapRow key={r.uid} rec={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function CowSwapRow({ rec }: { rec: CowSwapRecord }) {
  const sell = Number(formatUnits(BigInt(rec.sellAmount), rec.sellToken.decimals));
  const filled = rec.status === 'fulfilled' || rec.status === 'traded';
  const dead = rec.status === 'cancelled' || rec.status === 'expired';
  const label = filled ? 'Filled' : rec.status === 'cancelled' ? 'Cancelled' : rec.status === 'expired' ? 'Expired' : 'Open';
  const color = filled ? 'text-success' : dead ? 'text-danger' : 'text-white/80';
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-white/80 text-[10px] font-mono truncate">
        {sell.toLocaleString(undefined, { maximumFractionDigits: 4 })} {rec.sellToken.symbol} → {rec.buyToken.symbol}
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <span className={`text-[9px] ${color}`}>{label}</span>
        <a
          href={`https://explorer.cow.fi/orders/${rec.uid}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-purple-400 hover:text-purple-300 text-[9px]"
        >
          View ↗
        </a>
      </span>
    </div>
  );
}
