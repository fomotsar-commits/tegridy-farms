import { useState, useEffect, useMemo } from 'react';
import { useAccount, useBalance, useChainId } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatUnits, parseUnits } from 'viem';
import { useAddLiquidity } from '../../hooks/useAddLiquidity';
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';
import { TokenSelectModal } from './TokenSelectModal';
import { getTxUrl } from '../../lib/explorer';
import { formatTokenAmount } from '../../lib/formatting';
import { pageArt } from '../../lib/artConfig';

type LiquidityMode = 'add' | 'remove';

const SLIPPAGE_BPS = [50, 100, 200] as const;

const blockNegativeKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === 'e') e.preventDefault();
};

const CUSTOM_TOKENS_KEY = 'tegridy_liquidity_custom_tokens';

function loadCustomTokens(): TokenInfo[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TOKENS_KEY);
    return raw ? JSON.parse(raw) as TokenInfo[] : [];
  } catch { return []; }
}

export function LiquidityTab() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const ethToken = DEFAULT_TOKENS.find(t => t.symbol === 'ETH')!;
  const toweliToken = DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI')!;

  const [mode, setMode] = useState<LiquidityMode>('add');
  const [tokenA, setTokenA] = useState<TokenInfo>(ethToken);
  const [tokenB, setTokenB] = useState<TokenInfo>(toweliToken);
  const [showPicker, setShowPicker] = useState<'A' | 'B' | null>(null);
  const [customTokens, setCustomTokens] = useState<TokenInfo[]>(loadCustomTokens);

  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [removePct, setRemovePct] = useState(0);
  const [slippageBps, setSlippageBps] = useState<number>(50);

  const liq = useAddLiquidity(tokenA, tokenB);

  // Native ETH balance (useAddLiquidity reads the WETH ERC20 balance for native tokens,
  // which is wrong — user might hold ETH but no WETH). Fetch real native balance here.
  const { data: nativeBalanceA } = useBalance({
    address, query: { enabled: !!address && tokenA.isNative },
  });
  const { data: nativeBalanceB } = useBalance({
    address, query: { enabled: !!address && tokenB.isNative },
  });

  const balanceADisplay = tokenA.isNative
    ? (nativeBalanceA ? parseFloat(formatUnits(nativeBalanceA.value, nativeBalanceA.decimals)) : 0)
    : parseFloat(liq.tokenABalanceFormatted || '0');
  const balanceBDisplay = tokenB.isNative
    ? (nativeBalanceB ? parseFloat(formatUnits(nativeBalanceB.value, nativeBalanceB.decimals)) : 0)
    : parseFloat(liq.tokenBBalanceFormatted || '0');

  // Auto-pair inputs
  const handleAmountAChange = (v: string) => {
    setAmountA(v);
    if (!liq.isEmptyPool) setAmountB(liq.getAmountB(v));
  };
  const handleAmountBChange = (v: string) => {
    setAmountB(v);
    if (!liq.isEmptyPool) setAmountA(liq.getAmountA(v));
  };

  // Reset amounts when token pair changes
  useEffect(() => {
    setAmountA(''); setAmountB(''); setRemovePct(0);
  }, [tokenA.address, tokenB.address]);

  // LP amount derived from percent slider
  const lpRemoveAmount = useMemo(() => {
    if (removePct === 0) return '';
    const lpBal = parseFloat(liq.lpBalanceFormatted || '0');
    if (!isFinite(lpBal) || lpBal === 0) return '';
    return ((lpBal * removePct) / 100).toString();
  }, [removePct, liq.lpBalanceFormatted]);

  // Approval checks — bigint-safe comparison
  const needsApproveA = useMemo(() => {
    if (tokenA.isNative || !amountA) return false;
    try {
      const needed = parseUnits(amountA, tokenA.decimals);
      return liq.tokenAAllowance < needed;
    } catch { return false; }
  }, [tokenA, amountA, liq.tokenAAllowance]);

  const needsApproveB = useMemo(() => {
    if (tokenB.isNative || !amountB) return false;
    try {
      const needed = parseUnits(amountB, tokenB.decimals);
      return liq.tokenBAllowance < needed;
    } catch { return false; }
  }, [tokenB, amountB, liq.tokenBAllowance]);

  const needsApproveLP = useMemo(() => {
    if (!lpRemoveAmount) return false;
    try {
      const needed = parseUnits(lpRemoveAmount, 18);
      return liq.lpAllowance < needed;
    } catch { return false; }
  }, [lpRemoveAmount, liq.lpAllowance]);

  // Expected remove outputs
  const expectedRemoveA = useMemo(() => {
    if (!lpRemoveAmount || liq.reserveA === 0n || liq.lpTotalSupply === 0n) return '0';
    try {
      const lp = parseUnits(lpRemoveAmount, 18);
      return formatUnits((lp * liq.reserveA) / liq.lpTotalSupply, tokenA.decimals);
    } catch { return '0'; }
  }, [lpRemoveAmount, liq.reserveA, liq.lpTotalSupply, tokenA.decimals]);

  const expectedRemoveB = useMemo(() => {
    if (!lpRemoveAmount || liq.reserveB === 0n || liq.lpTotalSupply === 0n) return '0';
    try {
      const lp = parseUnits(lpRemoveAmount, 18);
      return formatUnits((lp * liq.reserveB) / liq.lpTotalSupply, tokenB.decimals);
    } catch { return '0'; }
  }, [lpRemoveAmount, liq.reserveB, liq.lpTotalSupply, tokenB.decimals]);

  const poolShare = amountA ? liq.getPoolShare(amountA) : 0;

  const insufficientA = !!amountA && parseFloat(amountA) > balanceADisplay;
  const insufficientB = !!amountB && parseFloat(amountB) > balanceBDisplay;

  const handleTokenPick = (tok: TokenInfo) => {
    if (showPicker === 'A') {
      if (tok.address.toLowerCase() === tokenB.address.toLowerCase()) { setTokenB(tokenA); }
      setTokenA(tok);
    } else if (showPicker === 'B') {
      if (tok.address.toLowerCase() === tokenA.address.toLowerCase()) { setTokenA(tokenB); }
      setTokenB(tok);
    }
    setShowPicker(null);
  };

  const handleAddCustom = (tok: TokenInfo) => {
    setCustomTokens(prev => {
      if (prev.some(t => t.address.toLowerCase() === tok.address.toLowerCase())) return prev;
      const next = [...prev, tok];
      try { localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const hasLP = parseFloat(liq.lpBalanceFormatted || '0') > 0;

  return (
    <div className="relative">
      <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none" aria-hidden="true">
        <img src={pageArt('liquidity-tab', 0).src} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
      </div>

      <div className="relative p-5">
        {/* Mode toggle */}
        <div className="flex gap-1.5 mb-4 p-1 rounded-xl" style={{ background: 'rgba(0,0,0,0.40)', border: '1px solid rgba(255,255,255,0.15)' }}>
          <button onClick={() => setMode('add')} aria-pressed={mode === 'add'}
            className="flex-1 px-3 py-2 min-h-[40px] rounded-lg text-[12px] font-medium transition-all"
            style={{ background: mode === 'add' ? 'var(--color-purple-40)' : 'transparent', color: 'white', border: mode === 'add' ? '1px solid var(--color-purple-60)' : '1px solid transparent' }}>
            Grow the Crop
          </button>
          <button onClick={() => setMode('remove')} aria-pressed={mode === 'remove'}
            className="flex-1 px-3 py-2 min-h-[40px] rounded-lg text-[12px] font-medium transition-all"
            style={{ background: mode === 'remove' ? 'var(--color-purple-40)' : 'transparent', color: 'white', border: mode === 'remove' ? '1px solid var(--color-purple-60)' : '1px solid transparent' }}>
            Pull Crop Out
          </button>
        </div>

        <p className="text-white/70 text-[11px] mb-4">
          {mode === 'add'
            ? 'Pair two tokens, earn a cut of every swap that routes through your pool. LP goes to your wallet.'
            : 'Withdraw your LP back into the two underlying tokens. Burn the LP, take the crop.'}
        </p>

        {!isConnected ? (
          <div className="text-center py-8">
            <p className="text-white/70 text-[13px] mb-4">Gotta connect a wallet to farm liquidity.</p>
            <ConnectButton />
          </div>
        ) : mode === 'add' ? (
          <>
            {/* Token A */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-white/70 text-[11px]">Token A</span>
                <span className="text-white/70 text-[10px] font-mono">Balance: {balanceADisplay.toFixed(4)}</span>
              </div>
              <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)' }}>
                <button onClick={() => setShowPicker('A')} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
                  {tokenA.logoURI && <img src={tokenA.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                  <span className="text-white font-medium text-[14px]">{tokenA.symbol}</span>
                  <span className="text-white/70">▾</span>
                </button>
                <input type="number" inputMode="decimal" placeholder="0.0" value={amountA}
                  onChange={e => handleAmountAChange(e.target.value)} onKeyDown={blockNegativeKey}
                  className="flex-1 bg-transparent text-right text-white text-[18px] font-mono outline-none min-w-0" />
              </div>
            </div>

            <div className="flex justify-center -my-0.5 relative z-10">
              <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'var(--color-weed-20, rgba(45,139,78,0.25))', border: '1px solid var(--color-weed-60, rgba(45,139,78,0.60))' }}>
                <span className="text-white text-[16px] leading-none">+</span>
              </div>
            </div>

            {/* Token B */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-white/70 text-[11px]">Token B</span>
                <span className="text-white/70 text-[10px] font-mono">Balance: {balanceBDisplay.toFixed(4)}</span>
              </div>
              <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)' }}>
                <button onClick={() => setShowPicker('B')} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
                  {tokenB.logoURI && <img src={tokenB.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                  <span className="text-white font-medium text-[14px]">{tokenB.symbol}</span>
                  <span className="text-white/70">▾</span>
                </button>
                <input type="number" inputMode="decimal" placeholder="0.0" value={amountB}
                  onChange={e => handleAmountBChange(e.target.value)} onKeyDown={blockNegativeKey}
                  className="flex-1 bg-transparent text-right text-white text-[18px] font-mono outline-none min-w-0" />
              </div>
            </div>

            {/* Pool stats w/ pool-party overlay */}
            {liq.pairExists && !liq.isEmptyPool && (
              <div className="mb-3 relative rounded-lg overflow-hidden" style={{ border: '1px solid rgba(16,185,129,0.18)' }}>
                <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                  <img src={pageArt('liquidity-tab', 1).src} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
                </div>
                <div className="relative p-3 text-[11px]" style={{ background: 'rgba(16,185,129,0.05)' }}>
                  <div className="flex justify-between text-white/70 mb-1">
                    <span>Your share of the pool</span>
                    <span className="text-emerald-400 font-mono">{poolShare.toFixed(4)}%</span>
                  </div>
                  <div className="flex justify-between text-white/70 mb-1">
                    <span>Rate</span>
                    <span className="text-white font-mono">1 {tokenA.symbol} = {liq.priceRatio > 0 ? liq.priceRatio.toFixed(6) : '—'} {tokenB.symbol}</span>
                  </div>
                  <div className="flex justify-between text-white/70">
                    <span>Your LP tokens</span>
                    <span className="text-white font-mono">{formatTokenAmount(liq.lpBalanceFormatted)}</span>
                  </div>
                </div>
              </div>
            )}

            {liq.isEmptyPool && amountA && amountB && (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px] text-amber-400" style={{ background: 'rgba(255,178,55,0.08)', border: '1px solid rgba(255,178,55,0.25)' }}>
                New field — you're the first farmer. You set the initial price and own 100% of the crop.
              </div>
            )}

            {/* Slippage */}
            <div className="mb-4">
              <span className="text-white/70 text-[11px] mb-1.5 block">Crop windstorm tolerance</span>
              <div className="flex gap-1.5">
                {SLIPPAGE_BPS.map(bps => (
                  <button key={bps} onClick={() => setSlippageBps(bps)} aria-pressed={slippageBps === bps}
                    className="flex-1 py-2 min-h-[40px] rounded-lg text-[11px] font-medium transition-all"
                    style={{
                      background: slippageBps === bps ? 'var(--color-purple-40)' : 'rgba(0,0,0,0.35)',
                      color: 'white',
                      border: slippageBps === bps ? '1px solid var(--color-purple-60)' : '1px solid rgba(255,255,255,0.12)',
                    }}>
                    {(bps / 100).toFixed(1)}%
                  </button>
                ))}
              </div>
            </div>

            {/* Action cascade */}
            {needsApproveA ? (
              <button onClick={() => liq.approveTokenA(amountA)} disabled={liq.isPending || liq.isConfirming}
                className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl">
                {liq.isPending ? 'Granting permission…' : `Approve ${tokenA.symbol}`}
              </button>
            ) : needsApproveB ? (
              <button onClick={() => liq.approveTokenB(amountB)} disabled={liq.isPending || liq.isConfirming}
                className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl">
                {liq.isPending ? 'Granting permission…' : `Approve ${tokenB.symbol}`}
              </button>
            ) : (
              <button onClick={() => liq.addLiquidity(amountA, amountB, slippageBps)}
                disabled={liq.isPending || liq.isConfirming || !amountA || !amountB || parseFloat(amountA) <= 0 || parseFloat(amountB) <= 0 || insufficientA || insufficientB}
                className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl disabled:opacity-40">
                {liq.isPending ? 'Confirm in wallet…'
                  : liq.isConfirming ? 'Growing the crop…'
                  : !amountA || !amountB ? 'Enter amounts'
                  : insufficientA ? `Not enough ${tokenA.symbol}`
                  : insufficientB ? `Not enough ${tokenB.symbol}`
                  : 'Grow the Crop'}
              </button>
            )}
          </>
        ) : (
          // REMOVE MODE
          <>
            <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-white/70 text-[11px]">Your LP in {tokenA.symbol} / {tokenB.symbol}</span>
                <span className="text-white/70 text-[10px] font-mono">{formatTokenAmount(liq.lpBalanceFormatted)} LP</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-white text-[24px] font-mono">{removePct}%</span>
                <span className="text-white/50 text-[11px]">of your position</span>
              </div>
              <input type="range" min="0" max="100" value={removePct} aria-label="Remove percentage"
                onChange={e => setRemovePct(parseInt(e.target.value))}
                disabled={!hasLP}
                className="w-full mt-2 accent-purple-500" />
              <div className="flex mt-1.5 gap-1.5">
                {[25, 50, 75, 100].map(pct => (
                  <button key={pct} onClick={() => setRemovePct(pct)} disabled={!hasLP} aria-pressed={removePct === pct}
                    className="flex-1 py-1.5 min-h-[36px] rounded-lg text-[10px] font-medium transition-all disabled:opacity-40"
                    style={{
                      background: removePct === pct ? 'var(--color-purple-40)' : 'rgba(0,0,0,0.45)',
                      color: 'white',
                      border: removePct === pct ? '1px solid var(--color-purple-60)' : '1px solid rgba(255,255,255,0.10)',
                    }}>
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            {removePct > 0 && hasLP && (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px]" style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.18)' }}>
                <div className="text-white/70 mb-1.5">You'll get back</div>
                <div className="flex justify-between text-white font-mono text-[12px]">
                  <span>{tokenA.symbol}</span>
                  <span>~{parseFloat(expectedRemoveA).toFixed(6)}</span>
                </div>
                <div className="flex justify-between text-white font-mono text-[12px] mt-0.5">
                  <span>{tokenB.symbol}</span>
                  <span>~{parseFloat(expectedRemoveB).toFixed(6)}</span>
                </div>
              </div>
            )}

            {/* Slippage for remove */}
            <div className="mb-4">
              <span className="text-white/70 text-[11px] mb-1.5 block">Slippage tolerance</span>
              <div className="flex gap-1.5">
                {SLIPPAGE_BPS.map(bps => (
                  <button key={bps} onClick={() => setSlippageBps(bps)} aria-pressed={slippageBps === bps}
                    className="flex-1 py-2 min-h-[40px] rounded-lg text-[11px] font-medium transition-all"
                    style={{
                      background: slippageBps === bps ? 'var(--color-purple-40)' : 'rgba(0,0,0,0.35)',
                      color: 'white',
                      border: slippageBps === bps ? '1px solid var(--color-purple-60)' : '1px solid rgba(255,255,255,0.12)',
                    }}>
                    {(bps / 100).toFixed(1)}%
                  </button>
                ))}
              </div>
            </div>

            {!liq.pairExists ? (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px] text-amber-400" style={{ background: 'rgba(255,178,55,0.08)', border: '1px solid rgba(255,178,55,0.25)' }}>
                No pool exists for this pair yet. Switch to Grow the Crop to plant one.
              </div>
            ) : !hasLP ? (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px] text-white/60" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)' }}>
                You don't hold any LP for this pair.
              </div>
            ) : null}

            {hasLP && (
              needsApproveLP ? (
                <button onClick={() => liq.approveLP(lpRemoveAmount)} disabled={liq.isPending || liq.isConfirming || removePct === 0}
                  className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl disabled:opacity-40">
                  {liq.isPending ? 'Granting permission…' : 'Approve LP'}
                </button>
              ) : (
                <button onClick={() => liq.removeLiquidity(lpRemoveAmount, slippageBps)}
                  disabled={liq.isPending || liq.isConfirming || removePct === 0}
                  className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl disabled:opacity-40">
                  {liq.isPending ? 'Confirm in wallet…'
                    : liq.isConfirming ? 'Harvesting…'
                    : removePct === 0 ? 'Move the slider'
                    : 'Pull Crop Out'}
                </button>
              )
            )}
          </>
        )}

        {liq.isSuccess && liq.hash && (
          <div className="mt-3 text-center text-emerald-400 text-[12px]">
            Confirmed! <a href={getTxUrl(chainId, liq.hash)} target="_blank" rel="noopener noreferrer" className="underline">View on Explorer</a>
          </div>
        )}
      </div>

      {showPicker && (
        <TokenSelectModal
          open={true}
          onClose={() => setShowPicker(null)}
          onSelect={handleTokenPick}
          disabledAddress={showPicker === 'A' ? tokenB.address : tokenA.address}
          customTokens={customTokens}
          onAddCustomToken={handleAddCustom}
        />
      )}
    </div>
  );
}
