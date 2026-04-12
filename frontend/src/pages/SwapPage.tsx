import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useSwap } from '../hooks/useSwap';
import { useToweliPrice } from '../hooks/useToweliPrice';
import { formatTokenAmount, formatCurrency } from '../lib/formatting';
import { GECKOTERMINAL_URL, GECKOTERMINAL_EMBED, UNISWAP_BUY_URL, TOWELI_TOTAL_SUPPLY, TOWELI_ADDRESS, TOWELI_WETH_LP_ADDRESS, CHAIN_ID } from '../lib/constants';
import { TokenSelectModal } from '../components/swap/TokenSelectModal';
import { LimitOrderTab } from '../components/swap/LimitOrderTab';
import { DCATab } from '../components/swap/DCATab';
import { DEFAULT_TOKENS, type TokenInfo } from '../lib/tokenList';
import { ART } from '../lib/artConfig';
import { trackSwap, trackPageView } from '../lib/analytics';
import { formatUnits } from 'viem';
import { AGGREGATOR_NAMES } from '../lib/aggregator';

const AGGREGATOR_NAMES_MAP = AGGREGATOR_NAMES;
import { usePoints } from '../hooks/usePoints';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { Sparkline } from '../components/Sparkline';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import { useConfetti } from '../hooks/useConfetti';

