import { useState, useEffect, useMemo } from 'react';
import { useAccount, useBalance, useChainId, useWalletClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { CONNECT_ETHEREUM_WALLET } from '../../lib/copy';
import { formatEther, formatUnits, parseUnits } from 'viem';
import { toast } from 'sonner';
import { useAddLiquidity } from '../../hooks/useAddLiquidity';
import { useUniswapV2MarketPrice, matchAtMarket, gapFromMarketBps, formatMarketPrice } from '../../hooks/useUniswapV2MarketPrice';
import { DEFAULT_TOKENS, defaultTokensFor, headlineTokenFor, type TokenInfo } from '../../lib/tokenList';
import { TokenSelectModal } from './TokenSelectModal';
import { getTxUrl } from '../../lib/explorer';
import { CHAIN_ID } from '../../lib/constants';
import { liquidityVenueOn } from '../../lib/chains/liquidityVenue';
import { CONFIGURED_CHAIN_IDS, getChainConfig } from '../../lib/chains/registry';
import { formatTokenAmount, formatNumber, shortenAddress } from '../../lib/formatting';
import { ArtImg } from '../ArtImg';
import { FinePrint } from '../ui/FinePrint';

export type LiquidityMode = 'add' | 'remove';

/** A pool picked from the page's pool list: the form opens on it, on that chain only. */
export interface LiquidityPick {
  readonly chainId: number;
  readonly a: TokenInfo;
  readonly b: TokenInfo;
  readonly mode: LiquidityMode;
}

/** "Ethereum, Base or Robinhood Chain": every chain the form runs on, read from the registry. */
const VENUE_CHAIN_NAMES = (() => {
  const names = CONFIGURED_CHAIN_IDS
    .filter((id) => liquidityVenueOn(id) !== null)
    .map((id) => (id === CHAIN_ID ? 'Ethereum' : getChainConfig(id)!.name));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? 'Ethereum');
})();

// Aligned with TradePage swap presets (0.1, 0.5, 1.0, 2.0%) so the surfaces
// don't surprise users who toggle between Swap and Liquidity tabs.
const SLIPPAGE_BPS = [10, 50, 100, 200] as const;

const blockNegativeKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === 'e') e.preventDefault();
};

/** A typed amount in base units, or null when it is empty, zero or does not parse. */
const toUnits = (v: string, decimals: number): bigint | null => {
  if (!v) return null;
  try {
    const n = parseUnits(v, decimals);
    return n > 0n ? n : null;
  } catch { return null; }
};

/** A gap under this many basis points reads as "matches the market". */
const MATCHES_BPS = 10;
/** From this gap up, the form says what opening off the market costs. */
const WARN_BPS = 300;

// MULTICHAIN (2026-08-20): chain-scoped key, matching useSwap's
// `tegridy_custom_tokens_v2_${CHAIN_ID}` pattern. The unscoped predecessor key
// ('tegridy_liquidity_custom_tokens') would have surfaced a Base-imported token
// in the mainnet picker the day per-chain trading opens. Liquidity is
// mainnet-pinned today, so scoping by the build-time constant loses nothing and
// pre-existing entries under the old key are simply ignored (re-import is cheap
// and re-validates against the chain — see H-33 below).
const customTokensKeyFor = (chainId: number) => `tegridy_liquidity_custom_tokens_${chainId}`;

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

