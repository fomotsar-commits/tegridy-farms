// Buy/sell surface for a token on the OWN curve (TegridyCurveLauncher). Every
// number shown is computed by the SAME bigint math the contract runs
// (lib/launcher/curve.ts) — so the quote and the `minOut` inside the calldata
// agree to the wei, and the panel never shows an "≈". A buy is one payable tx; a
// sell needs a one-time ERC-20 approval first, so the panel reads allowance and
// offers Approve before Sell rather than shipping a tx that would revert.
//
// The presentational core (CurveTradeView) is pure and prop-driven so it tests
// without a wallet; the container wires the reads/writes.

import { useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import { formatEther, maxUint256, type Address } from 'viem';
import { CHAIN_ID } from '../../lib/constants';
import { sanitizeDecimalInput } from '../../lib/formatting';
import { safeParseEtherPositive } from '../../lib/safeParseEther';
import {
  CURVE_LAUNCHER_ABI,
  previewBuy,
  previewSell,
  splitFee,
  graduationProgressBps,
  withSlippage,
  type CurveLaunch,
} from '../../lib/launcher/curve';

const ERC20_MIN_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

const SLIPPAGE_PRESETS = [50, 100, 300] as const; // 0.5% / 1% / 3%
const cardStyle = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;
const inputCls = 'w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[13px] font-mono outline-none';
const inputStyle = { border: '1px solid rgba(255,255,255,0.18)' } as const;

type Side = 'buy' | 'sell';

function fmt(wei: bigint, dp = 6): string {
  const s = formatEther(wei);
  const dot = s.indexOf('.');
  if (dot === -1) return s;
  const frac = s.slice(dot + 1, dot + 1 + dp);
  return frac ? `${s.slice(0, dot)}.${frac}` : s.slice(0, dot);
}

// ─────────────────────────────── presentational core ───────────────────────────────

export interface CurveTradeViewProps {
  launch: CurveLaunch;
  tokenSymbol: string;
  nativeSymbol?: string;
  /** Wallet's balance of the launch token (for the sell tab). */
  tokenBalance?: bigint;
  /** True when a sell needs an ERC-20 approval before it can run. */
  needsApproval: boolean;
  pending: boolean;
  onBuy: (ethGross: bigint, minTokensOut: bigint) => void;
  onSell: (tokensIn: bigint, minEthOut: bigint) => void;
  onApprove: () => void;
}

export function CurveTradeView({
  launch,
  tokenSymbol,
  nativeSymbol = 'ETH',
  tokenBalance,
  needsApproval,
  pending,
  onBuy,
  onSell,
  onApprove,
}: CurveTradeViewProps) {
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(100);

  const amountWei = useMemo(() => safeParseEtherPositive(amount), [amount]);
  const progress = graduationProgressBps(launch.ethReserve, launch.graduationEth);

  // Compute the quote for the active side, entirely client-side.
  const quote = useMemo(() => {
    if (amountWei === null) return null;
    if (side === 'buy') {
      const q = previewBuy(launch, amountWei);
      return {
        out: q.tokensOut,
        outLabel: tokenSymbol,
        fee: q.fee,
        minOut: withSlippage(q.tokensOut, slippageBps),
        wouldGraduate: q.wouldGraduate,
        dust: q.tokensOut === 0n,
      };
    }
    const q = previewSell(launch, amountWei);
    return {
      out: q.ethOut,
      outLabel: nativeSymbol,
      fee: q.fee,
      minOut: withSlippage(q.ethOut, slippageBps),
      wouldGraduate: false,
      dust: q.ethOut === 0n,
    };
  }, [amountWei, side, launch, slippageBps, tokenSymbol, nativeSymbol]);

  const fees = quote ? splitFee(quote.fee, launch.creatorFeeShareBps, launch.treasuryFeeShareBps) : null;

  if (launch.graduated) {
    return (
      <div className="rounded-2xl p-5" style={cardStyle}>
        <p className="text-white/90 text-sm font-semibold">This launch has graduated 🎓</p>
        <p className="text-white/60 text-[12px] mt-1 leading-relaxed">
          The curve is closed. Its liquidity is live in the Tegridy pool with the LP burned to
          <span className="font-mono"> 0x…dEaD</span> — trade it on the swap, not here.
        </p>
      </div>
    );
  }

  const insufficientBalance =
    side === 'sell' && tokenBalance !== undefined && amountWei !== null && amountWei > tokenBalance;
  const disabled =
    pending || amountWei === null || quote === null || quote.dust || insufficientBalance;

  const act = () => {
    if (amountWei === null || quote === null) return;
    if (side === 'buy') onBuy(amountWei, quote.minOut);
    else if (needsApproval) onApprove();
    else onSell(amountWei, quote.minOut);
  };

  const actionLabel = pending
    ? 'Confirm in wallet…'
    : side === 'buy'
      ? `Buy ${tokenSymbol}`
      : needsApproval
        ? `Approve ${tokenSymbol}`
        : `Sell ${tokenSymbol}`;

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl p-5 space-y-4"
      style={cardStyle}
    >
      {/* Graduation progress */}
      <div>
        <div className="flex justify-between text-[11px] text-white/60 mb-1">
          <span>Graduation progress</span>
          <span className="font-mono">
            {fmt(launch.ethReserve, 4)} / {fmt(launch.graduationEth, 4)} {nativeSymbol}
          </span>
        </div>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={10000}>
          <div
            className="h-full rounded-full"
            style={{ width: `${progress / 100}%`, background: 'var(--color-stan, #7dd3fc)' }}
          />
        </div>
      </div>

      {/* Buy / Sell toggle */}
      <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-black/40">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`py-1.5 rounded-md text-xs font-semibold transition ${
              side === s ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'
            }`}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      {/* Amount */}
      <div>
        <div className="flex justify-between text-[11px] text-white/55 mb-1">
          <span>{side === 'buy' ? `Spend (${nativeSymbol})` : `Sell (${tokenSymbol})`}</span>
          {side === 'sell' && tokenBalance !== undefined && (
            <button type="button" className="hover:text-white/90 font-mono" onClick={() => setAmount(formatEther(tokenBalance))}>
              max {fmt(tokenBalance, 4)}
            </button>
          )}
        </div>
        <input
          className={inputCls}
          style={inputStyle}
          inputMode="decimal"
          aria-label={side === 'buy' ? `Amount to spend in ${nativeSymbol}` : `Amount of ${tokenSymbol} to sell`}
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value))}
        />
      </div>

      {/* Slippage */}
      <div className="flex items-center gap-2 text-[11px] text-white/55">
        <span>Max slippage</span>
        {SLIPPAGE_PRESETS.map((bps) => (
          <button
            key={bps}
            type="button"
            onClick={() => setSlippageBps(bps)}
            className={`px-2 py-0.5 rounded font-mono transition ${
              slippageBps === bps ? 'bg-white/15 text-white' : 'bg-black/40 text-white/50 hover:text-white/80'
            }`}
          >
            {bps / 100}%
          </button>
        ))}
      </div>

      {/* Quote */}
      {quote && amountWei !== null && (
        <div className="rounded-lg p-3 text-[12px] space-y-1" style={{ background: 'rgba(0,0,0,0.35)' }}>
          <Row label="You receive" value={`${fmt(quote.out)} ${quote.outLabel}`} strong />
          <Row label={`Min received (${slippageBps / 100}% slip)`} value={`${fmt(quote.minOut)} ${quote.outLabel}`} />
          <Row label={`Fee (${launch.feeBps / 100}%)`} value={`${fmt(quote.fee)} ${nativeSymbol}`} />
          {fees && (
            <div className="pl-3 text-white/45 space-y-0.5">
              <Row label="↳ creator" value={fmt(fees.creatorCut)} sub />
              <Row label="↳ Jungle Bay treasury" value={fmt(fees.treasuryCut)} sub />
              <Row label="↳ protocol" value={fmt(fees.protocolCut)} sub />
            </div>
          )}
          {quote.wouldGraduate && (
            <p className="text-emerald-300/90 text-[11px] pt-1">This buy completes the curve — it graduates into the Tegridy pool.</p>
          )}
          {quote.dust && <p className="text-amber-300/90 text-[11px] pt-1">Amount too small to trade.</p>}
          {insufficientBalance && <p className="text-red-300/90 text-[11px] pt-1">Exceeds your balance.</p>}
        </div>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={act}
        className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-50"
      >
        {actionLabel}
      </button>
    </m.div>
  );
}

function Row({ label, value, strong, sub }: { label: string; value: string; strong?: boolean; sub?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={sub ? 'text-white/45' : 'text-white/55'}>{label}</span>
      <span className={`font-mono ${strong ? 'text-white font-semibold' : sub ? 'text-white/60' : 'text-white/80'}`}>{value}</span>
    </div>
  );
}

// ────────────────────────────────── wired container ────────────────────────────────

export interface CurveTradePanelProps {
  launcher: Address;
  token: Address;
  tokenSymbol?: string;
}

/** Parse the getLaunch tuple viem returns (named components → object) into CurveLaunch. */
function toCurveLaunch(raw: unknown): CurveLaunch | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.creator !== 'string') return null;
  return {
    creator: l.creator as Address,
    virtualEth: BigInt(l.virtualEth as bigint),
    graduationEth: BigInt(l.graduationEth as bigint),
    feeBps: Number(l.feeBps),
    creatorFeeShareBps: Number(l.creatorFeeShareBps),
    treasuryFeeShareBps: Number(l.treasuryFeeShareBps),
    reserveRecipient: l.reserveRecipient as Address,
    saleSupply: BigInt(l.saleSupply as bigint),
    reserveAmount: BigInt(l.reserveAmount as bigint),
    ethReserve: BigInt(l.ethReserve as bigint),
    tokenReserve: BigInt(l.tokenReserve as bigint),
    graduated: Boolean(l.graduated),
  };
}

export function CurveTradePanel({ launcher, token, tokenSymbol = 'TOKEN' }: CurveTradePanelProps) {
  const { address: account } = useAccount();
  const { writeContract, isPending } = useWriteContract();

  const { data: launchRaw } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'getLaunch',
    args: [token],
    chainId: CHAIN_ID,
    query: { refetchInterval: 15_000 },
  });
  const { data: balance } = useReadContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(account) },
  });
  const { data: allowance } = useReadContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'allowance',
    args: account ? [account, launcher] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(account) },
  });

  const launch = useMemo(() => toCurveLaunch(launchRaw), [launchRaw]);
  if (!launch) {
    return (
      <div className="rounded-2xl p-5 text-white/60 text-[13px]" style={cardStyle}>
        Loading the curve…
      </div>
    );
  }

  const tokenBalance = typeof balance === 'bigint' ? balance : undefined;
  const currentAllowance = typeof allowance === 'bigint' ? allowance : 0n;

  const onBuy = (ethGross: bigint, minTokensOut: bigint) => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'buy', args: [token, minTokensOut], value: ethGross },
      {
        onSuccess: () => toast.success('Buy submitted.'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the buy.'),
      },
    );
  };
  const onApprove = () => {
    writeContract(
      { address: token, abi: ERC20_MIN_ABI, functionName: 'approve', args: [launcher, maxUint256] },
      {
        onSuccess: () => toast.success('Approval submitted — confirm, then sell.'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the approval.'),
      },
    );
  };
  const onSell = (tokensIn: bigint, minEthOut: bigint) => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'sell', args: [token, tokensIn, minEthOut] },
      {
        onSuccess: () => toast.success('Sell submitted.'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the sell.'),
      },
    );
  };

  // A sell needs approval when the allowance can't cover the whole balance
  // (we approve maxUint256, so once approved this is false forever).
  const needsApproval = tokenBalance !== undefined && currentAllowance < tokenBalance;

  return (
    <CurveTradeView
      launch={launch}
      tokenSymbol={tokenSymbol}
      tokenBalance={tokenBalance}
      needsApproval={needsApproval}
      pending={isPending}
      onBuy={onBuy}
      onSell={onSell}
      onApprove={onApprove}
    />
  );
}