export default function SwapPage() {
  const { isConnected } = useAccount();
  const swap = useSwap();
  const price = useToweliPrice();
  const priceHistory = usePriceHistory(price.priceInUsd);
  const { history: priceData, error: priceError } = priceHistory;
  const points = usePoints();
  const nft = useNFTBoost();
  const swapLoggedRef = useRef<string | null>(null);
  const { showReceipt } = useTransactionReceipt();
  const confetti = useConfetti();
  const receiptShownRef = useRef<string | null>(null);

  // Log swap points when swap succeeds
  useEffect(() => {
    if (swap.isSuccess && swap.fromToken && swapLoggedRef.current !== swap.outputFormatted) {
      swapLoggedRef.current = swap.outputFormatted;
      points.logAction('swap', nft.holdsGoldCard);
      trackSwap(swap.fromToken.symbol, swap.toToken!.symbol, swap.inputAmount, swap.selectedRoute ?? 'unknown');
    }
  }, [swap.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show transaction receipt on swap success
  useEffect(() => {
    if (swap.isSuccess && swap.fromToken && swap.toToken && receiptShownRef.current !== swap.outputFormatted) {
      receiptShownRef.current = swap.outputFormatted;
      const fromAmt = swap.inputAmount;
      const toAmt = swap.outputFormatted;
      const rateNum = parseFloat(toAmt) / (parseFloat(fromAmt) || 1);
      showReceipt({
        type: 'swap',
        data: {
          fromToken: swap.fromToken.symbol,
          fromAmount: fromAmt,
          toToken: swap.toToken.symbol,
          toAmount: toAmt,
          rate: `1 ${swap.fromToken.symbol} = ${formatTokenAmount(rateNum.toString(), 2)} ${swap.toToken.symbol}`,
          fee: swap.selectedRoute === 'tegridy' ? '0%' : '0.3%',
          slippage: `${swap.slippage}%`,
          txHash: swap.txHash ?? undefined,
        },
      });
      confetti.fire();
    }
  }, [swap.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showSettings, setShowSettings] = useState(false);
  const [customSlippage, setCustomSlippage] = useState('');
  const [showImpactConfirm, setShowImpactConfirm] = useState(false);
  const [mobileChartOpen, setMobileChartOpen] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [tokenSelectSide, setTokenSelectSide] = useState<'from' | 'to' | null>(null);
  const [activeTab, setActiveTab] = useState<'swap' | 'limit' | 'dca'>('swap');

  // Analytics: track page view on mount
  useEffect(() => { trackPageView('swap'); }, []);

  // Deferred iframe rendering
  useEffect(() => {
    const t = setTimeout(() => setShowChart(true), 500);
    return () => clearTimeout(t);
  }, []);

  // Initialize default tokens (ETH → TOWELI)
  useEffect(() => {
    if (!swap.fromToken) {
      const eth = DEFAULT_TOKENS.find(t => t.symbol === 'ETH');
      if (eth) swap.setFromToken(eth);
    }
    if (!swap.toToken) {
      const toweli = DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI');
      if (toweli) swap.setToToken(toweli);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getButtonLabel = () => {
    if (!isConnected) return 'Connect Wallet';
    if (!swap.fromToken || !swap.toToken) return 'Select Tokens';
    if (swap.isSuccess) return 'Swap Successful';
    if (swap.isConfirming) return 'Confirming...';
    if (swap.isPending) return 'Confirm in Wallet...';
    if (!swap.inputAmount || parseFloat(swap.inputAmount) <= 0) return 'Enter Amount';
    if (swap.insufficientBalance) return `Insufficient ${swap.fromToken.symbol} Balance`;
    if (swap.needsApproval) return `Approve ${swap.fromToken.symbol}`;
    return 'Swap';
  };

  const handleAction = () => {
    if (!isConnected) return;
    if (swap.needsApproval) {
      swap.approve();
    } else {
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
    if (!isNaN(num) && num > 0 && num <= 20) {
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

  const handleTokenSelect = (token: TokenInfo) => {
    if (tokenSelectSide === 'from') {
      // If selecting same token as "to", swap them
      if (swap.toToken && token.address.toLowerCase() === swap.toToken.address.toLowerCase()) {
        swap.flipDirection();
      } else {
        swap.setFromToken(token);
      }
    } else {
      if (swap.fromToken && token.address.toLowerCase() === swap.fromToken.address.toLowerCase()) {
        swap.flipDirection();
      } else {
        swap.setToToken(token);
      }
    }
    swap.setInputAmount('');
    setTokenSelectSide(null);
  };

  const fdv = price.isLoaded && price.priceInUsd > 0 ? formatCurrency(TOWELI_TOTAL_SUPPLY * price.priceInUsd) : '–';
  const isReady = swap.fromToken && swap.toToken;
  const canSwap = isConnected && isReady && swap.inputAmount && parseFloat(swap.inputAmount) > 0 && !swap.insufficientBalance && !swap.isPending && !swap.isConfirming;

  // Dynamic chart: pick the non-native token to display. Prefer TOWELI if in the pair.
  const chartToken = useMemo(() => {
    const tokens = [swap.fromToken, swap.toToken].filter(Boolean) as TokenInfo[];
    // If TOWELI is one of them, always show TOWELI chart
    const toweli = tokens.find(t => t.address.toLowerCase() === TOWELI_ADDRESS.toLowerCase());
    if (toweli) return { token: toweli, isToweli: true };
    // Otherwise pick the non-ETH/non-WETH token
    const nonNative = tokens.find(t => !t.isNative && t.symbol !== 'WETH');
    if (nonNative) return { token: nonNative, isToweli: false };
    // Fallback to WETH
    const weth = tokens.find(t => t.symbol === 'WETH');
    if (weth) return { token: weth, isToweli: false };
    return null;
  }, [swap.fromToken, swap.toToken]);

  // For TOWELI we use the known pool address for a better chart, for others use token address
  const chartEmbedUrl = useMemo(() => {
    if (!chartToken) return GECKOTERMINAL_EMBED;
    if (chartToken.isToweli) {
      return `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}?embed=1&info=0&swaps=0&light_chart=0`;
    }
    return `https://www.geckoterminal.com/eth/tokens/${chartToken.token.address}?embed=1&info=0&swaps=0&light_chart=0`;
  }, [chartToken]);

  const chartGeckoUrl = useMemo(() => {
    if (!chartToken) return GECKOTERMINAL_URL;
    if (chartToken.isToweli) {
      return `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}`;
    }
    return `https://www.geckoterminal.com/eth/tokens/${chartToken.token.address}`;
  }, [chartToken]);

  return (
    <div className="-mt-14 relative min-h-screen">
      {/* Art background */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.apeHug.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.4) 25%, rgba(0,0,0,0.65) 55%, rgba(0,0,0,0.88) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-20 pb-12">
        {/* Page header */}
        <motion.div className="mb-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Swap</h1>
          <p className="text-white/50 text-[13px]">Trade any token via Uniswap V2</p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px] gap-4 items-stretch">

        {/* Left column: unified chart card */}
        <motion.div className="flex flex-col" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="rounded-2xl overflow-hidden flex flex-col flex-1"
            style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}>

            {/* Token header bar */}
            {chartToken && (
              <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid rgba(139,92,246,0.08)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ border: '1px solid rgba(139,92,246,0.12)', background: 'rgba(139,92,246,0.06)' }}>
                    {chartToken.token.logoURI ? (
                      <img src={chartToken.token.logoURI} alt="" className="w-full h-full object-cover"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <span className="text-[11px] font-bold text-white/40">{chartToken.token.symbol.slice(0, 2)}</span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-white text-[15px] font-semibold">{chartToken.token.symbol}</span>
                      {chartToken.isToweli && <span className="text-white/30 text-[12px]">/ WETH</span>}
                      {!chartToken.isToweli && <span className="text-white/30 text-[12px]">{chartToken.token.name}</span>}
                    </div>
                    {chartToken.isToweli && (
                      <div className="flex items-center gap-2">
                        <span className="stat-value text-[14px] text-primary">{price.isLoaded ? formatCurrency(price.priceInUsd, 6) : '–'}</span>
                        {priceData.length > 1 ? <Sparkline data={priceData} width={48} height={16} /> : priceError && <span className="text-white/30 text-[10px]">Price data unavailable</span>}
                        {price.isLoaded && <span className="text-white/25 text-[11px]">FDV {fdv}</span>}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <a href={UNISWAP_BUY_URL} target="_blank" rel="noopener noreferrer"
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white/40 hover:text-primary transition-colors"
                    style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                    Uniswap &#8599;
                  </a>
                  <a href={chartGeckoUrl} target="_blank" rel="noopener noreferrer"
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white/40 hover:text-primary transition-colors"
                    style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                    GeckoTerminal &#8599;
                  </a>
                </div>
              </div>
            )}

            {/* Chart — collapsible on mobile, always visible on desktop */}
            <div className="lg:hidden px-3 py-2" style={{ borderBottom: '1px solid rgba(139,92,246,0.06)' }}>
              <button onClick={() => setMobileChartOpen(!mobileChartOpen)}
                className="text-[11px] text-white/40 hover:text-primary transition-colors cursor-pointer w-full text-left flex items-center justify-between">
                <span>{mobileChartOpen ? 'Hide Chart' : 'Show Chart'}</span>
                <span>{mobileChartOpen ? '▲' : '▼'}</span>
              </button>
            </div>
            <div className={`flex-1 min-h-[280px] md:min-h-[400px] ${mobileChartOpen ? '' : 'hidden lg:block'}`}>
              {CHAIN_ID !== 1 ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                  <span className="text-white/30 text-[14px]">Chart unavailable on testnet</span>
                  <span className="text-white/15 text-[11px]">GeckoTerminal only supports mainnet pools</span>
                </div>
              ) : showChart ? (
                <iframe
                  key={chartEmbedUrl}
                  src={chartEmbedUrl}
                  className="w-full h-full border-0"
                  title={`${chartToken?.token.symbol ?? 'Token'} Chart`}
                  allow="clipboard-write"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-white/20 text-[13px]">Loading chart...</span>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* Right column: Swap Card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        {/* Main Swap Card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="sticky top-20 rounded-2xl overflow-hidden relative glass-card-animated card-hover"
          style={{
            border: '1px solid rgba(139,92,246,0.15)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.3), 0 0 1px rgba(139,92,246,0.2)',
          }}
        >
          <div className="absolute inset-0">
            <img src={ART.chaosScene.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.40) 0%, rgba(6,12,26,0.75) 50%, rgba(6,12,26,0.92) 100%)' }} />
          </div>
          {/* Card Header with Tabs */}
          <div className="relative z-10">
          <div className="flex items-center justify-between px-5 pt-4 pb-1">
            <div className="flex items-center gap-1">
              {(['swap', 'limit', 'dca'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold cursor-pointer transition-all ${activeTab === tab ? 'text-white' : 'text-white/30 hover:text-white/50'}`}
                  style={{ background: activeTab === tab ? 'rgba(139,92,246,0.10)' : 'transparent' }}>
                  {tab === 'swap' ? 'Swap' : tab === 'limit' ? 'Limit' : 'DCA'}
                </button>
              ))}
            </div>
            {activeTab === 'swap' && <button onClick={() => setShowSettings(!showSettings)}
              aria-label="Swap settings"
              className="flex items-center gap-1.5 text-[12px] font-mono text-white/40 hover:text-primary transition-colors cursor-pointer px-2.5 py-1 rounded-lg"
              style={{ background: showSettings ? 'rgba(139,92,246,0.08)' : 'transparent' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
              {swap.slippage}%
            </button>}
          </div>

          {/* Limit Order Tab */}
          {activeTab === 'limit' && <LimitOrderTab />}

          {/* DCA Tab */}
          {activeTab === 'dca' && <DCATab />}

          {/* Swap Tab Content */}
          {activeTab === 'swap' && <>
          {/* Settings Panel */}
          <AnimatePresence>
            {showSettings && (
              <motion.div className="mx-5 rounded-xl p-3.5 mb-2" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}
                initial={{ opacity: 0, height: 0, marginBottom: 0 }} animate={{ opacity: 1, height: 'auto', marginBottom: 8 }} exit={{ opacity: 0, height: 0, marginBottom: 0 }}>
                <p className="text-white/40 text-[11px] font-medium uppercase tracking-wider mb-2.5">Slippage Tolerance</p>
                <div className="flex gap-1.5 mb-2.5">
                  {[1, 3, 5, 10].map((s) => (
                    <button key={s} onClick={() => handlePresetSlippage(s)}
                      className="flex-1 py-2 rounded-lg text-[12px] font-semibold cursor-pointer transition-all"
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
                  <input type="number" inputMode="decimal" value={customSlippage} onChange={(e) => handleSlippageChange(e.target.value)}
                    placeholder="Custom" min="0.1" max="20" step="0.1"
                    className="flex-1 bg-transparent text-[12px] font-mono text-white outline-none px-3 py-2 min-h-[44px] rounded-lg"
                    style={{ border: '1px solid rgba(255,255,255,0.08)' }} />
                  <span className="text-white/40 text-[12px]">%</span>
                </div>
                {swap.slippage > 5 && (
                  <p className="text-[11px] mt-1.5" style={{ color: '#f59e0b' }}>
                    High slippage — you may receive significantly less tokens
                  </p>
                )}
                <p className="text-white/40 text-[11px] font-medium uppercase tracking-wider mt-3.5 mb-2">Tx Deadline</p>
                <div className="flex items-center gap-2">
                  <input type="number" inputMode="decimal" value={swap.deadline} onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (v > 0 && v <= 30) swap.setDeadline(v);
                  }}
                    min="1" max="30"
                    className="w-16 bg-transparent text-[12px] font-mono text-white outline-none px-3 py-2 min-h-[44px] rounded-lg"
                    style={{ border: '1px solid rgba(255,255,255,0.08)' }} />
                  <span className="text-white/40 text-[12px]">minutes</span>
                </div>
                <p className="text-white/40 text-[11px] font-medium uppercase tracking-wider mt-3.5 mb-2">Token Approval</p>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-white/50 text-[12px]">Unlimited approval</span>
                  <button
                    onClick={() => swap.toggleUnlimitedApproval(!swap.unlimitedApproval)}
                    className={`w-9 h-5 rounded-full transition-colors relative cursor-pointer ${swap.unlimitedApproval ? 'bg-primary' : 'bg-white/10'}`}>
                    <div className={`w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-transform ${swap.unlimitedApproval ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                  </button>
                </label>
                {swap.unlimitedApproval && (
                  <p className="text-white/25 text-[10px] mt-1">Approve once per token. Standard on Uniswap.</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* YOU PAY */}
          <div className="mx-5 rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)' }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-white/40 text-[12px] font-medium">You pay</span>
              {swap.fromToken && (
                <button onClick={() => swap.setInputAmount(swap.fromBalance)}
                  className="text-[11px] text-white/30 hover:text-primary transition-colors cursor-pointer">
                  Balance: <span className="font-mono">{formatTokenAmount(swap.fromBalance)}</span>
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <input type="number" inputMode="decimal" value={swap.inputAmount} onChange={(e) => swap.setInputAmount(e.target.value)}
                placeholder="0" aria-label="Amount to swap"
                className="flex-1 bg-transparent font-mono text-[24px] text-white outline-none token-input min-w-0 min-h-[44px]" />
              <TokenButton token={swap.fromToken} onClick={() => setTokenSelectSide('from')} />
            </div>
            {swap.inputAmount && parseFloat(swap.inputAmount) > 0 && (() => {
              const amt = parseFloat(swap.inputAmount);
              const usd = swap.fromToken?.isNative || swap.fromToken?.symbol === 'WETH'
                ? amt * price.ethUsd
                : swap.fromToken?.symbol === 'TOWELI' ? amt * price.priceInUsd : 0;
              return usd > 0 ? <p className="text-white/25 text-[11px] font-mono mt-1">(${formatCurrency(usd)})</p> : null;
            })()}
          </div>

          {/* FLIP BUTTON */}
          <div className="flex justify-center -my-3 relative z-10">
            <motion.button onClick={swap.flipDirection}
              aria-label="Flip swap direction"
              className="w-10 h-10 rounded-xl flex items-center justify-center cursor-pointer"
              style={{
                background: 'linear-gradient(135deg, #0f1a2e 0%, #0a1020 100%)',
                border: '1px solid rgba(139,92,246,0.20)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              }}
              whileHover={{ rotate: 180, scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.25 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
                <path d="M7 4v16m0 0l-4-4m4 4l4-4M17 20V4m0 0l4 4m-4-4l-4 4" />
              </svg>
            </motion.button>
          </div>

          {/* YOU RECEIVE */}
          <div className="mx-5 rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)' }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-white/40 text-[12px] font-medium">You receive</span>
              {swap.toToken && (
                <span className="text-[11px] text-white/20 font-mono">
                  Balance: {formatTokenAmount(swap.toBalance)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <p className="flex-1 font-mono text-[24px] text-white/60 min-w-0 overflow-hidden text-ellipsis">
                {swap.isQuoteLoading && parsedInputGt0(swap.inputAmount) ? (
                  <span className="text-white/20">Loading...</span>
                ) : swap.outputFormatted && parseFloat(swap.outputFormatted) > 0
                  ? formatTokenAmount(swap.outputFormatted) : '0'}
              </p>
              <TokenButton token={swap.toToken} onClick={() => setTokenSelectSide('to')} />
            </div>
            {swap.outputFormatted && parseFloat(swap.outputFormatted) > 0 && (() => {
              const amt = parseFloat(swap.outputFormatted);
              const usd = swap.toToken?.isNative || swap.toToken?.symbol === 'WETH'
                ? amt * price.ethUsd
                : swap.toToken?.symbol === 'TOWELI' ? amt * price.priceInUsd : 0;
              return usd > 0 ? <p className="text-white/25 text-[11px] font-mono mt-1">(${formatCurrency(usd)})</p> : null;
            })()}
          </div>

          {/* ROUTE + DETAILS */}
          {isReady && swap.inputAmount && parseFloat(swap.inputAmount) > 0 && (
            <motion.div
              className="mx-5 mt-3 rounded-xl overflow-hidden"
              style={{ border: '1px solid rgba(139,92,246,0.08)' }}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
            >
              {/* Route visualization */}
              <div className="px-4 py-3" style={{ background: 'rgba(139,92,246,0.03)' }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white/30 text-[11px] font-medium uppercase tracking-wider">Route</span>
                  <span className={`text-[10px] font-mono ${swap.selectedRoute === 'tegridy' ? 'text-green-400/60' : swap.selectedRoute === 'aggregator' ? 'text-cyan-400/60' : 'text-white/25'}`}>{swap.routeLabel}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {swap.routeDescription.map((symbol, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <RouteChip symbol={symbol} isIntermediate={i === 1 && swap.routeDescription.length === 3} />
                      {i < swap.routeDescription.length - 1 && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/40 flex-shrink-0">
                          <path d="M5 12h14m-6-6l6 6-6 6" />
                        </svg>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-px" style={{ background: 'rgba(139,92,246,0.06)' }} />

              {/* Aggregator savings breakdown */}
              {swap.aggBetter && swap.aggOutputFormatted && (
                <div className="px-4 py-2.5 space-y-1.5" style={{ background: 'rgba(49,208,170,0.06)', borderBottom: '1px solid rgba(49,208,170,0.10)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-success text-[11px] font-medium">Best rate via {swap.bestAggregatorName ?? 'Aggregator'}</span>
                    <span className="text-success text-[10px] font-mono">+{swap.aggSpread.userSavingsBps / 100}% savings</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-white/30">Direct ({swap.selectedRoute === 'tegridy' ? 'Tegridy DEX' : 'Uniswap V2'})</span>
                    <span className="text-white/40 font-mono">{formatTokenAmount(String(swap.outputFormatted))} {swap.toToken!.symbol}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-white/30">{swap.bestAggregatorName ?? 'Aggregator'} route</span>
                    <span className="text-white/40 font-mono">{formatTokenAmount(swap.aggOutputFormatted)} {swap.toToken!.symbol}</span>
                  </div>
                  {swap.aggProtocolCaptureFormatted && (
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-white/20">Optimization fee</span>
                      <span className="text-white/25 font-mono">{formatTokenAmount(swap.aggProtocolCaptureFormatted)} {swap.toToken!.symbol}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-success/70 font-medium">You receive</span>
                    <span className="stat-value text-[11px] text-success">{swap.aggUserReceivesFormatted ? formatTokenAmount(swap.aggUserReceivesFormatted) : formatTokenAmount(swap.aggOutputFormatted)} {swap.toToken!.symbol}</span>
                  </div>
                  {/* Show all aggregator quotes */}
                  {swap.allAggQuotes.length > 1 && (
                    <div className="pt-1.5 mt-1 border-t border-white/5 space-y-0.5">
                      <span className="text-white/20 text-[9px] uppercase tracking-wider">All quotes ({swap.allAggQuotes.length} sources)</span>
                      {swap.allAggQuotes.map((q, i) => (
                        <div key={q.source} className="flex items-center justify-between text-[9px]">
                          <span className={i === 0 ? 'text-success/60' : 'text-white/20'}>{i === 0 ? '\u2713 ' : ''}{AGGREGATOR_NAMES_MAP[q.source] ?? q.source}</span>
                          <span className={i === 0 ? 'text-success/60 font-mono' : 'text-white/20 font-mono'}>{formatTokenAmount(formatUnits(BigInt(q.amountOut), swap.toToken!.decimals))} {swap.toToken!.symbol}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Swap details */}
              <div className="px-4 py-3 space-y-2">
                <DetailRow label="Price Impact" value={swap.path.length > 2 ? '~est.' : `~${swap.priceImpact.toFixed(2)}%`}
                  warn={swap.priceImpact > 5} danger={swap.priceImpact > 15} />
                <DetailRow label="Min. Received" value={`${formatTokenAmount(swap.minimumReceived ?? '0')} ${swap.toToken?.symbol ?? ''}`} />
                <DetailRow label="Slippage" value={`${swap.slippage}%`} />
                <DetailRow label="Deadline" value={`${swap.deadline} min`} />
              </div>
            </motion.div>
          )}

          {/* HIGH IMPACT WARNING */}
          {showImpactConfirm && (
            <div className="mx-5 mt-3 rounded-xl p-3.5" style={{ background: 'rgba(255,78,163,0.06)', border: '1px solid rgba(255,78,163,0.20)' }}>
              <p className="text-danger text-[12px] font-semibold mb-1.5">FAFO Mode — High Price Impact</p>
              <p className="text-white/40 text-[11px] mb-3">
                ~{swap.priceImpact.toFixed(1)}% price impact. You will receive significantly fewer tokens.
              </p>
              <div className="flex gap-2">
                <button onClick={() => { setShowImpactConfirm(false); swap.executeSwap(); }}
                  className="flex-1 py-2 rounded-lg text-[12px] font-semibold cursor-pointer text-danger"
                  style={{ background: 'rgba(255,78,163,0.10)', border: '1px solid rgba(255,78,163,0.25)' }}>
                  Swap Anyway
                </button>
                <button onClick={() => setShowImpactConfirm(false)}
                  className="flex-1 py-2 rounded-lg text-[12px] font-semibold cursor-pointer text-white/50"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* TX ERROR */}
          {(swap.writeError || swap.isTxError) && (
            <div className="mx-5 mt-3 rounded-xl p-3 text-[11px] text-danger"
              style={{ background: 'rgba(255,78,163,0.05)', border: '1px solid rgba(255,78,163,0.12)' }}>
              {swap.writeError?.message?.includes('user rejected')
                ? 'Transaction rejected in wallet'
                : swap.writeError?.message?.slice(0, 150) || 'Transaction failed'}
            </div>
          )}

          {/* ACTION BUTTON */}
          <div className="p-5 pt-4">
            {isConnected ? (
              <button onClick={handleAction}
                disabled={!canSwap && !swap.needsApproval}
                className={`w-full py-3.5 rounded-xl text-[14px] font-semibold transition-all cursor-pointer
                  ${swap.isSuccess ? 'bg-success text-[#0a0a0f]' :
                    swap.insufficientBalance ? 'bg-danger/15 text-danger border border-danger/20' :
                    swap.needsApproval ? 'bg-warning/90 text-[#0a0a0f]' :
                    'btn-primary'}
                  ${swap.isPending || swap.isConfirming ? 'opacity-35 cursor-not-allowed' : ''}
                  ${!canSwap && !swap.needsApproval ? 'opacity-35 cursor-not-allowed' : ''}`}>
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
          </div>
          </>}{/* end swap tab */}
          </div>{/* close relative z-10 */}
        </motion.div>
        </motion.div>

        </div>{/* close grid */}
      </div>

      {/* Token Select Modal */}
      <TokenSelectModal
        open={tokenSelectSide !== null}
        onClose={() => setTokenSelectSide(null)}
        onSelect={handleTokenSelect}
        disabledAddress={tokenSelectSide === 'from' ? swap.toToken?.address : swap.fromToken?.address}
        customTokens={swap.customTokens}
        onAddCustomToken={swap.addCustomToken}
      />
    </div>
  );
}

// ─── Sub-components ────────────────────────────

function TokenButton({ token, onClick }: { token: TokenInfo | null; onClick: () => void }) {
  if (!token) {
    return (
      <button onClick={onClick}
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[14px] font-semibold cursor-pointer transition-all"
        style={{
          background: 'linear-gradient(135deg, rgba(139,92,246,0.20) 0%, rgba(139,92,246,0.12) 100%)',
          border: '1px solid rgba(139,92,246,0.30)',
          color: 'var(--color-primary)',
        }}>
        Select
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    );
  }

  return (
    <button onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-xl text-[14px] font-semibold cursor-pointer transition-all hover:bg-white/[0.03] flex-shrink-0"
      style={{
        background: 'rgba(139,92,246,0.06)',
        border: '1px solid rgba(139,92,246,0.12)',
        color: 'white',
      }}>
      {token.logoURI && (
        <img src={token.logoURI} alt="" className="w-5 h-5 rounded-full"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      )}
      {token.symbol}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-white/40">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

function RouteChip({ symbol, isIntermediate }: { symbol: string; isIntermediate?: boolean }) {
  const token = DEFAULT_TOKENS.find(t => t.symbol === symbol);
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${isIntermediate ? 'opacity-60' : ''}`}
      style={{
        background: isIntermediate ? 'rgba(139,92,246,0.04)' : 'rgba(139,92,246,0.08)',
        border: `1px solid rgba(139,92,246,${isIntermediate ? '0.06' : '0.12'})`,
      }}>
      {token?.logoURI && (
        <img src={token.logoURI} alt="" className="w-4 h-4 rounded-full"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      )}
      <span className="text-[11px] font-semibold text-white/70">{symbol}</span>
    </div>
  );
}

function DetailRow({ label, value, warn, danger }: { label: string; value: string; warn?: boolean; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/35 text-[12px]">{label}</span>
      <span className={`font-mono text-[12px] ${danger ? 'text-danger font-semibold' : warn ? 'text-danger' : 'text-white/50'}`}>{value}</span>
    </div>
  );
}

function parsedInputGt0(input: string): boolean {
  const n = parseFloat(input);
  return !isNaN(n) && n > 0;
}
