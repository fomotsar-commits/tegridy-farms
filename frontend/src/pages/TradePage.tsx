import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { useSwap } from '../hooks/useSwap';
import { formatTokenAmount } from '../lib/formatting';
import { DCATab } from '../components/swap/DCATab';
import { LimitOrderTab } from '../components/swap/LimitOrderTab';
import { TokenSelectModal } from '../components/swap/TokenSelectModal';

type Tab = 'swap' | 'dca' | 'limit';

export default function TradePage() {
  usePageTitle('Trade', 'Swap tokens with smart routing across Tegridy DEX, Uniswap, and aggregator sources.');
  const { isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>('swap');
  const [showTokenSelect, setShowTokenSelect] = useState<'from' | 'to' | null>(null);
  const [showRouteDetails, setShowRouteDetails] = useState(false);

  useEffect(() => { trackPageView('trade'); }, []);

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
        <img src={ART.apeHug.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
      </div>

      <div className="relative z-10 max-w-[600px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        <motion.div className="mb-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl text-white tracking-tight mb-1">Trade</h1>
          <p className="text-white text-[13px]">Swap tokens with smart routing across Tegridy DEX, Uniswap, and 7 aggregators</p>
        </motion.div>

        {/* Tab Toggle */}
        <div className="flex gap-1.5 mb-6 p-1 rounded-2xl" style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}>
          {(['swap', 'dca', 'limit'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all ${tab === t ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'text-white hover:text-white'}`}
            >
              {t === 'swap' ? 'Swap' : t === 'dca' ? 'DCA' : 'Limit'}
            </button>
          ))}
        </div>

        {/* Swap Tab */}
        {tab === 'swap' && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card rounded-2xl p-5" style={{ border: '1px solid var(--color-purple-12)' }}>
            {!isConnected ? (
              <div className="text-center py-8">
                <p className="text-white/70 text-[13px] mb-4">Connect your wallet to swap</p>
                <ConnectButton />
              </div>
            ) : (
              <>
                {/* From Token */}
                <div className="mb-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-white/50 text-[11px]">You Pay</span>
                    <span className="text-white/40 text-[10px] font-mono">Balance: {Number(swap.fromBalance).toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <button onClick={() => setShowTokenSelect('from')} className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
                      {swap.fromToken?.logoURI && <img src={swap.fromToken.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                      <span className="text-white font-medium text-[14px]">{swap.fromToken?.symbol ?? 'Select'}</span>
                      <span className="text-white/40">▾</span>
                    </button>
                    <input
                      type="number" inputMode="decimal" placeholder="0.0"
                      value={swap.inputAmount} onChange={(e) => swap.setInputAmount(e.target.value)}
                      className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0"
                    />
                  </div>
                </div>

                {/* Flip Button */}
                <div className="flex justify-center -my-1 relative z-10">
                  <button onClick={swap.flipDirection} className="w-9 h-9 rounded-full bg-emerald-600/20 border border-emerald-600/40 flex items-center justify-center hover:bg-emerald-600/30 transition-colors">
                    <span className="text-white text-[16px]">↕</span>
                  </button>
                </div>

                {/* To Token */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-white/50 text-[11px]">You Receive</span>
                    <span className="text-white/40 text-[10px] font-mono">Balance: {Number(swap.toBalance).toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <button onClick={() => setShowTokenSelect('to')} className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
                      {swap.toToken?.logoURI && <img src={swap.toToken.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                      <span className="text-white font-medium text-[14px]">{swap.toToken?.symbol ?? 'Select'}</span>
                      <span className="text-white/40">▾</span>
                    </button>
                    <div className="flex-1 text-right text-white/70 text-[20px] font-mono">
                      {swap.isQuoteLoading ? '...' : swap.outputFormatted ? formatTokenAmount(swap.outputFormatted) : '0.0'}
                    </div>
                  </div>
                </div>

                {/* Route Info */}
                {swap.routeLabel && swap.inputAmount && (
                  <div className="mb-4 px-3 py-2 rounded-lg text-[11px]" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
                    <div className="flex justify-between text-white/50">
                      <span>Route</span>
                      <span className="text-emerald-400">{swap.routeLabel}</span>
                    </div>
                    {swap.priceImpact > 0 && (
                      <div className="flex justify-between text-white/50 mt-1">
                        <span>Price Impact</span>
                        <span className={swap.priceImpact > 3 ? 'text-red-400' : 'text-white/70'}>{swap.priceImpact.toFixed(2)}%</span>
                      </div>
                    )}
                    {swap.minimumReceived && (
                      <div className="flex justify-between text-white/50 mt-1">
                        <span>Min. Received</span>
                        <span className="text-white/70">{formatTokenAmount(swap.minimumReceived)} {swap.toToken?.symbol}</span>
                      </div>
                    )}
                    {swap.priceImpact > 5 && (
                      <div className="mt-2 px-2 py-1.5 rounded text-[10px] text-red-400 font-medium" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
                        High price impact! Consider reducing your trade size.
                      </div>
                    )}
                    {swap.allAggQuotes && swap.allAggQuotes.length > 0 && (
                      <div className="mt-2">
                        <button onClick={() => setShowRouteDetails(!showRouteDetails)}
                          className="text-[10px] text-white/40 hover:text-white/70 transition-colors">
                          {showRouteDetails ? 'Hide route details' : `Compare all ${swap.allAggQuotes.length + 2} routes`}
                        </button>
                        {showRouteDetails && (
                          <div className="mt-2 space-y-1">
                            {swap.hasTegridyPair && swap.tegridyOutputFormatted && (
                              <div className="flex justify-between text-[10px] px-2 py-1 rounded" style={{ background: swap.selectedRoute === 'tegridy' ? 'rgba(16,185,129,0.1)' : 'transparent' }}>
                                <span className="text-white/60">Tegridy DEX {swap.selectedRoute === 'tegridy' && <span className="text-emerald-400 ml-1">Best</span>}</span>
                                <span className="text-white/70 font-mono">{formatTokenAmount(swap.tegridyOutputFormatted)}</span>
                              </div>
                            )}
                            {swap.uniOutputFormatted && (
                              <div className="flex justify-between text-[10px] px-2 py-1 rounded" style={{ background: swap.selectedRoute === 'uniswap' ? 'rgba(16,185,129,0.1)' : 'transparent' }}>
                                <span className="text-white/60">Uniswap V2 {swap.selectedRoute === 'uniswap' && <span className="text-emerald-400 ml-1">Best</span>}</span>
                                <span className="text-white/70 font-mono">{formatTokenAmount(swap.uniOutputFormatted)}</span>
                              </div>
                            )}
                            {swap.allAggQuotes.map((q: { source: string; amountOut: string }) => (
                              <div key={q.source} className="flex justify-between text-[10px] px-2 py-1 rounded"
                                style={{ background: swap.selectedRoute === 'aggregator' && swap.bestAggregatorName === q.source ? 'rgba(16,185,129,0.1)' : 'transparent' }}>
                                <span className="text-white/60">{q.source} {swap.selectedRoute === 'aggregator' && swap.bestAggregatorName === q.source && <span className="text-emerald-400 ml-1">Best</span>}</span>
                                <span className="text-white/70 font-mono">{formatTokenAmount(q.amountOut)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Action Button */}
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

                {swap.isSuccess && (
                  <div className="mt-3 text-center text-emerald-400 text-[12px]">
                    Swap confirmed! <a href={`https://etherscan.io/tx/${swap.txHash}`} target="_blank" rel="noopener noreferrer" className="underline">View on Etherscan</a>
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}

        {/* DCA Tab */}
        {tab === 'dca' && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card rounded-2xl" style={{ border: '1px solid var(--color-purple-12)' }}>
            <DCATab />
          </motion.div>
        )}

        {/* Limit Order Tab */}
        {tab === 'limit' && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card rounded-2xl" style={{ border: '1px solid var(--color-purple-12)' }}>
            <LimitOrderTab />
          </motion.div>
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