function loadCustomTokens(chainId: number): TokenInfo[] {
  try {
    const raw = localStorage.getItem(customTokensKeyFor(chainId));
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

/**
 * `chainId`: the page's chain (useLiquidityChainId); without it, wagmi's chain as before.
 * The page keys this on the chain and on each pick, so a network change starts a fresh pair
 * and reloads that chain's pasted tokens, and `pick` (a pool from the page's list) opens it
 * on that pair and mode.
 */
export function LiquidityTab({ chainId: chainIdProp, pick }: { chainId?: number; pick?: LiquidityPick | null } = {}) {
  const { address, isConnected } = useAccount();
  const walletChainId = useChainId();
  const chainId = chainIdProp ?? walletChainId;
  const venue = useMemo(() => liquidityVenueOn(chainId), [chainId]);
  /**
   * Each chain's own list, the one its swap offers (lib/tokenList.ts defaultTokensFor):
   * Ethereum's curated list on Ethereum; ETH, WETH and USDC on Base; ETH and WETH on
   * Robinhood Chain. Never Ethereum's list off Ethereum: those are mainnet ERC20
   * addresses, the same symbol sits at a different address on Base, and this repo has
   * seven addresses that are a different live contract on another chain. A pasted
   * address still works on every chain.
   */
  const curatedTokens = useMemo(() => defaultTokensFor(chainId), [chainId]);

  const ethToken = DEFAULT_TOKENS.find(t => t.symbol === 'ETH')!;

  // A pick made on another chain is ignored: its addresses mean another contract here.
  const picked = pick && pick.chainId === chainId ? pick : null;
  const [mode, setMode] = useState<LiquidityMode>(picked?.mode ?? 'add');
  const [tokenA, setTokenA] = useState<TokenInfo>(picked?.a ?? ethToken);
  // Token B opens on the chain's headline token, the one the swap opens on (USDC on Base,
  // USDG on Robinhood Chain). Never Ethereum's TOWELI off Ethereum: that address holds no
  // token there, and the form opened on a balance it could not read. Null on a chain with
  // nothing listed but ETH and WETH: the visitor picks or pastes one.
  const [tokenB, setTokenB] = useState<TokenInfo | null>(() => picked?.b ?? headlineTokenFor(chainId));
  const symB = tokenB?.symbol ?? 'Token B';
  const decimalsB = tokenB?.decimals ?? 18;
  const [showPicker, setShowPicker] = useState<'A' | 'B' | null>(null);
  const [customTokens, setCustomTokens] = useState<TokenInfo[]>(() => loadCustomTokens(chainId));

  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [lastEdited, setLastEdited] = useState<'A' | 'B'>('A');
  const [removePct, setRemovePct] = useState(0);
  const [slippageBps, setSlippageBps] = useState<number>(50);

  const liq = useAddLiquidity(tokenA, tokenB, chainId);
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
      return { a: formatUnits(a, tokenA.decimals), b: formatUnits(b, decimalsB) };
    } catch { return null; }
  }, [liq.reserveA, liq.reserveB, liq.lpBalance, liq.lpTotalSupply, tokenA.decimals, decimalsB]);

  // Native ETH balance (useAddLiquidity reads the WETH ERC20 balance for native tokens,
  // which is wrong — user might hold ETH but no WETH). Fetch real native balance here.
  const { data: nativeBalanceA, isError: nativeBalanceAError } = useBalance({
    address, chainId: venue?.chainId ?? 0, query: { enabled: !!address && !!venue && tokenA.isNative },
  });
  const { data: nativeBalanceB, isError: nativeBalanceBError } = useBalance({
    address, chainId: venue?.chainId ?? 0, query: { enabled: !!address && !!venue && !!tokenB?.isNative },
  });

  const balanceADisplay = tokenA.isNative
    ? (nativeBalanceA ? parseFloat(formatUnits(nativeBalanceA.value, nativeBalanceA.decimals)) : 0)
    : parseFloat(liq.tokenABalanceFormatted || '0');
  const balanceBDisplay = tokenB?.isNative
    ? (nativeBalanceB ? parseFloat(formatUnits(nativeBalanceB.value, nativeBalanceB.decimals)) : 0)
    : parseFloat(liq.tokenBBalanceFormatted || '0');

  // OUTAGE-AS-EMPTY-WALLET. Both displays above collapse an unread balance to 0,
  // and here a 0 is a claim: "Balance: 0.0000", then "Not enough TOWELI" on the
  // CTA, about a wallet nobody read. A balance becomes a claim only once it was
  // READ; until then the figure is a dash and the CTA names the missing balance.
  // The CTA was already disabled in that state (0 is short of any amount), so no
  // control changes here - only what it asserts.
  const balanceAKnown = tokenA.isNative ? nativeBalanceA !== undefined : liq.tokenABalanceReadOk;
  const balanceBKnown = !tokenB ? false : tokenB.isNative ? nativeBalanceB !== undefined : liq.tokenBBalanceReadOk;
  const balanceAUnread = tokenA.isNative ? nativeBalanceAError : liq.tokenABalanceUnread;
  const balanceBUnread = !tokenB ? false : tokenB.isNative ? nativeBalanceBError : liq.tokenBBalanceUnread;

  // Opening a pool costs ETH on top of the deposit (owner ruling 2026-10-25). On an ETH pair
  // it rides on the ETH side; on a token/token pair the wallet still pays it in ETH, so that
  // balance is read here too. 0 whenever this add does not open a pool.
  const openingFee = liq.openingFeeWei ?? 0n;
  const openingFeeEth = parseFloat(formatEther(openingFee));
  const feeNeedsOwnBalance = liq.opensPoolWithFee && !tokenA.isNative && !tokenB?.isNative;
  const { data: nativeBalanceFee } = useBalance({
    address, chainId: venue?.chainId ?? 0, query: { enabled: !!address && !!venue && feeNeedsOwnBalance },
  });

  // Auto-pair inputs
  const handleAmountAChange = (v: string) => {
    setAmountA(v);
    setLastEdited('A');
    if (!liq.isEmptyPool) setAmountB(liq.getAmountB(v));
  };
  const handleAmountBChange = (v: string) => {
    setAmountB(v);
    setLastEdited('B');
    if (!liq.isEmptyPool) setAmountA(liq.getAmountA(v));
  };

  // A NEW pool opens at whatever price its two amounts set. Offer the market's: the
  // Uniswap V2 pool for the same pair on this chain (hooks/useUniswapV2MarketPrice.ts).
  // Only once the pool is KNOWN to be new: on a pool with reserves the amounts already
  // follow the pool's own price, and while that read is out nothing is known yet.
  const market = useUniswapV2MarketPrice(tokenA, tokenB, chainId, mode === 'add' && liq.knownNewPool);
  const marketChain = chainId === CHAIN_ID ? 'Ethereum' : (venue?.name ?? '');
  const pairLabel = `${tokenA.symbol}/${symB}`;
  const unitsA = toUnits(amountA, tokenA.decimals);
  const unitsB = tokenB ? toUnits(amountB, tokenB.decimals) : null;
  // The side typed last drives, as on Solana's Open a pool: Match fills the OTHER box.
  const matchFrom: 'A' | 'B' | null = lastEdited === 'B' && unitsB !== null ? 'B' : unitsA !== null ? 'A' : unitsB !== null ? 'B' : null;
  const matchMarket = () => {
    if (market.price.kind !== 'ok' || !tokenB) return;
    const { reserveA, reserveB } = market.price;
    if (matchFrom === 'A' && unitsA !== null) setAmountB(formatUnits(matchAtMarket(unitsA, reserveA, reserveB), tokenB.decimals));
    if (matchFrom === 'B' && unitsB !== null) setAmountA(formatUnits(matchAtMarket(unitsB, reserveB, reserveA), tokenA.decimals));
  };
  const marketGapBps = market.price.kind === 'ok' && unitsA !== null && unitsB !== null
    ? gapFromMarketBps(unitsA, unitsB, market.price.reserveA, market.price.reserveB)
    : null;
  const marketPrice = market.price.kind === 'ok'
    ? Number(formatUnits(market.price.reserveB, decimalsB)) / Number(formatUnits(market.price.reserveA, tokenA.decimals))
    : 0;

  // Reset amounts when token pair changes
  useEffect(() => {
    setAmountA(''); setAmountB(''); setRemovePct(0);
  }, [tokenA.address, tokenB?.address]);

  // LP amount derived from percent slider. Compute the burn from the EXACT on-chain LP
  // bigint (liq.lpBalance), not a lossy float of the formatted balance: at 100% this burns
  // exactly liq.lpBalance (float rounding could otherwise exceed it and revert the burn),
  // and tiny balances never round-trip through exponential strings that parseUnits rejects.
  // formatUnits(x,18) -> parseUnits(x,18) is exact, so downstream tx math is unchanged.
  const lpRemoveAmount = useMemo(() => {
    if (removePct === 0 || liq.lpBalance === 0n) return '';
    const lpWei = (liq.lpBalance * BigInt(removePct)) / 100n;
    if (lpWei === 0n) return '';
    return formatUnits(lpWei, 18);
  }, [removePct, liq.lpBalance]);

  // Approval checks — bigint-safe comparison
  const needsApproveA = useMemo(() => {
    if (tokenA.isNative || !amountA) return false;
    try {
      const needed = parseUnits(amountA, tokenA.decimals);
      return liq.tokenAAllowance < needed;
    } catch { return false; }
  }, [tokenA, amountA, liq.tokenAAllowance]);

  const needsApproveB = useMemo(() => {
    if (!tokenB || tokenB.isNative || !amountB) return false;
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
      return formatUnits((lp * liq.reserveB) / liq.lpTotalSupply, decimalsB);
    } catch { return '0'; }
  }, [lpRemoveAmount, liq.reserveB, liq.lpTotalSupply, decimalsB]);

  const poolShare = amountA ? liq.getPoolShare(amountA) : 0;

  const insufficientA = balanceAKnown && !!amountA
    && parseFloat(amountA) + (tokenA.isNative ? openingFeeEth : 0) > balanceADisplay;
  const insufficientB = balanceBKnown && !!amountB
    && parseFloat(amountB) + (tokenB?.isNative ? openingFeeEth : 0) > balanceBDisplay;
  const insufficientFee = feeNeedsOwnBalance && !!nativeBalanceFee && nativeBalanceFee.value < openingFee;
  const balanceUnknown = (!!amountA && !balanceAKnown) || (!!amountB && !balanceBKnown)
    || (feeNeedsOwnBalance && !nativeBalanceFee);
  // The fee is read from the factory; an add that opens a pool waits for it.
  const openingFeePending = liq.opensPoolWithFee && liq.openingFeeWei === undefined;

  const handleTokenPick = (tok: TokenInfo) => {
    if (showPicker === 'A') {
      if (tok.address.toLowerCase() === tokenB?.address.toLowerCase()) { setTokenB(tokenA); }
      setTokenA(tok);
    } else if (showPicker === 'B') {
      if (tokenB && tok.address.toLowerCase() === tokenA.address.toLowerCase()) { setTokenA(tokenB); }
      setTokenB(tok);
    }
    setShowPicker(null);
  };

  const handleAddCustom = (tok: TokenInfo) => {
    setCustomTokens(prev => {
      if (prev.some(t => t.address.toLowerCase() === tok.address.toLowerCase())) return prev;
      const next = [...prev, tok];
      try { localStorage.setItem(customTokensKeyFor(chainId), JSON.stringify(next)); } catch { /* ignore */ }
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
            Add
          </button>
          <button onClick={() => setMode('remove')} aria-pressed={mode === 'remove'}
            className="flex-1 px-3 py-2 min-h-[40px] rounded-lg text-[12px] font-medium transition-all"
            style={{ background: mode === 'remove' ? 'var(--color-purple-40)' : 'transparent', color: 'white', border: mode === 'remove' ? '1px solid var(--color-purple-60)' : '1px solid transparent' }}>
            Remove
          </button>
        </div>

        <p className="text-white/70 text-[11px] mb-4">
          {mode === 'add'
            ? 'Earn a cut of every swap through your pool. LP goes to your wallet.'
            : 'Burn your LP for the two underlying tokens.'}
        </p>

        {/* "Where did my LP go?" reassurance — shown whenever the user holds LP in this
            pair, in both Add and Remove modes. Directly answers the most common support
            question: the position is a token in your wallet, not lost. */}
        {isConnected && liq.lpUnread && (
          <div className="mb-4 rounded-xl p-3 text-[11px] text-amber-300" style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.35)' }}>
            Your LP balance could not be read. Any TGLP you hold is still in your
            wallet and still redeemable.
          </div>
        )}

        {isConnected && hasLP && (
          <div className="mb-4 rounded-xl p-3" style={{ background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.22)' }}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-emerald-300 text-[12px] font-semibold">🌿 Your liquidity is safe</span>
              <span className="text-white/70 text-[10px] font-mono">{formatTokenAmount(liq.lpBalanceFormatted)} TGLP</span>
            </div>
            <p className="text-white/75 text-[11px] leading-relaxed mb-2.5">
              It&apos;s in your wallet as <span className="font-mono text-white">TGLP</span>. Wallets hide
              tokens they don&apos;t recognize.
              {yourUnderlying && (
                <> Redeemable now for about{' '}
                  <span className="text-white font-mono">{parseFloat(yourUnderlying.a).toFixed(4)} {tokenA.symbol}</span> +{' '}
                  <span className="text-white font-mono">{parseFloat(yourUnderlying.b).toFixed(2)} {symB}</span>,
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

        {/* F201: wrong-network banner. The form runs only where our venue is deployed
            (Ethereum, Base, Robinhood Chain), so on any other chain pool data is empty
            by design. Tell the user to switch rather than letting them read "No pool
            exists" as the pair's truth. */}
        {isConnected && !liq.onRightChain && (
          <div className="mb-3 px-3 py-2 rounded-lg flex items-start gap-2"
            style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.35)' }}
            role="alert">
            <span className="text-warning text-[14px] leading-none mt-0.5" aria-hidden="true">&#9888;</span>
            <div className="text-warning text-[11px] leading-snug">
              <strong className="font-semibold">Wrong network</strong>{' — '}
              switch to {VENUE_CHAIN_NAMES} to view pool data and add or remove liquidity.
            </div>
          </div>
        )}

        {!isConnected ? (
          <div className="text-center py-8">
            <p className="text-white/70 text-[13px] mb-4">Connect a wallet to add liquidity.</p>
            <ConnectButton label={CONNECT_ETHEREUM_WALLET} />
          </div>
        ) : mode === 'add' ? (
          <>
            {/* Token A */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-white/70 text-[11px]">Token A</span>
                <span className="text-white/70 text-[10px] font-mono">Balance: {balanceAKnown ? balanceADisplay.toFixed(4) : '–'}</span>
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
                <span className="text-white/70 text-[10px] font-mono">Balance: {balanceBKnown ? balanceBDisplay.toFixed(4) : '–'}</span>
              </div>
              <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)' }}>
                <button onClick={() => setShowPicker('B')} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
                  {tokenB?.logoURI && <img src={tokenB.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                  <span className="text-white font-medium text-[14px]">{tokenB?.symbol ?? 'Select'}</span>
                  <span className="text-white/70">▾</span>
                </button>
                <input type="number" inputMode="decimal" placeholder="0.0" value={amountB}
                  onChange={e => handleAmountBChange(e.target.value)} onKeyDown={blockNegativeKey}
                  disabled={!tokenB}
                  className="flex-1 bg-transparent text-right text-white text-[18px] font-mono outline-none min-w-0" />
              </div>
            </div>

            {/* The market price a new pool can open at. Drawn only once the pool is known to
                be new (market.price is 'off' otherwise). */}
            {market.price.kind !== 'off' && (
              <div data-testid="liquidity-market" className="mb-3 rounded-lg p-3 text-[11px] space-y-2"
                style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}>
                <p className="text-white/80">
                  {market.price.kind === 'reading' && <>Market price: reading Uniswap V2 on {marketChain}…</>}
                  {market.price.kind === 'none' && <>No Uniswap V2 pool for {pairLabel} on {marketChain}, so there is no market price to match. You set the first price yourself.</>}
                  {market.price.kind === 'unread' && <>The market price could not be read from Uniswap V2 on {marketChain}.</>}
                  {market.price.kind === 'ok' && <>Market price (Uniswap V2 on {marketChain}): <span className="text-white font-mono">1 {tokenA.symbol} = {formatMarketPrice(marketPrice)} {symB}</span></>}
                </p>
                {market.price.kind === 'ok' && (
                  <button type="button" data-testid="liquidity-match" onClick={matchMarket} disabled={matchFrom === null}
                    className="w-full py-2 min-h-[40px] rounded-lg text-[12px] font-medium text-white transition-colors disabled:opacity-50"
                    style={{ background: 'var(--color-purple-40)', border: '1px solid var(--color-purple-60)' }}>
                    {matchFrom === null ? 'Type an amount to match the market price' : 'Match the market price'}
                  </button>
                )}
                {market.price.kind === 'unread' && (
                  <button type="button" onClick={market.readAgain}
                    className="w-full py-2 min-h-[40px] rounded-lg text-[12px] font-medium text-white"
                    style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}>
                    Read the market price again
                  </button>
                )}
                {marketGapBps !== null && (
                  <p data-testid="liquidity-market-gap" className={Math.abs(marketGapBps) >= WARN_BPS ? 'text-amber-300' : 'text-white/80'}>
                    {Math.abs(marketGapBps) < MATCHES_BPS
                      ? 'Your price matches the market.'
                      : <>Your price is {(Math.abs(marketGapBps) / 100).toFixed(1)}% {marketGapBps > 0 ? 'above' : 'below'} the market.{Math.abs(marketGapBps) >= WARN_BPS && ' Traders will trade your pool back to the market price, and you lose the difference.'}</>}
                  </p>
                )}
                {market.price.kind === 'ok' && (
                  <FinePrint summary="Where this price comes from">
                    <p>
                      The Uniswap V2 pool {shortenAddress(market.price.pair)} on {marketChain}, which
                      holds {formatTokenAmount(formatUnits(market.price.reserveA, tokenA.decimals))} {tokenA.symbol} and{' '}
                      {formatTokenAmount(formatUnits(market.price.reserveB, decimalsB))} {symB}. It is the pool our
                      swap compares against. A small pool&apos;s price can be far off: check it before you add.
                    </p>
                  </FinePrint>
                )}
              </div>
            )}

            {/* Pool stats — transparent so the page background shows through */}
            {liq.pairExists && !liq.isEmptyPool && (
              <div className="mb-3 rounded-lg p-3 text-[11px]" style={{ background: 'transparent', border: '1px solid rgba(16,185,129,0.18)' }}>
                <div className="flex justify-between text-white/70 mb-1">
                  <span>Your share of the pool</span>
                  <span className="text-emerald-400 font-mono">{poolShare.toFixed(4)}%</span>
                </div>
                <div className="flex justify-between text-white/70 mb-1">
                  <span>Rate</span>
                  <span className="text-white font-mono" title={liq.priceRatio > 0 ? `${liq.priceRatio.toFixed(8)} ${symB} per 1 ${tokenA.symbol}` : ''}>
                    1 {tokenA.symbol} {liq.priceRatio > 0 ? '≈' : '='} {liq.priceRatio > 0 ? formatNumber(liq.priceRatio, 4) : '—'} {symB}
                  </span>
                </div>
                <div className="flex justify-between text-white/70">
                  <span>Your LP tokens</span>
                  <span className="text-white font-mono">{formatTokenAmount(liq.lpBalanceFormatted)}</span>
                </div>
              </div>
            )}

            {liq.reservesUnread && (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px] text-amber-300" style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.35)' }}>
                This pair&apos;s reserves could not be read, so price and share are unknown.
                Reload before adding; it is not an empty pool.
              </div>
            )}

            {(balanceAUnread || balanceBUnread) && (
              <div data-testid="liquidity-balance-unread" className="mb-3 px-3 py-2 rounded-lg text-[11px] text-amber-300" style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.35)' }}>
                Your {[balanceAUnread && tokenA.symbol, balanceBUnread && symB].filter(Boolean).join(' and ')} balance
                could not be read. This is not a statement that you hold none; reload before adding.
              </div>
            )}

            {liq.isEmptyPool && amountA && amountB && (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px] text-amber-400" style={{ background: 'rgba(255,178,55,0.08)', border: '1px solid rgba(255,178,55,0.25)' }}>
                New field — you're the first farmer. You set the initial price and own 100% of the crop.
              </div>
            )}

            {/* Owner ruling 2026-10-25: opening a pool costs 0.006 ETH. Shown before any
                amount is typed, so the cost is known before the wallet asks for it. */}
            {liq.opensPoolWithFee && (
              <div data-testid="liquidity-opening-fee" className="mb-3 px-3 py-2 rounded-lg text-[11px] text-white/85" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.15)' }}>
                {liq.openingFeeWei !== undefined
                  ? <>Opening this pool costs {formatEther(liq.openingFeeWei)} ETH, paid to the Tegridy treasury on top of your deposit.</>
                  : liq.openingFeeUnread
                    ? <>The pool-opening fee could not be read. Reload before opening this pool.</>
                    : <>Reading the pool-opening fee…</>}
                <FinePrint summary="About this fee">
                  <p>
                    Only the deposit that opens a pool pays it. Adding to a pool that is already
                    open costs nothing extra. The fee is not part of your liquidity, and it does not
                    come back when you remove liquidity.
                  </p>
                </FinePrint>
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
                  price ratio diverges.
                </p>
                <FinePrint summary="How much">
                  <p>
                    A 2× move one way costs you ~5.7% vs. holding; a 4× move costs ~20%.
                    Fees earned must outweigh this drift for the position to be net
                    profitable. Don&apos;t LP volatile pairs with funds you need short-term.
                  </p>
                </FinePrint>
              </div>
            )}

            {/* Action cascade.
                `data-testid="liquidity-submit"` is on all FIVE actions below (approve A,
                approve B, add, approve LP, remove) because they share one position and
                swap in and out by state. e2e/liquidity.spec.ts used to find this button
                as `button:not([aria-pressed])` + `.last()`, which resolved correctly but
                POSITIONALLY — appending any button here would have silently retargeted
                the spec's submit onto something else and it would have gone on passing.
                Keep the attribute on every branch; a branch without it makes the spec
                skip that state. */}
            {needsApproveA ? (
              <button data-testid="liquidity-submit" onClick={() => liq.approveTokenA(amountA)} disabled={liq.isPending || liq.isConfirming}
                className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl">
                {liq.isPending ? 'Granting permission…' : `Approve ${tokenA.symbol}`}
              </button>
            ) : needsApproveB ? (
              <button data-testid="liquidity-submit" onClick={() => liq.approveTokenB(amountB)} disabled={liq.isPending || liq.isConfirming}
                className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl">
                {liq.isPending ? 'Granting permission…' : `Approve ${symB}`}
              </button>
            ) : (
              <button data-testid="liquidity-submit" onClick={() => liq.addLiquidity(amountA, amountB, slippageBps)}
                disabled={liq.isPending || liq.isConfirming || !amountA || !amountB || parseFloat(amountA) <= 0 || parseFloat(amountB) <= 0 || balanceUnknown || insufficientA || insufficientB || insufficientFee || openingFeePending}
                className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl disabled:opacity-40">
                {liq.isPending ? 'Confirm in wallet…'
                  : liq.isConfirming ? 'Adding…'
                  : !tokenB ? 'Pick token B'
                  : !amountA || !amountB ? 'Enter amounts'
                  : !balanceAKnown ? (balanceAUnread ? `${tokenA.symbol} balance unavailable — reload` : `Reading ${tokenA.symbol} balance…`)
                  : !balanceBKnown ? (balanceBUnread ? `${symB} balance unavailable — reload` : `Reading ${symB} balance…`)
                  : feeNeedsOwnBalance && !nativeBalanceFee ? 'Reading ETH balance…'
                  : openingFeePending ? (liq.openingFeeUnread ? 'Opening fee unavailable. Reload' : 'Reading the opening fee…')
                  : insufficientA ? (tokenA.isNative && openingFee > 0n ? `Not enough ETH (incl. ${formatEther(openingFee)} ETH to open)` : `Not enough ${tokenA.symbol}`)
                  : insufficientB ? (tokenB?.isNative && openingFee > 0n ? `Not enough ETH (incl. ${formatEther(openingFee)} ETH to open)` : `Not enough ${symB}`)
                  : insufficientFee ? `Not enough ETH for the ${formatEther(openingFee)} ETH opening fee`
                  : liq.opensPoolWithFee ? `Open pool (+${formatEther(openingFee)} ETH)`
                  : 'Add liquidity'}
              </button>
            )}
          </>
        ) : (
          // REMOVE MODE
          <>
            <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.10)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-white/70 text-[11px]">Your LP in {tokenA.symbol} / {symB}</span>
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
                  <span>{symB}</span>
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
                No pool exists for this pair yet. Switch to Add to open one.
              </div>
            ) : liq.lpUnread ? (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px] text-amber-300" style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.35)' }}>
                Your LP balance could not be read. This is not a statement that you hold
                none. Reload; the controls stay disabled until the balance is known.
              </div>
            ) : !hasLP ? (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px] text-white/60" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)' }}>
                You don't hold any LP for this pair.
              </div>
            ) : null}

            {hasLP && (
              needsApproveLP ? (
                <button data-testid="liquidity-submit" onClick={() => liq.approveLP(lpRemoveAmount)} disabled={liq.isPending || liq.isConfirming || removePct === 0}
                  className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl disabled:opacity-40">
                  {liq.isPending ? 'Granting permission…' : 'Approve LP'}
                </button>
              ) : (
                <button data-testid="liquidity-submit" onClick={() => liq.removeLiquidity(lpRemoveAmount, slippageBps)}
                  disabled={liq.isPending || liq.isConfirming || removePct === 0}
                  className="w-full btn-primary py-3 min-h-[48px] text-[14px] font-semibold rounded-xl disabled:opacity-40">
                  {liq.isPending ? 'Confirm in wallet…'
                    : liq.isConfirming ? 'Removing…'
                    : removePct === 0 ? 'Move the slider'
                    : 'Remove liquidity'}
                </button>
              )
            )}
          </>
        )}

        {/* `isLiquidityReceipt` bars an APPROVAL from rendering this — see the note in
            useAddLiquidity. "Confirmed!" under a form that still has an unsent add is
            the "looks finished but it's only an approval" read FarmPage already closed. */}
        {liq.isSuccess && liq.hash && liq.isLiquidityReceipt && (
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
          disabledAddress={showPicker === 'A' ? tokenB?.address : tokenA.address}
          customTokens={customTokens}
          tokens={curatedTokens}
          chainId={chainId}
          onAddCustomToken={handleAddCustom}
        />
      )}
    </div>
  );
}
