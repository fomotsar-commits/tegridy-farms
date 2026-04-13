import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount, useBalance } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatUnits, parseUnits } from 'viem';
import { ART } from '../lib/artConfig';
import { useAddLiquidity } from '../hooks/useAddLiquidity';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { useNetworkCheck } from '../hooks/useNetworkCheck';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import { useConfetti } from '../hooks/useConfetti';
import { formatTokenAmount } from '../lib/formatting';
import type { ReceiptType } from '../hooks/useTransactionReceipt';
import { usePageTitle } from '../hooks/usePageTitle';
import { usePoints } from '../hooks/usePoints';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { TokenSelectModal } from '../components/swap/TokenSelectModal';
import { DEFAULT_TOKENS, type TokenInfo } from '../lib/tokenList';
import { TOWELI_ADDRESS } from '../lib/constants';

type Tab = 'add' | 'remove';

// Default tokens for liquidity: TOWELI and ETH
const defaultTokenA = DEFAULT_TOKENS.find(t => t.address.toLowerCase() === TOWELI_ADDRESS.toLowerCase()) ?? DEFAULT_TOKENS[2];
const defaultTokenB = DEFAULT_TOKENS.find(t => t.isNative) ?? DEFAULT_TOKENS[0];

export default function LiquidityPage({ embedded }: { embedded?: boolean }) {
  usePageTitle(embedded ? '' : 'Liquidity');
  const { isConnected, address, chain } = useAccount();
  const explorerUrl = chain?.blockExplorers?.default?.url ?? 'https://etherscan.io';
  const { isWrongNetwork } = useNetworkCheck();
  const price = useTOWELIPrice();
  const { showReceipt } = useTransactionReceipt();
  const confetti = useConfetti();
  const points = usePoints();
  const nft = useNFTBoost();

  const { data: ethBal } = useBalance({ address });

  // Token selection
  const [tokenA, setTokenA] = useState<TokenInfo | null>(defaultTokenA);
  const [tokenB, setTokenB] = useState<TokenInfo | null>(defaultTokenB);
  const [modalTarget, setModalTarget] = useState<'A' | 'B' | null>(null);
  const [customTokens, setCustomTokens] = useState<TokenInfo[]>([]);

  const liq = useAddLiquidity(tokenA, tokenB);

  const [tab, setTab] = useState<Tab>('add');
  const [inputA, setInputA] = useState('');
  const [inputB, setInputB] = useState('');
  const [lpInput, setLpInput] = useState('');
  const [slippage, setSlippage] = useState(0.5);
  const [showSlippage, setShowSlippage] = useState(false);

  const lastActionRef = useRef<ReceiptType | null>(null);
  const receiptShownHashRef = useRef<string | null>(null);

  const decimalsA = tokenA?.decimals ?? 18;
  const decimalsB = tokenB?.decimals ?? 18;
  const symbolA = tokenA?.symbol ?? '?';
  const symbolB = tokenB?.symbol ?? '?';

  // Auto-calculate paired amount
  const handleInputAChange = (val: string) => {
    setInputA(val);
    if (!liq.isEmptyPool && val && parseFloat(val) > 0) {
      const paired = liq.getAmountB(val);
      if (paired) {
        const num = parseFloat(paired);
        setInputB(num > 0 ? (decimalsB <= 8 ? num.toFixed(decimalsB) : num.toFixed(8)) : '');
      }
    }
  };

  const handleInputBChange = (val: string) => {
    setInputB(val);
    if (!liq.isEmptyPool && val && parseFloat(val) > 0) {
      const paired = liq.getAmountA(val);
      if (paired) {
        const num = parseFloat(paired);
        setInputA(num > 0 ? (decimalsA <= 8 ? num.toFixed(decimalsA) : num.toFixed(8)) : '');
      }
    }
  };

  // Token selection handler
  const handleTokenSelect = useCallback((token: TokenInfo) => {
    if (modalTarget === 'A') {
      // Don't allow same token on both sides
      if (tokenB && token.address.toLowerCase() === (tokenB.isNative ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : tokenB.address).toLowerCase()) return;
      setTokenA(token);
    } else {
      if (tokenA && token.address.toLowerCase() === (tokenA.isNative ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : tokenA.address).toLowerCase()) return;
      setTokenB(token);
    }
    setInputA('');
    setInputB('');
    setModalTarget(null);
  }, [modalTarget, tokenA, tokenB]);

  const addCustomToken = useCallback((token: TokenInfo) => {
    setCustomTokens(prev => {
      if (prev.find(t => t.address.toLowerCase() === token.address.toLowerCase())) return prev;
      return [...prev, token];
    });
  }, []);

  // Receipt on success
  useEffect(() => {
    if (liq.isSuccess && liq.hash && liq.hash !== receiptShownHashRef.current) {
      receiptShownHashRef.current = liq.hash;
      const action = lastActionRef.current ?? 'liquidity_add';
      showReceipt({ type: action, data: { txHash: liq.hash } });
      if (action === 'liquidity_add') {
        points.logAction('lp_provide', nft.holdsGoldCard);
        confetti.fire();
      }
      liq.refetch();
      setInputA('');
      setInputB('');
      setLpInput('');
    }
  }, [liq.isSuccess, liq.hash]);

  // Computed
  const slippageBps = Math.round(slippage * 100);
  const numA = parseFloat(inputA) || 0;
  const numB = parseFloat(inputB) || 0;
  const lpNum = parseFloat(lpInput) || 0;

  // Approval check for adding liquidity
  const needsApprovalA = tab === 'add' && tokenA && !tokenA.isNative && numA > 0 &&
    liq.tokenAAllowance < (numA > 0 ? parseUnits(inputA || '0', decimalsA) : 0n);
  const needsApprovalB = tab === 'add' && tokenB && !tokenB.isNative && numB > 0 &&
    liq.tokenBAllowance < (numB > 0 ? parseUnits(inputB || '0', decimalsB) : 0n);
  const needsApprovalLP = tab === 'remove' && lpNum > 0 &&
    liq.lpAllowance < (lpNum > 0 ? parseUnits(lpInput || '0', 18) : 0n);

  const poolShare = numA > 0 ? liq.getPoolShare(inputA) : 0;

  // Reserves for display (memoized to avoid re-formatting on every render)
  const reserveAFmt = useMemo(() => formatTokenAmount(formatUnits(liq.reserveA, decimalsA)), [liq.reserveA, decimalsA]);
  const reserveBFmt = useMemo(() => formatTokenAmount(formatUnits(liq.reserveB, decimalsB)), [liq.reserveB, decimalsB]);

  // LP value calculation
  const { userLpShare, userAInPool, userBInPool } = useMemo(() => ({
    userLpShare: liq.lpTotalSupply > 0n ? Number(liq.lpBalance * 10000n / liq.lpTotalSupply) / 100 : 0,
    userAInPool: liq.lpTotalSupply > 0n ? (liq.lpBalance * liq.reserveA) / liq.lpTotalSupply : 0n,
    userBInPool: liq.lpTotalSupply > 0n ? (liq.lpBalance * liq.reserveB) / liq.lpTotalSupply : 0n,
  }), [liq.lpTotalSupply, liq.lpBalance, liq.reserveA, liq.reserveB]);

  // Balance display helpers
  const balADisplay = tokenA?.isNative
    ? (ethBal ? parseFloat(ethBal.formatted).toFixed(4) : '0')
    : formatTokenAmount(liq.tokenABalanceFormatted);
  const balBDisplay = tokenB?.isNative
    ? (ethBal ? parseFloat(ethBal.formatted).toFixed(4) : '0')
    : formatTokenAmount(liq.tokenBBalanceFormatted);

  const hasEnoughA = tokenA?.isNative
    ? (ethBal ? numA <= parseFloat(ethBal.formatted) : false)
    : numA <= parseFloat(liq.tokenABalanceFormatted || '0');
  const hasEnoughB = tokenB?.isNative
    ? (ethBal ? numB <= parseFloat(ethBal.formatted) : false)
    : numB <= parseFloat(liq.tokenBBalanceFormatted || '0');
  const canAdd = numA > 0 && numB > 0 && hasEnoughA && hasEnoughB && !needsApprovalA && !needsApprovalB && !liq.isPending && !liq.isConfirming;
  const canRemove = lpNum > 0 && !needsApprovalLP && !liq.isPending && !liq.isConfirming;

  // Token selector button component
  const TokenButton = ({ token, side }: { token: TokenInfo | null; side: 'A' | 'B' }) => (
    <button
      onClick={() => setModalTarget(side)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:bg-black/60"
      style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.3)' }}
    >
      {token ? (
        <>
          <span className="text-white">{token.symbol}</span>
          <span className="text-white">&#9662;</span>
        </>
      ) : (
        <span className="text-black">Select token &#9662;</span>
      )}
    </button>
  );

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <motion.div className="relative z-10 text-center" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-3xl font-bold text-white mb-4">Tegridy Liquidity Pools</h1>
          <p className="text-white mb-6">Provide liquidity to any token pair and earn trading fees</p>
          <ConnectButton />
        </motion.div>
      </div>
    );
  }

  return (
    <div className={embedded ? '' : 'min-h-screen relative'}>
      {/* Background removed — handled by AppLayout */}

      <div className={`relative z-10 ${embedded ? 'space-y-6' : 'max-w-lg mx-auto px-4 py-8 space-y-6'}`}>
        {/* Header */}
        {!embedded && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center">
            <h1 className="text-2xl font-bold text-white">Tegridy Liquidity Pools</h1>
            <p className="text-white text-sm mt-1">Add liquidity to any pair and earn 0.25% on every trade</p>
          </motion.div>
        )}

        {isWrongNetwork && (
          <div className="bg-red-500/20 border border-red-500/40 rounded-xl p-3 text-center text-red-300 text-sm font-medium">
            Please switch to Ethereum Mainnet
          </div>
        )}

        {/* Loading indicator */}
        {liq.isLoadingPool && (
          <div className="flex items-center justify-center gap-2 py-4">
            <div className="w-4 h-4 border-2 border-purple-500/40 border-t-purple-400 rounded-full animate-spin" />
            <span className="text-white/60 text-sm">Loading pool data...</span>
          </div>
        )}

        {/* Pool Stats Card */}
        {!liq.isLoadingPool && liq.pairExists && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="relative rounded-2xl overflow-hidden border border-white/20"
          >
            <img src={ART.poolParty.src} alt="" className="absolute inset-0 w-full h-full object-cover" />
            <div className="relative p-5">
              <h2 className="text-white text-xs font-semibold tracking-widest uppercase mb-4">{symbolA}/{symbolB} Pool</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-white text-[11px]">{symbolA} Reserve</p>
                  <p className="text-white font-semibold text-sm">{reserveAFmt}</p>
                </div>
                <div>
                  <p className="text-white text-[11px]">{symbolB} Reserve</p>
                  <p className="text-white font-semibold text-sm">{reserveBFmt}</p>
                </div>
                {tokenA?.symbol === 'TOWELI' && (
                  <div>
                    <p className="text-white text-[11px]">TOWELI Price</p>
                    <p className="text-white font-semibold text-sm">{price.priceInUsd > 0 ? `$${price.priceInUsd.toFixed(8)}` : '-'}</p>
                  </div>
                )}
                <div>
                  <p className="text-white text-[11px]">Your LP Tokens</p>
                  <p className="text-white font-semibold text-sm">{liq.lpBalance > 0n ? parseFloat(liq.lpBalanceFormatted).toFixed(6) : '0'}</p>
                </div>
              </div>
              {liq.lpBalance > 0n && (
                <div className="mt-3 pt-3 border-t border-white/20">
                  <p className="text-white text-[11px] mb-1">Your Pool Share: {userLpShare.toFixed(2)}%</p>
                  <div className="flex gap-4 text-xs">
                    <span className="text-white">{formatTokenAmount(formatUnits(userAInPool, decimalsA))} {symbolA}</span>
                    <span className="text-white">{formatTokenAmount(formatUnits(userBInPool, decimalsB))} {symbolB}</span>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Tabs + Slippage toggle */}
        <div className="flex gap-2 items-center">
          {(['add', 'remove'] as Tab[]).map(t => (
            <button key={t} onClick={() => { setTab(t); liq.reset(); }}
              className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-all ${
                tab === t ? 'text-white' : 'text-white hover:text-white'
              }`}
              style={tab === t ? { background: 'rgba(139,92,246,0.25)', border: '1px solid rgba(139,92,246,0.4)' } : { border: '1px solid rgba(255,255,255,0.20)' }}
            >
              {t === 'add' ? 'Add Liquidity' : 'Remove Liquidity'}
            </button>
          ))}
          <button onClick={() => setShowSlippage(!showSlippage)}
            aria-label="Slippage settings"
            className="flex items-center gap-1.5 text-[12px] font-mono text-white hover:text-white transition-colors cursor-pointer px-2.5 py-3 rounded-xl"
            style={{ background: showSlippage ? 'rgba(139,92,246,0.75)' : 'transparent', border: '1px solid rgba(255,255,255,0.20)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            {slippage}%
          </button>
        </div>

        {/* Slippage Settings Panel */}
        <AnimatePresence>
          {showSlippage && (
            <motion.div className="rounded-xl p-3.5" style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)' }}
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <p className="text-white text-[11px] font-medium uppercase tracking-wider mb-2.5">Slippage Tolerance</p>
              <div className="flex gap-1.5">
                {[0.5, 1, 3].map((s) => (
                  <button key={s} onClick={() => setSlippage(s)}
                    className="flex-1 py-2 rounded-lg text-[12px] font-semibold cursor-pointer transition-all"
                    style={{
                      background: slippage === s ? 'rgba(139,92,246,0.75)' : 'rgba(0,0,0,0.55)',
                      color: slippage === s ? 'white' : 'rgba(255,255,255,0.4)',
                      border: slippage === s ? '1px solid rgba(139,92,246,0.75)' : '1px solid rgba(255,255,255,0.25)',
                    }}>
                    {s}%
                  </button>
                ))}
              </div>
              {slippage > 3 && (
                <p className="text-[11px] mt-1.5" style={{ color: '#f59e0b' }}>
                  High slippage -- you may receive significantly less tokens
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Add Liquidity */}
        {tab === 'add' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="relative rounded-2xl overflow-hidden border border-white/20"
          >
            <img src={ART.beachVibes.src} alt="" className="absolute inset-0 w-full h-full object-cover" />
            <div className="relative p-5 space-y-4">

              {/* New pool notice */}
              {!liq.pairExists && tokenA && tokenB && (
                <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)' }}>
                  <p className="text-blue-400 text-[11px] font-semibold mb-0.5">Creating a new {symbolA}/{symbolB} pool</p>
                  <p className="text-blue-400/60 text-[10px]">Set both amounts to establish the initial price ratio.</p>
                </div>
              )}

              {/* Empty pool notice */}
              {liq.isEmptyPool && liq.pairExists && (
                <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)' }}>
                  <p className="text-yellow-400 text-[11px] font-semibold mb-0.5">You are the first liquidity provider</p>
                  <p className="text-yellow-400/60 text-[10px]">The ratio you choose establishes the initial price.</p>
                </div>
              )}

              {/* Token A Input */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <TokenButton token={tokenA} side="A" />
                  <span className="text-xs" style={{ color: '#d4a017' }}>
                    Balance: {balADisplay} {symbolA}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="number" inputMode="decimal" value={inputA} onChange={e => handleInputAChange(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                    placeholder="0.0" min="0" step="any"
                    className="flex-1 bg-black/60 border border-white/25 rounded-xl px-4 py-3 min-h-[44px] text-white text-sm font-medium outline-none focus:border-purple-500/40 transition-colors"
                  />
                  <button onClick={() => {
                    if (tokenA?.isNative && ethBal) handleInputAChange(Math.max(0, parseFloat(ethBal.formatted) - 0.01).toFixed(6));
                    else handleInputAChange(liq.tokenABalanceFormatted);
                  }}
                    className="px-4 py-3 min-h-[44px] rounded-xl text-sm font-semibold text-black bg-purple-500/40 border border-purple-500/40 hover:bg-purple-500/50 transition-colors"
                  >MAX</button>
                </div>
              </div>

              {/* Plus sign */}
              <div className="flex justify-center">
                <div className="w-8 h-8 rounded-full bg-black/60 border border-white/25 flex items-center justify-center text-white text-sm">+</div>
              </div>

              {/* Token B Input */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <TokenButton token={tokenB} side="B" />
                  <span className="text-xs" style={{ color: '#d4a017' }}>
                    Balance: {balBDisplay} {symbolB}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="number" inputMode="decimal" value={inputB} onChange={e => handleInputBChange(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                    placeholder="0.0" min="0" step="any"
                    className="flex-1 bg-black/60 border border-white/25 rounded-xl px-4 py-3 min-h-[44px] text-white text-sm font-medium outline-none focus:border-purple-500/40 transition-colors"
                  />
                  <button onClick={() => {
                    if (tokenB?.isNative && ethBal) handleInputBChange(Math.max(0, parseFloat(ethBal.formatted) - 0.01).toFixed(6));
                    else handleInputBChange(liq.tokenBBalanceFormatted);
                  }}
                    className="px-4 py-3 min-h-[44px] rounded-xl text-sm font-semibold text-black bg-purple-500/40 border border-purple-500/40 hover:bg-purple-500/50 transition-colors"
                  >MAX</button>
                </div>
              </div>

              {/* Info */}
              {numA > 0 && numB > 0 && (
                <div className="bg-black/60 rounded-xl p-3 space-y-1 text-xs">
                  {liq.priceRatio > 0 && (
                    <div className="flex justify-between text-white">
                      <span>Rate</span>
                      <span className="text-white">1 {symbolA} = {liq.priceRatio.toFixed(6)} {symbolB}</span>
                    </div>
                  )}
                  {!liq.isEmptyPool && (
                    <div className="flex justify-between text-white">
                      <span>Pool Share</span>
                      <span className="text-white">{poolShare.toFixed(2)}%</span>
                    </div>
                  )}
                  <div className="flex justify-between text-white">
                    <span>Slippage Tolerance</span>
                    <span className="text-white">{slippage}%</span>
                  </div>
                  <div className="flex justify-between text-white">
                    <span>Router</span>
                    <span className="text-green-400/80">Tegridy DEX</span>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              {needsApprovalA ? (
                <button
                  onClick={() => { lastActionRef.current = 'approve'; liq.approveTokenA(inputA); }}
                  disabled={liq.isPending || liq.isConfirming || numA <= 0}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Approving...' : `Approve ${symbolA}`}
                </button>
              ) : needsApprovalB ? (
                <button
                  onClick={() => { lastActionRef.current = 'approve'; liq.approveTokenB(inputB); }}
                  disabled={liq.isPending || liq.isConfirming || numB <= 0}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Approving...' : `Approve ${symbolB}`}
                </button>
              ) : (
                <button
                  onClick={() => { lastActionRef.current = 'liquidity_add'; liq.addLiquidity(inputA, inputB, slippageBps); }}
                  disabled={!canAdd}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #059669 0%, #10b981 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Adding liquidity...' : (
                    liq.pairExists ? 'Add Liquidity' : `Create ${symbolA}/${symbolB} Pool`
                  )}
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* Remove Liquidity */}
        {tab === 'remove' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="relative rounded-2xl overflow-hidden border border-white/20"
          >
            <img src={ART.chaosScene.src} alt="" className="absolute inset-0 w-full h-full object-cover" />
            <div className="relative p-5 space-y-4">
              <div>
                <div className="flex justify-between mb-1.5">
                  <span className="text-white text-xs font-medium">{symbolA}/{symbolB} LP Tokens</span>
                  <span className="text-xs" style={{ color: '#d4a017' }}>
                    Balance: {liq.lpBalance > 0n ? parseFloat(liq.lpBalanceFormatted).toFixed(6) : '0'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="number" inputMode="decimal" value={lpInput} onChange={e => setLpInput(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                    placeholder="0.0" min="0" step="any"
                    className="flex-1 bg-black/60 border border-white/25 rounded-xl px-4 py-3 min-h-[44px] text-white text-sm font-medium outline-none focus:border-purple-500/40 transition-colors"
                  />
                  <button onClick={() => setLpInput(liq.lpBalanceFormatted)}
                    className="px-4 py-3 min-h-[44px] rounded-xl text-sm font-semibold text-black bg-purple-500/40 border border-purple-500/40 hover:bg-purple-500/50 transition-colors"
                  >MAX</button>
                </div>
              </div>

              {/* Preview */}
              {lpNum > 0 && liq.lpTotalSupply > 0n && (() => {
                const estA = liq.lpTotalSupply > 0n ? (parseUnits(lpInput || '0', 18) * liq.reserveA) / liq.lpTotalSupply : 0n;
                const estB = liq.lpTotalSupply > 0n ? (parseUnits(lpInput || '0', 18) * liq.reserveB) / liq.lpTotalSupply : 0n;
                const minA = estA * BigInt(10000 - slippageBps) / 10000n;
                const minB = estB * BigInt(10000 - slippageBps) / 10000n;
                return (
                  <div className="bg-black/60 rounded-xl p-3 space-y-1 text-xs">
                    <p className="text-white mb-2">You will receive approximately:</p>
                    <div className="flex justify-between text-white">
                      <span>{symbolA}</span>
                      <span>{formatTokenAmount(formatUnits(estA, decimalsA))}</span>
                    </div>
                    <div className="flex justify-between text-white">
                      <span>{symbolB}</span>
                      <span>{formatTokenAmount(formatUnits(estB, decimalsB))}</span>
                    </div>
                    <div className="pt-1.5 mt-1.5 border-t border-white/10 space-y-1">
                      <p className="text-white/60 mb-1">Minimum after {slippage}% slippage:</p>
                      <div className="flex justify-between text-white/60">
                        <span>{symbolA}</span>
                        <span>{formatTokenAmount(formatUnits(minA, decimalsA))}</span>
                      </div>
                      <div className="flex justify-between text-white/60">
                        <span>{symbolB}</span>
                        <span>{formatTokenAmount(formatUnits(minB, decimalsB))}</span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Action */}
              {needsApprovalLP ? (
                <button
                  onClick={() => { lastActionRef.current = 'approve'; liq.approveLP(lpInput); }}
                  disabled={liq.isPending || liq.isConfirming || lpNum <= 0}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Approving...' : 'Approve LP Token'}
                </button>
              ) : (
                <button
                  onClick={() => { lastActionRef.current = 'liquidity_remove'; liq.removeLiquidity(lpInput, slippageBps); }}
                  disabled={!canRemove}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Removing...' : 'Remove Liquidity'}
                </button>
              )}

              {liq.lpBalance === 0n && (
                <p className="text-white text-xs text-center">You don't have any LP tokens for this pair. Add liquidity first.</p>
              )}
            </div>
          </motion.div>
        )}

        {/* LP Address */}
        {liq.pairAddress && (
          <div className="text-center">
            <a
              href={`${explorerUrl}/address/${liq.pairAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="text-white hover:text-black text-[10px] transition-colors"
            >
              LP Contract: {(liq.pairAddress as string).slice(0, 6)}...{(liq.pairAddress as string).slice(-4)}
            </a>
          </div>
        )}
      </div>

      {/* Token Select Modal */}
      <TokenSelectModal
        open={modalTarget !== null}
        onClose={() => setModalTarget(null)}
        onSelect={handleTokenSelect}
        disabledAddress={modalTarget === 'A'
          ? (tokenB?.isNative ? undefined : tokenB?.address)
          : (tokenA?.isNative ? undefined : tokenA?.address)}
        customTokens={customTokens}
        onAddCustomToken={addCustomToken}
      />
    </div>
  );
}
