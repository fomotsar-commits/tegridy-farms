import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount, useBalance } from 'wagmi';
import { formatEther } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useSwap } from '../hooks/useSwap';
import { useToweliPrice } from '../hooks/useToweliPrice';
import { formatTokenAmount, formatCurrency } from '../lib/formatting';
import { ART } from '../lib/artConfig';
import { GECKOTERMINAL_URL, GECKOTERMINAL_EMBED, UNISWAP_BUY_URL, TOWELI_TOTAL_SUPPLY } from '../lib/constants';

export default function SwapPage() {
  const { isConnected, address } = useAccount();
  const { data: ethBalance } = useBalance({ address });
  const swap = useSwap();
  const price = useToweliPrice();
  const [showSettings, setShowSettings] = useState(false);
  const [customSlippage, setCustomSlippage] = useState('');
  const [showImpactConfirm, setShowImpactConfirm] = useState(false);

  const fromToken = swap.direction === 'buy' ? 'ETH' : 'TOWELI';
  const toToken = swap.direction === 'buy' ? 'TOWELI' : 'ETH';
  const fromBalance = swap.direction === 'buy'
    ? (ethBalance ? formatEther(ethBalance.value) : '0')
    : formatEther(swap.toweliBalance);

  const getButtonLabel = () => {
    if (!isConnected) return 'Connect Wallet';
    if (swap.isSuccess) return 'Swap Successful';
    if (swap.isConfirming) return 'Confirming...';
    if (swap.isPending) return 'Confirm in Wallet...';
    if (!swap.inputAmount || parseFloat(swap.inputAmount) <= 0) return 'Enter Amount';
    if (swap.insufficientBalance) return 'Insufficient Balance';
    if (swap.needsApproval) return `Approve ${fromToken}`;
    return 'Swap';
  };

  const handleAction = () => {
    if (!isConnected) return;
    if (swap.needsApproval) {
      swap.approve();
    } else {
      // If price impact > 10%, show confirmation dialog first
      if (swap.priceImpact > 10 && !showImpactConfirm) {
        setShowImpactConfirm(true);
        return;
      }
      setShowImpactConfirm(false);
      swap.executeSwap();
    }
  };

  const handleSlippageChange = (val: string) => {
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0 && num <= 50) {
      swap.setSlippage(num);
      setCustomSlippage(val);
    } else if (val === '') {
      setCustomSlippage('');
    }
  };

  const handlePresetSlippage = (s: number) => {
    swap.setSlippage(s);
    setCustomSlippage('');
  };

  // FDV = Fully Diluted Valuation (total supply * price)
  const fdv = price.isLoaded && price.priceInUsd > 0 ? formatCurrency(TOWELI_TOTAL_SUPPLY * price.priceInUsd) : '–';

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.boxingRing.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.2) 25%, rgba(0,0,0,0.4) 55%, rgba(0,0,0,0.7) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[960px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Swap</h1>
          <p className="text-white/50 text-[14px]">Trade ETH &#8596; TOWELI via Uniswap V2 Router</p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-5">
          {/* Left: Token Info */}
          <motion.div className="space-y-4" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <div className="rounded-xl p-5" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="flex items-center gap-4 mb-4">
                <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0" style={{ border: '1px solid rgba(139,92,246,0.15)' }}>
                  <img src={ART.bobowelie.src} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <h2 className="heading-luxury text-[18px] text-white">TOWELI</h2>
                    <span className="text-white/40 text-[12px]">/ WETH</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="stat-value text-[20px] text-primary">{price.isLoaded ? formatCurrency(price.priceInUsd, 6) : '–'}</span>
                    <span className={`text-[12px] ${price.oracleStale ? 'text-danger' : 'text-white/40'}`}>
                      ETH: {price.ethUsd > 0 ? formatCurrency(price.ethUsd, 0) : '–'}{price.oracleStale ? ' (stale)' : ''}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  { l: 'FDV', v: fdv },
                  { l: 'Pair', v: 'Uniswap V2' },
                  { l: 'Chain', v: 'Ethereum' },
                ].map((s) => (
                  <div key={s.l} className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                    <p className="text-white/30 text-[10px] uppercase tracking-wider mb-0.5">{s.l}</p>
                    <p className="stat-value text-[13px] text-white">{s.v}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* GeckoTerminal Chart */}
            <div className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)', height: '280px' }}>
              <iframe
                src={GECKOTERMINAL_EMBED}
                className="w-full h-full border-0"
                title="GeckoTerminal Chart"
                allow="clipboard-write"
                loading="lazy"
              />
            </div>

            {/* Quick links */}
            <div className="grid grid-cols-2 gap-3">
              <a href={UNISWAP_BUY_URL} target="_blank" rel="noopener noreferrer"
                className="rounded-xl p-4 flex items-center justify-between group"
                style={{ background: 'rgba(6,12,26,0.82)', border: '1px solid rgba(139,92,246,0.12)', backdropFilter: 'blur(8px)' }}>
                <div>
                  <p className="text-[13px] font-medium text-white group-hover:text-primary transition-colors">Uniswap</p>
                  <p className="text-white/30 text-[11px]">Trade directly</p>
                </div>
                <span className="text-white/30 text-[14px] group-hover:text-primary transition-colors">&#8594;</span>
              </a>
              <a href={GECKOTERMINAL_URL} target="_blank" rel="noopener noreferrer"
                className="rounded-xl p-4 flex items-center justify-between group"
                style={{ background: 'rgba(6,12,26,0.82)', border: '1px solid rgba(139,92,246,0.12)', backdropFilter: 'blur(8px)' }}>
                <div>
                  <p className="text-[13px] font-medium text-white group-hover:text-primary transition-colors">GeckoTerminal</p>
                  <p className="text-white/30 text-[11px]">Live chart</p>
                </div>
                <span className="text-white/30 text-[14px] group-hover:text-primary transition-colors">&#8594;</span>
              </a>
            </div>
          </motion.div>

          {/* Right: Swap Card */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <div className="sticky top-20 rounded-xl p-5" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(16px)', border: '1px solid rgba(139,92,246,0.15)' }}>
              <div className="flex items-center justify-between mb-4">
                <span className="heading-luxury text-[16px] text-white">Swap</span>
                <button onClick={() => setShowSettings(!showSettings)}
                  aria-label="Swap settings"
                  className="text-[12px] font-mono text-white/40 hover:text-primary transition-colors cursor-pointer px-2 py-1 rounded-md"
                  style={{ background: showSettings ? 'rgba(139,92,246,0.06)' : 'transparent' }}>
                  &#9881; {swap.slippage}%
                </button>
              </div>

              <AnimatePresence>
                {showSettings && (
                  <motion.div className="rounded-lg p-3 mb-4" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                    <p className="text-white/40 text-[11px] mb-2">Slippage Tolerance</p>
                    <div className="flex gap-1.5 mb-2">
                      {[1, 3, 5, 10].map((s) => (
                        <button key={s} onClick={() => handlePresetSlippage(s)}
                          className="flex-1 py-1.5 rounded-md text-[12px] font-medium cursor-pointer transition-all"
                          style={{
                            background: swap.slippage === s && !customSlippage ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)',
                            color: swap.slippage === s && !customSlippage ? 'var(--color-primary)' : 'rgba(255,255,255,0.4)',
                            border: swap.slippage === s && !customSlippage ? '1px solid rgba(139,92,246,0.30)' : '1px solid rgba(255,255,255,0.06)',
                          }}>
                          {s}%
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="number" value={customSlippage} onChange={(e) => handleSlippageChange(e.target.value)}
                        placeholder="Custom" min="0.1" max="50" step="0.1"
                        className="flex-1 bg-transparent text-[12px] font-mono text-white outline-none px-2 py-1.5 rounded-md"
                        style={{ border: '1px solid rgba(255,255,255,0.08)' }} />
                      <span className="text-white/40 text-[12px]">%</span>
                    </div>
                    <p className="text-white/40 text-[11px] mt-3 mb-1">Transaction Deadline</p>
                    <div className="flex items-center gap-2">
                      <input type="number" value={swap.deadline} onChange={(e) => {
                        const v = parseInt(e.target.value);
                        if (v > 0 && v <= 30) swap.setDeadline(v);
                      }}
                        min="1" max="30"
                        className="w-16 bg-transparent text-[12px] font-mono text-white outline-none px-2 py-1.5 rounded-md"
                        style={{ border: '1px solid rgba(255,255,255,0.08)' }} />
                      <span className="text-white/40 text-[12px]">minutes</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Oracle staleness warning */}
              {price.oracleStale && (
                <div className="rounded-lg p-2.5 mb-3 text-[11px] text-danger"
                  style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.20)' }}>
                  Price oracle data is stale. Prices may be inaccurate.
                </div>
              )}

              <div className="rounded-lg p-4 mb-1.5" style={{ background: 'rgba(139,92,246,0.03)', border: '1px solid rgba(139,92,246,0.08)' }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-white/40 text-[12px]">You pay</span>
                  <button onClick={() => swap.setInputAmount(fromBalance)}
                    className="text-[11px] text-white/30 hover:text-primary transition-colors cursor-pointer">
                    Bal: <span className="font-mono">{formatTokenAmount(fromBalance)}</span>
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  <input type="number" value={swap.inputAmount} onChange={(e) => swap.setInputAmount(e.target.value)}
                    placeholder="0.00" aria-label={`Amount of ${fromToken} to swap`}
                    className="flex-1 bg-transparent font-mono text-2xl text-white outline-none token-input" />
                  <div className="px-3 py-1.5 rounded-lg text-[13px] font-semibold text-white"
                    style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)' }}>
                    {fromToken}
                  </div>
                </div>
              </div>

              <div className="flex justify-center -my-3 relative z-10">
                <motion.button onClick={swap.flipDirection}
                  aria-label="Flip swap direction"
                  className="w-9 h-9 rounded-full flex items-center justify-center cursor-pointer shadow-lg"
                  style={{ background: 'rgba(6,12,26,0.9)', border: '1px solid rgba(139,92,246,0.20)' }}
                  whileHover={{ rotate: 180 }} transition={{ duration: 0.25 }}>
                  <span className="text-primary text-[14px]">&#8597;</span>
                </motion.button>
              </div>

              <div className="rounded-lg p-4 mt-1.5 mb-4" style={{ background: 'rgba(139,92,246,0.03)', border: '1px solid rgba(139,92,246,0.08)' }}>
                <div className="mb-2.5">
                  <span className="text-white/40 text-[12px]">You receive</span>
                </div>
                <div className="flex items-center gap-3">
                  <p className="flex-1 font-mono text-2xl text-white/60">
                    {swap.outputFormatted && parseFloat(swap.outputFormatted) > 0
                      ? formatTokenAmount(swap.outputFormatted) : '0.00'}
                  </p>
                  <div className="px-3 py-1.5 rounded-lg text-[13px] font-semibold text-white"
                    style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)' }}>
                    {toToken}
                  </div>
                </div>
              </div>

              {swap.inputAmount && parseFloat(swap.inputAmount) > 0 && (
                <div className="rounded-lg p-3.5 mb-4 space-y-2" style={{ background: 'rgba(139,92,246,0.03)', border: '1px solid rgba(139,92,246,0.08)' }}>
                  <DetailRow label="Price Impact" value={`~${swap.priceImpact.toFixed(1)}%`}
                    warn={swap.priceImpact > 5} danger={swap.priceImpact > 15} />
                  <DetailRow label="Min. Received" value={`${formatTokenAmount(swap.minimumReceived)} ${toToken}`} />
                  <DetailRow label="Slippage" value={`${swap.slippage}%`} />
                  <DetailRow label="Deadline" value={`${swap.deadline} min`} />
                  <DetailRow label="Route" value={swap.direction === 'buy' ? 'ETH → WETH → TOWELI (Uniswap V2)' : 'TOWELI → WETH → ETH (Uniswap V2)'} />
                </div>
              )}

              {/* Price impact confirmation dialog */}
              {showImpactConfirm && (
                <div className="rounded-lg p-3.5 mb-4" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
                  <p className="text-danger text-[12px] font-semibold mb-2">High Price Impact Warning</p>
                  <p className="text-white/50 text-[11px] mb-3">
                    This swap has ~{swap.priceImpact.toFixed(1)}% price impact. You will receive significantly fewer tokens than the market rate.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => { setShowImpactConfirm(false); swap.executeSwap(); }}
                      className="flex-1 py-2 rounded-md text-[12px] font-semibold cursor-pointer text-danger"
                      style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.30)' }}>
                      Swap Anyway
                    </button>
                    <button onClick={() => setShowImpactConfirm(false)}
                      className="flex-1 py-2 rounded-md text-[12px] font-semibold cursor-pointer text-white/60"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Transaction error display */}
              {(swap.writeError || swap.isTxError) && (
                <div className="rounded-lg p-3 mb-3 text-[11px] text-danger"
                  style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                  {swap.writeError?.message?.includes('user rejected')
                    ? 'Transaction rejected in wallet'
                    : swap.writeError?.message?.slice(0, 120) || 'Transaction failed'}
                </div>
              )}

              {isConnected ? (
                <button onClick={handleAction}
                  disabled={swap.isPending || swap.isConfirming || swap.insufficientBalance || (!swap.inputAmount || parseFloat(swap.inputAmount) <= 0)}
                  className={`w-full py-3.5 rounded-[10px] text-[14px] font-semibold transition-all cursor-pointer
                    ${swap.isSuccess ? 'bg-success text-[#0a0a0f]' :
                      swap.insufficientBalance ? 'bg-danger/20 text-danger' :
                      swap.needsApproval ? 'bg-warning text-[#0a0a0f]' :
                      'btn-primary'}
                    ${swap.isPending || swap.isConfirming ? 'opacity-35 cursor-not-allowed' : ''}`}>
                  {getButtonLabel()}
                </button>
              ) : (
                <ConnectButton.Custom>
                  {({ openConnectModal, mounted }) => (
                    <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                      <button onClick={openConnectModal} className="btn-primary w-full py-3.5 text-[14px]">
                        Connect Wallet
                      </button>
                    </div>
                  )}
                </ConnectButton.Custom>
              )}

              <p className="text-white/25 text-[10px] text-center mt-3">
                Routed via Uniswap V2 · High slippage recommended
              </p>
            </div>
          </motion.div>
        </div>

        {/* How It Works */}
        <motion.div className="mt-8" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <h3 className="heading-luxury text-[16px] text-white mb-4">How It Works</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              { step: '01', title: 'Connect', desc: 'Connect your Ethereum wallet to get started. Works with MetaMask, WalletConnect, and more.', art: ART.busCrew.src },
              { step: '02', title: 'Swap', desc: 'Trade ETH for TOWELI or vice versa. Routed through Uniswap V2 for best execution.', art: ART.mumuBull.src },
              { step: '03', title: 'Earn', desc: 'Stake your TOWELI or provide liquidity to earn yield. Head to the Farm to start earning.', art: ART.forestScene.src },
            ].map((s, i) => (
              <motion.div key={s.step} className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
                initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }}>
                <div className="absolute inset-0">
                  <img src={s.art} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0" style={{
                    background: 'linear-gradient(to bottom, rgba(6,12,26,0.5) 0%, rgba(6,12,26,0.85) 40%, rgba(6,12,26,0.95) 100%)',
                  }} />
                </div>
                <div className="relative z-10 p-5">
                  <span className="stat-value text-[24px] text-primary/30">{s.step}</span>
                  <h4 className="text-white text-[14px] font-semibold mt-2 mb-1.5">{s.title}</h4>
                  <p className="text-white/40 text-[12px] leading-relaxed">{s.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Token Details */}
        <motion.div className="mt-6 rounded-xl p-5" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <h3 className="heading-luxury text-[15px] text-white mb-3">Token Details</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { l: 'Name', v: 'Towelie' },
              { l: 'Symbol', v: 'TOWELI' },
              { l: 'Chain', v: 'Ethereum' },
              { l: 'DEX', v: 'Uniswap V2' },
            ].map((d) => (
              <div key={d.l} className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.03)', border: '1px solid rgba(139,92,246,0.08)' }}>
                <p className="text-white/30 text-[10px] uppercase tracking-wider mb-0.5">{d.l}</p>
                <p className="stat-value text-[13px] text-white">{d.v}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, warn, danger }: { label: string; value: string; warn?: boolean; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/40 text-[12px]">{label}</span>
      <span className={`font-mono text-[12px] ${danger ? 'text-danger font-semibold' : warn ? 'text-danger' : 'text-white/60'}`}>{value}</span>
    </div>
  );
}
