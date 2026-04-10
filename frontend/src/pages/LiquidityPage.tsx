import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useBalance } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatUnits, parseUnits } from 'viem';
import { ART } from '../lib/artConfig';
import { useAddLiquidity } from '../hooks/useAddLiquidity';
import { useToweliPrice } from '../hooks/useToweliPrice';
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

export default function LiquidityPage() {
  usePageTitle('Liquidity');
  const { isConnected, address } = useAccount();
  const { isWrongNetwork } = useNetworkCheck();
  const price = useToweliPrice();
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
  const [slippage] = useState(0.5);

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

  // Reserves for display
  const reserveAFmt = formatTokenAmount(formatUnits(liq.reserveA, decimalsA));
  const reserveBFmt = formatTokenAmount(formatUnits(liq.reserveB, decimalsB));

  // LP value calculation
  const userLpShare = liq.lpTotalSupply > 0n ? Number(liq.lpBalance * 10000n / liq.lpTotalSupply) / 100 : 0;
  const userAInPool = liq.lpTotalSupply > 0n ? (liq.lpBalance * liq.reserveA) / liq.lpTotalSupply : 0n;
  const userBInPool = liq.lpTotalSupply > 0n ? (liq.lpBalance * liq.reserveB) / liq.lpTotalSupply : 0n;

  // Balance display helpers
  const balADisplay = tokenA?.isNative
    ? (ethBal ? parseFloat(ethBal.formatted).toFixed(4) : '0')
    : formatTokenAmount(liq.tokenABalanceFormatted);
  const balBDisplay = tokenB?.isNative
    ? (ethBal ? parseFloat(ethBal.formatted).toFixed(4) : '0')
    : formatTokenAmount(liq.tokenBBalanceFormatted);

  const canAdd = numA > 0 && numB > 0 && !needsApprovalA && !needsApprovalB && !liq.isPending && !liq.isConfirming;
  const canRemove = lpNum > 0 && !needsApprovalLP && !liq.isPending && !liq.isConfirming;

  // Token selector button component
  const TokenButton = ({ token, side }: { token: TokenInfo | null; side: 'A' | 'B' }) => (
    <button
      onClick={() => setModalTarget(side)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:bg-white/10"
      style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)' }}
    >
      {token ? (
        <>
          <span className="text-white">{token.symbol}</span>
          <span className="text-white/40">&#9662;</span>
        </>
      ) : (
        <span className="text-purple-300">Select token &#9662;</span>
      )}
    </button>
  );

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.85) 30%, rgba(0,0,0,0.92) 60%, rgba(0,0,0,0.96) 100%)' }} />
        <motion.div className="relative z-10 text-center" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-3xl font-bold text-white mb-4">Tegridy Liquidity Pools</h1>
          <p className="text-white/50 mb-6">Provide liquidity to any token pair and earn trading fees</p>
          <ConnectButton />
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative">
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.85) 30%, rgba(0,0,0,0.92) 60%, rgba(0,0,0,0.96) 100%)' }} />

      <div className="relative z-10 max-w-lg mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center">
          <h1 className="text-2xl font-bold text-white">Tegridy Liquidity Pools</h1>
          <p className="text-white/40 text-sm mt-1">Add liquidity to any pair and earn 0.25% on every trade</p>
        </motion.div>

        {isWrongNetwork && (
          <div className="bg-red-500/20 border border-red-500/40 rounded-xl p-3 text-center text-red-300 text-sm font-medium">
            Please switch to Ethereum Mainnet
          </div>
        )}

        {/* Pool Stats Card */}
        {liq.pairExists && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="relative rounded-2xl overflow-hidden border border-white/5"
          >
            <img src={ART.poolParty.src} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.15 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
            <div className="relative p-5">
              <h2 className="text-white/60 text-xs font-semibold tracking-widest uppercase mb-4">{symbolA}/{symbolB} Pool</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-white/40 text-[11px]">{symbolA} Reserve</p>
                  <p className="text-white font-semibold text-sm">{reserveAFmt}</p>
                </div>
                <div>
                  <p className="text-white/40 text-[11px]">{symbolB} Reserve</p>
                  <p className="text-white font-semibold text-sm">{reserveBFmt}</p>
                </div>
                {tokenA?.symbol === 'TOWELI' && (
                  <div>
                    <p className="text-white/40 text-[11px]">TOWELI Price</p>
                    <p className="text-white font-semibold text-sm">{price.priceInUsd > 0 ? `$${price.priceInUsd.toFixed(8)}` : '-'}</p>
                  </div>
                )}
                <div>
                  <p className="text-white/40 text-[11px]">Your LP Tokens</p>
                  <p className="text-white font-semibold text-sm">{liq.lpBalance > 0n ? parseFloat(liq.lpBalanceFormatted).toFixed(6) : '0'}</p>
                </div>
              </div>
              {liq.lpBalance > 0n && (
                <div className="mt-3 pt-3 border-t border-white/5">
                  <p className="text-white/40 text-[11px] mb-1">Your Pool Share: {userLpShare.toFixed(2)}%</p>
                  <div className="flex gap-4 text-xs">
                    <span className="text-white/60">{formatTokenAmount(formatUnits(userAInPool, decimalsA))} {symbolA}</span>
                    <span className="text-white/60">{formatTokenAmount(formatUnits(userBInPool, decimalsB))} {symbolB}</span>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Tabs */}
        <div className="flex gap-2">
          {(['add', 'remove'] as Tab[]).map(t => (
            <button key={t} onClick={() => { setTab(t); liq.reset(); }}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                tab === t ? 'text-white' : 'text-white/30 hover:text-white/60'
              }`}
              style={tab === t ? { background: 'rgba(139,92,246,0.25)', border: '1px solid rgba(139,92,246,0.4)' } : { border: '1px solid rgba(255,255,255,0.05)' }}
            >
              {t === 'add' ? 'Add Liquidity' : 'Remove Liquidity'}
            </button>
          ))}
        </div>

        {/* Add Liquidity */}
        {tab === 'add' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="relative rounded-2xl overflow-hidden border border-white/5"
          >
            <img src={ART.beachVibes.src} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.15 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
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
                    type="number" value={inputA} onChange={e => handleInputAChange(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="0.0" min="0" step="any"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm font-medium outline-none focus:border-purple-500/40 transition-colors"
                  />
                  <button onClick={() => {
                    if (tokenA?.isNative && ethBal) handleInputAChange((parseFloat(ethBal.formatted) * 0.95).toFixed(6));
                    else handleInputAChange(liq.tokenABalanceFormatted);
                  }}
                    className="px-3 py-2 rounded-xl text-xs font-semibold text-purple-300 bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 transition-colors"
                  >MAX</button>
                </div>
              </div>

              {/* Plus sign */}
              <div className="flex justify-center">
                <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/40 text-sm">+</div>
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
                    type="number" value={inputB} onChange={e => handleInputBChange(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="0.0" min="0" step="any"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm font-medium outline-none focus:border-purple-500/40 transition-colors"
                  />
                  <button onClick={() => {
                    if (tokenB?.isNative && ethBal) handleInputBChange((parseFloat(ethBal.formatted) * 0.95).toFixed(6));
                    else handleInputBChange(liq.tokenBBalanceFormatted);
                  }}
                    className="px-3 py-2 rounded-xl text-xs font-semibold text-purple-300 bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 transition-colors"
                  >MAX</button>
                </div>
              </div>

              {/* Info */}
              {numA > 0 && numB > 0 && (
                <div className="bg-white/5 rounded-xl p-3 space-y-1 text-xs">
                  {liq.priceRatio > 0 && (
                    <div className="flex justify-between text-white/40">
                      <span>Rate</span>
                      <span className="text-white/60">1 {symbolA} = {liq.priceRatio.toFixed(6)} {symbolB}</span>
                    </div>
                  )}
                  {!liq.isEmptyPool && (
                    <div className="flex justify-between text-white/40">
                      <span>Pool Share</span>
                      <span className="text-white/60">{poolShare.toFixed(2)}%</span>
                    </div>
                  )}
                  <div className="flex justify-between text-white/40">
                    <span>Slippage Tolerance</span>
                    <span className="text-white/60">{slippage}%</span>
                  </div>
                  <div className="flex justify-between text-white/40">
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
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Approving...' : `Approve ${symbolA}`}
                </button>
              ) : needsApprovalB ? (
                <button
                  onClick={() => { lastActionRef.current = 'approve'; liq.approveTokenB(inputB); }}
                  disabled={liq.isPending || liq.isConfirming || numB <= 0}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Approving...' : `Approve ${symbolB}`}
                </button>
              ) : (
                <button
                  onClick={() => { lastActionRef.current = 'liquidity_add'; liq.addLiquidity(inputA, inputB, slippageBps); }}
                  disabled={!canAdd}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
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
            className="relative rounded-2xl overflow-hidden border border-white/5"
          >
            <img src={ART.chaosScene.src} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.15 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
            <div className="relative p-5 space-y-4">
              <div>
                <div className="flex justify-between mb-1.5">
                  <span className="text-white/70 text-xs font-medium">{symbolA}/{symbolB} LP Tokens</span>
                  <span className="text-xs" style={{ color: '#d4a017' }}>
                    Balance: {liq.lpBalance > 0n ? parseFloat(liq.lpBalanceFormatted).toFixed(6) : '0'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="number" value={lpInput} onChange={e => setLpInput(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="0.0" min="0" step="any"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm font-medium outline-none focus:border-purple-500/40 transition-colors"
                  />
                  <button onClick={() => setLpInput(liq.lpBalanceFormatted)}
                    className="px-3 py-2 rounded-xl text-xs font-semibold text-purple-300 bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 transition-colors"
                  >MAX</button>
                </div>
              </div>

              {/* Preview */}
              {lpNum > 0 && liq.lpTotalSupply > 0n && (
                <div className="bg-white/5 rounded-xl p-3 space-y-1 text-xs">
                  <p className="text-white/40 mb-2">You will receive approximately:</p>
                  <div className="flex justify-between text-white/60">
                    <span>{symbolA}</span>
                    <span>{formatTokenAmount(formatUnits(
                      liq.lpTotalSupply > 0n ? (parseUnits(lpInput || '0', 18) * liq.reserveA) / liq.lpTotalSupply : 0n,
                      decimalsA
                    ))}</span>
                  </div>
                  <div className="flex justify-between text-white/60">
                    <span>{symbolB}</span>
                    <span>{formatTokenAmount(formatUnits(
                      liq.lpTotalSupply > 0n ? (parseUnits(lpInput || '0', 18) * liq.reserveB) / liq.lpTotalSupply : 0n,
                      decimalsB
                    ))}</span>
                  </div>
                </div>
              )}

              {/* Action */}
              {needsApprovalLP ? (
                <button
                  onClick={() => { lastActionRef.current = 'approve'; liq.approveLP(lpInput); }}
                  disabled={liq.isPending || liq.isConfirming || lpNum <= 0}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Approving...' : 'Approve LP Token'}
                </button>
              ) : (
                <button
                  onClick={() => { lastActionRef.current = 'liquidity_remove'; liq.removeLiquidity(lpInput, slippageBps); }}
                  disabled={!canRemove}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)', color: 'white' }}
                >
                  {liq.isPending ? 'Confirm in wallet...' : liq.isConfirming ? 'Removing...' : 'Remove Liquidity'}
                </button>
              )}

              {liq.lpBalance === 0n && (
                <p className="text-white/30 text-xs text-center">You don't have any LP tokens for this pair. Add liquidity first.</p>
              )}
            </div>
          </motion.div>
        )}

        {/* LP Address */}
        {liq.pairAddress && (
          <div className="text-center">
            <a
              href={`https://etherscan.io/address/${liq.pairAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="text-white/20 hover:text-purple-400 text-[10px] transition-colors"
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
