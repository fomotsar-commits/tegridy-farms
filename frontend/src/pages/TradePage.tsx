import { useState, useEffect } from 'react';
import { m } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import { useAccount, useChainId } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { getTxUrl } from '../lib/explorer';
import { pageArt } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { useSwap } from '../hooks/useSwap';
import { formatTokenAmount } from '../lib/formatting';
import { DCATab } from '../components/swap/DCATab';
import { LimitOrderTab } from '../components/swap/LimitOrderTab';
import { LiquidityTab } from '../components/swap/LiquidityTab';
import { TokenSelectModal } from '../components/swap/TokenSelectModal';
import { ArtImg } from '../components/ArtImg';

type Tab = 'swap' | 'liquidity' | 'dca' | 'limit';

const TAB_LABELS: Record<Tab, string> = {
  swap: 'Swap',
  liquidity: 'Liquidity',
  dca: 'DCA',
  limit: 'Limit',
};

export default function TradePage() {
  usePageTitle('Trade', 'Swap tokens, provide liquidity, and schedule DCA/limit orders on Tegridy Farms.');
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const location = useLocation();
  // Initialize tab from the pathname — /liquidity lands on the Liquidity tab.
  const [tab, setTab] = useState<Tab>(() => (location.pathname.startsWith('/liquidity') ? 'liquidity' : 'swap'));
  const [showTokenSelect, setShowTokenSelect] = useState<'from' | 'to' | null>(null);
  const [showRouteDetails, setShowRouteDetails] = useState(false);

  useEffect(() => { trackPageView('trade'); }, []);
  useEffect(() => {
    if (location.pathname.startsWith('/liquidity')) setTab('liquidity');
    else if (location.pathname.startsWith('/swap')) setTab(prev => (prev === 'liquidity' ? 'swap' : prev));
  }, [location.pathname]);

  const swap = useSwap();

  const handleTokenSelect = (token: typeof swap.fromToken) => {
    if (!token) return;
    if (showTokenSelect === 'from') swap.setFromToken(token);
    else if (showTokenSelect === 'to') swap.setToToken(token);
    setShowTokenSelect(null);
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="trade" idx={0} fallbackPosition="center 15%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[600px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        <m.div className="mb-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl text-white tracking-tight mb-1">Trade</h1>
          <p className="text-white text-[13px]">Swap tokens with smart routing across Tegridy DEX, Uniswap, and 7 aggregators</p>
        </m.div>

        {/* Tab Toggle */}
        <div className="flex gap-1.5 mb-6 p-1 rounded-2xl overflow-x-auto" style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}>
          {(['swap', 'liquidity', 'dca', 'limit'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
              className="flex-1 px-3 md:px-4 py-2.5 min-h-[44px] rounded-xl text-[13px] md:text-sm font-medium transition-all whitespace-nowrap text-white"
              style={tab === t ? {
                background: 'var(--color-stan)',
                boxShadow: '0 4px 12px var(--color-stan-40)',
              } : undefined}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {/* Swap Tab */}
        {tab === 'swap' && (
          <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={1} fallbackPosition="center 15%" alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative p-5 flex flex-col min-h-[640px]">
            {!isConnected ? (
              <div className="text-center py-8 my-auto">
                <p className="text-white text-[13px] mb-4" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Connect your wallet to swap</p>
                <ConnectButton />
              </div>
            ) : (
              <>
                {/* From Token */}
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Pay</span>
                    <span className="text-white text-[10px] font-mono" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Balance: {Number(swap.fromBalance).toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
                    <button onClick={() => setShowTokenSelect('from')} className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
                      {swap.fromToken?.logoURI && <img src={swap.fromToken.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                      <span className="text-white font-medium text-[14px]">{swap.fromToken?.symbol ?? 'Select'}</span>
                      <span className="text-white/80">▾</span>
                    </button>
                    <input
                      type="number" inputMode="decimal" placeholder="0.0"
                      value={swap.inputAmount} onChange={(e) => swap.setInputAmount(e.target.value)}
                      className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0"
                    />
                  </div>
                </div>

                {/* Flip Button — solid Stan blue + thick white ring so it pops
                    against any art the Swap card is layered over. */}
                <div className="flex justify-center -my-2 relative z-10">
                  <button onClick={swap.flipDirection}
                    aria-label="Swap From/To tokens"
                    className="w-11 h-11 rounded-full flex items-center justify-center transition-all"
                    style={{
                      background: 'var(--color-stan)',
                      border: '2px solid rgba(255,255,255,0.95)',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.70), 0 0 0 4px rgba(6,12,26,0.85)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = 'rotate(180deg) scale(1.05)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'rotate(0deg) scale(1)'; }}
                  >
                    <span className="text-white text-[18px] font-bold leading-none">&#8645;</span>
                  </button>
                </div>

                {/* To Token */}
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Receive</span>
                    <span className="text-white text-[10px] font-mono" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Balance: {Number(swap.toBalance).toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
                    <button onClick={() => setShowTokenSelect('to')} className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
                      {swap.toToken?.logoURI && <img src={swap.toToken.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                      <span className="text-white font-medium text-[14px]">{swap.toToken?.symbol ?? 'Select'}</span>
                      <span className="text-white/80">▾</span>
                    </button>
                    <div className="flex-1 text-right text-white text-[20px] font-mono font-medium">
                      {swap.isQuoteLoading ? '...' : swap.outputFormatted ? formatTokenAmount(swap.outputFormatted) : '0.0'}
                    </div>
                  </div>
                </div>

                {/* Slippage tolerance — always visible so users can see + adjust
                    before a quote loads. Fills the empty mid-card space.
                    swap.slippage is a percent (0-20), not bps. */}
                <div className="mt-1 mb-1 px-3 py-2.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Slippage tolerance</span>
                    <span className="text-white/80 text-[10px] font-mono">{swap.slippage.toFixed(2)}%</span>
                  </div>
                  <div className="flex gap-1.5">
                    {[0.1, 0.5, 1.0, 2.0].map(pct => (
                      <button key={pct} onClick={() => swap.setSlippage(pct)} aria-pressed={Math.abs(swap.slippage - pct) < 0.001}
                        className="flex-1 py-1.5 min-h-[34px] rounded-lg text-[11px] font-medium transition-all text-white"
                        style={{
                          background: Math.abs(swap.slippage - pct) < 0.001 ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                          border: Math.abs(swap.slippage - pct) < 0.001 ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                        }}>
                        {pct < 1 ? pct.toFixed(1) : pct.toFixed(1)}%
                      </button>
                    ))}
                  </div>
                </div>

                {/* Route Info — dark panel with Stan blue edge for trading-trust signal.
                    Always renders; shows placeholder text when no amount entered so the
                    card never feels empty mid-swap. */}
                {swap.routeLabel && swap.inputAmount ? (
                  <div className="mt-1 px-3 py-2.5 rounded-lg text-[11px]" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid var(--color-stan-40)' }}>
                    <div className="flex justify-between">
                      <span className="text-white">Route</span>
                      <span className="font-medium" style={{ color: 'var(--color-stan)' }}>{swap.routeLabel}</span>
                    </div>
                    {swap.priceImpact > 0 && (
                      <div className="flex justify-between mt-1">
                        <span className="text-white">Price Impact</span>
                        <span className={`font-mono ${swap.priceImpact > 3 ? 'text-red-300 font-semibold' : 'text-white'}`}>{swap.priceImpact.toFixed(2)}%</span>
                      </div>
                    )}
                    {swap.minimumReceived && (
                      <div className="flex justify-between mt-1">
                        <span className="text-white">Min. Received</span>
                        <span className="text-white font-mono">{formatTokenAmount(swap.minimumReceived)} {swap.toToken?.symbol}</span>
                      </div>
                    )}
                    {swap.priceImpact > 5 && (
                      <div className="mt-2 px-2 py-1.5 rounded text-[10px] text-red-200 font-semibold" style={{ background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.45)' }}>
                        High price impact! Consider reducing your trade size.
                      </div>
                    )}
                    {swap.allAggQuotes && swap.allAggQuotes.length > 0 && (
                      <div className="mt-2">
                        <button onClick={() => setShowRouteDetails(!showRouteDetails)}
                          className="text-[10px] text-white/90 hover:text-white underline underline-offset-2 transition-colors">
                          {showRouteDetails ? 'Hide route details' : `Compare all ${swap.allAggQuotes.length + 2} routes`}
                        </button>
                        {showRouteDetails && (
                          <div className="mt-2 space-y-1">
                            {swap.hasTegridyPair && swap.tegridyOutputFormatted && (
                              <div className="flex justify-between text-[10px] px-2 py-1 rounded" style={{ background: swap.selectedRoute === 'tegridy' ? 'rgba(16,185,129,0.20)' : 'rgba(255,255,255,0.04)' }}>
                                <span className="text-white/85">Tegridy DEX {swap.selectedRoute === 'tegridy' && <span className="text-emerald-300 ml-1">Best</span>}</span>
                                <span className="text-white font-mono">{formatTokenAmount(swap.tegridyOutputFormatted)}</span>
                              </div>
                            )}
                            {swap.uniOutputFormatted && (
                              <div className="flex justify-between text-[10px] px-2 py-1 rounded" style={{ background: swap.selectedRoute === 'uniswap' ? 'rgba(16,185,129,0.20)' : 'rgba(255,255,255,0.04)' }}>
                                <span className="text-white/85">Uniswap V2 {swap.selectedRoute === 'uniswap' && <span className="text-emerald-300 ml-1">Best</span>}</span>
                                <span className="text-white font-mono">{formatTokenAmount(swap.uniOutputFormatted)}</span>
                              </div>
                            )}
                            {swap.allAggQuotes.map((q: { source: string; amountOut: string }) => (
                              <div key={q.source} className="flex justify-between text-[10px] px-2 py-1 rounded"
                                style={{ background: swap.selectedRoute === 'aggregator' && swap.bestAggregatorName === q.source ? 'rgba(16,185,129,0.20)' : 'rgba(255,255,255,0.04)' }}>
                                <span className="text-white/85">{q.source} {swap.selectedRoute === 'aggregator' && swap.bestAggregatorName === q.source && <span className="text-emerald-300 ml-1">Best</span>}</span>
                                <span className="text-white font-mono">{formatTokenAmount(q.amountOut)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-1 px-3 py-2.5 rounded-lg text-[11px]" style={{ background: 'rgba(0,0,0,0.50)', border: '1px solid rgba(255,255,255,0.10)' }}>
                    <div className="flex justify-between text-white/70">
                      <span>Route</span>
                      <span>Enter an amount</span>
                    </div>
                    <div className="flex justify-between text-white/70 mt-1">
                      <span>Price Impact</span>
                      <span>&mdash;</span>
                    </div>
                    <div className="flex justify-between text-white/70 mt-1">
                      <span>Min. Received</span>
                      <span>&mdash;</span>
                    </div>
                  </div>
                )}

                {/* Spacer — pushes the action button to the bottom of the tall card. */}
                <div className="flex-1 min-h-[8px]" />

                {/* Action Button — sits directly on the art, matching the Liquidity tab's pattern. */}
                {swap.needsApproval ? (
                  <button onClick={swap.approve} disabled={swap.isPending}
                    className="w-full btn-primary py-3 min-h-[48px] text-[15px] font-semibold rounded-xl"
                  >
                    {swap.isPending ? 'Approving...' : `Approve ${swap.fromToken?.symbol}`}
                  </button>
                ) : (
                  <button onClick={swap.executeSwap}
                    disabled={swap.isPending || swap.isConfirming || swap.insufficientBalance || !swap.inputAmount || swap.outputAmount === 0n}
                    className="w-full btn-primary py-3 min-h-[48px] text-[15px] font-semibold rounded-xl disabled:opacity-40"
                  >
                    {swap.isPending ? 'Confirm in wallet...' : swap.isConfirming ? 'Confirming...' : swap.insufficientBalance ? 'Insufficient balance' : 'Swap'}
                  </button>
                )}

                {swap.isSuccess && swap.txHash && (
                  <div className="mt-3 text-center text-emerald-400 text-[12px]">
                    Swap confirmed! <a href={getTxUrl(chainId, swap.txHash)} target="_blank" rel="noopener noreferrer" className="underline">View on Explorer</a>
                  </div>
                )}
              </>
            )}
            </div>
          </m.div>
        )}

        {/* Liquidity Tab */}
        {tab === 'liquidity' && (
          <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid var(--color-purple-12)' }}>
            <LiquidityTab />
          </m.div>
        )}

        {/* DCA Tab */}
        {tab === 'dca' && (
          <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={2} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative">
              <DCATab />
            </div>
          </m.div>
        )}

        {/* Limit Order Tab */}
        {tab === 'limit' && (
          <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={3} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative">
              <LimitOrderTab />
            </div>
          </m.div>
        )}
      </div>

      {/* Token Select Modal */}
      {showTokenSelect && (
        <TokenSelectModal
          open={true}
          onSelect={handleTokenSelect}
          onClose={() => setShowTokenSelect(null)}
          disabledAddress={showTokenSelect === 'from' ? swap.toToken?.address : swap.fromToken?.address}
          customTokens={swap.customTokens}
          onAddCustomToken={swap.addCustomToken}
        />
      )}
    </div>
  );
}
