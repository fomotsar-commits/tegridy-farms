import { useState, useEffect, useMemo } from 'react';
import { useAccount, useBalance, useChainId, useWalletClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatUnits, parseUnits } from 'viem';
import { toast } from 'sonner';
import { useAddLiquidity } from '../../hooks/useAddLiquidity';
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';
import { TokenSelectModal } from './TokenSelectModal';
import { getTxUrl } from '../../lib/explorer';
import { formatTokenAmount, formatNumber } from '../../lib/formatting';
import { ArtImg } from '../ArtImg';

type LiquidityMode = 'add' | 'remove';

// Aligned with TradePage swap presets (0.1, 0.5, 1.0, 2.0%) so the surfaces
// don't surprise users who toggle between Swap and Liquidity tabs.
const SLIPPAGE_BPS = [10, 50, 100, 200] as const;

const blockNegativeKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === 'e') e.preventDefault();
};

const CUSTOM_TOKENS_KEY = 'tegridy_liquidity_custom_tokens';

// AUDIT FIX 2026-05-26 [H-33]: validate rehydrated custom tokens before
// trusting them. Pre-fix, a malicious browser extension that wrote a
// spoofed entry (`{symbol:"USDC", address:"0xATTACKER", decimals:6}`) to
// localStorage would silently surface in the picker and the user would
// approve LP additions against the attacker contract. Mirrors the
// equivalent rehydrate validation in `useSwap.ts` (D-FE-L1/L2 hardening).
const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
// SELF-AUDIT FIX 2026-05-26 [H-33]: relaxed from /^[A-Z0-9]{1,12}$/ which
// rejected legitimate mixed-case LSDs (stETH, wstETH, rETH, cbETH); even
// DEFAULT_TOKENS includes `stETH` so the strict-uppercase form would have
// dropped the canonical Lido token symbol on rehydrate. Allow ASCII alphanum
// (case-insensitive) — Unicode lookalikes remain rejected by the explicit
// regex bounds, and the default-symbol collision check below uses
// `.toUpperCase()` so case-permutation spoofs are still caught.
const SAFE_SYMBOL_RE = /^[A-Za-z0-9]{1,12}$/;

function isValidCustomToken(t: unknown): t is TokenInfo {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  if (typeof o.address !== 'string' || !ETH_ADDR_RE.test(o.address)) return false;
  if (typeof o.symbol !== 'string' || !SAFE_SYMBOL_RE.test(o.symbol)) return false;
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 64) return false;
  if (typeof o.decimals !== 'number' || o.decimals < 0 || o.decimals > 36 || !Number.isInteger(o.decimals)) return false;
  if (typeof o.logoURI !== 'string') return false;
  if (o.isNative !== undefined && typeof o.isNative !== 'boolean') return false;
  // Reject the native-ETH pseudo-address from being spoofed by a non-native entry.
  if (o.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' && !o.isNative) return false;
  return true;
}

function loadCustomTokens(): TokenInfo[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TOKENS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate per-entry AND filter out any symbol that collides with the
    // canonical DEFAULT_TOKENS list (anti-spoof; a custom "USDC" must be
    // rejected because the default-list USDC at 0xA0b8... is authoritative).
    const defaultSymbols = new Set(DEFAULT_TOKENS.map((t) => t.symbol.toUpperCase()));
    const seenAddrs = new Set<string>();
    const filtered = parsed.filter((entry: unknown) => {
      if (!isValidCustomToken(entry)) return false;
      if (defaultSymbols.has(entry.symbol.toUpperCase())) return false;
      const addrLower = entry.address.toLowerCase();
      if (seenAddrs.has(addrLower)) return false;
      seenAddrs.add(addrLower);
      return true;
    });
    return filtered as TokenInfo[];
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
  const { data: walletClient } = useWalletClient();

  // The #1 source of "my LP disappeared" confusion: the LP receipt is a plain ERC-20
  // (symbol "TGLP") at the pair address, and wallets hide tokens they don't recognize.
  // This one-tap import (EIP-747 watchAsset) makes the position visible in-wallet.
  const addLpToWallet = async () => {
    if (!liq.pairAddress) return;
    if (!walletClient) { toast.error('Connect a wallet that supports adding tokens'); return; }
    try {
      await walletClient.watchAsset({
        type: 'ERC20',
        options: { address: liq.pairAddress as `0x${string}`, symbol: 'TGLP', decimals: 18 },
      });
    } catch {
      // User declined the wallet prompt, or the wallet doesn't support watchAsset — no-op.
    }
  };

  // The two underlying tokens this LP position is currently redeemable for (pro-rata
  // share of reserves), so users see what their TGLP is actually "worth" right now.
  const yourUnderlying = useMemo(() => {
    if (liq.lpTotalSupply === 0n || liq.lpBalance === 0n) return null;
    try {
      const a = (liq.reserveA * liq.lpBalance) / liq.lpTotalSupply;
      const b = (liq.reserveB * liq.lpBalance) / liq.lpTotalSupply;
      return { a: formatUnits(a, tokenA.decimals), b: formatUnits(b, tokenB.decimals) };
    } catch { return null; }
  }, [liq.reserveA, liq.reserveB, liq.lpBalance, liq.lpTotalSupply, tokenA.decimals, tokenB.decimals]);

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
        <ArtImg pageId="liquidity-tab" idx={0} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
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

        {/* "Where did my LP go?" reassurance — shown whenever the user holds LP in this
            pair, in both Add and Remove modes. Directly answers the most common support
            question: the position is a token in your wallet, not lost. */}
        {isConnected && hasLP && (
          <div className="mb-4 rounded-xl p-3" style={{ background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.22)' }}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-emerald-300 text-[12px] font-semibold">🌿 Your liquidity is safe</span>
              <span className="text-white/70 text-[10px] font-mono">{formatTokenAmount(liq.lpBalanceFormatted)} TGLP</span>
            </div>
            <p className="text-white/75 text-[11px] leading-relaxed mb-2.5">
              It lives in your wallet as a token called <span className="font-mono text-white">TGLP</span> — it didn't
              disappear, wallets just hide tokens they don't recognize.
              {yourUnderlying && (
                <> Redeemable right now for about{' '}
                  <span className="text-white font-mono">{parseFloat(yourUnderlying.a).toFixed(4)} {tokenA.symbol}</span> +{' '}
                  <span className="text-white font-mono">{parseFloat(yourUnderlying.b).toFixed(2)} {tokenB.symbol}</span>,
                  and it earns a cut of every swap through the pool.</>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={addLpToWallet}
                className="px-3 py-1.5 min-h-[34px] rounded-lg text-[11px] font-medium transition-colors"
                style={{ background: 'var(--color-weed-20, rgba(45,139,78,0.25))', color: 'white', border: '1px solid var(--color-weed-60, rgba(45,139,78,0.55))' }}>
                + Add TGLP to wallet
              </button>
              {mode === 'add' && (
                <button onClick={() => setMode('remove')}
                  className="px-3 py-1.5 min-h-[34px] rounded-lg text-[11px] font-medium text-white/80 hover:text-white transition-colors"
                  style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  Withdraw it
                </button>
              )}
            </div>
          </div>
        )}

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

            {/* Pool stats — transparent so the page background shows through */}
            {liq.pairExists && !liq.isEmptyPool && (
              <div className="mb-3 rounded-lg p-3 text-[11px]" style={{ background: 'transparent', border: '1px solid rgba(16,185,129,0.18)' }}>
                <div className="flex justify-between text-white/70 mb-1">
                  <span>Your share of the pool</span>
                  <span className="text-emerald-400 font-mono">{poolShare.toFixed(4)}%</span>
                </div>
                <div className="flex justify-between text-white/70 mb-1">
                  <span>Rate</span>
                  <span className="text-white font-mono" title={liq.priceRatio > 0 ? `${liq.priceRatio.toFixed(8)} ${tokenB.symbol} per 1 ${tokenA.symbol}` : ''}>
                    1 {tokenA.symbol} {liq.priceRatio > 0 ? '≈' : '='} {liq.priceRatio > 0 ? formatNumber(liq.priceRatio, 4) : '—'} {tokenB.symbol}
                  </span>
                </div>
                <div className="flex justify-between text-white/70">
                  <span>Your LP tokens</span>
                  <span className="text-white font-mono">{formatTokenAmount(liq.lpBalanceFormatted)}</span>
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

            {/* AUDIT LP-UX: impermanent-loss disclosure. The add-liquidity
                flow used to ship users into an AMM LP position without any
                mention of IL risk. Only shown once the user has entered
                non-trivial amounts on an existing pair — first-pool seeders
                already see a separate "you set the initial price" banner
                above, and showing two risk callouts stacked is noise. */}
            {liq.pairExists && !liq.isEmptyPool && amountA && amountB &&
             parseFloat(amountA) > 0 && parseFloat(amountB) > 0 && (
              <div
                role="note"
                className="mb-4 px-3 py-2.5 rounded-lg text-[11.5px] leading-relaxed"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}
              >
                <p className="text-amber-300 font-semibold mb-0.5">Heads up — impermanent loss</p>
                <p className="text-white/80">
                  LP positions lose value vs. just holding the two tokens when their
                  price ratio diverges. A 2× move one way costs you ~5.7% vs. holding;
                  a 4× move costs ~20%. Fees earned must outweigh this drift for the
                  position to be net profitable. Don't LP volatile pairs with funds
                  you need short-term.
                </p>
              </div>
            )}

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
