// Buy/sell surface for a token on the OWN curve (TegridyCurveLauncher). Every
// number shown is computed by the SAME bigint math the contract runs
// (lib/launcher/curve.ts) — so the quote and the `minOut` inside the calldata
// agree to the wei, and the panel never shows an "≈". A buy is one payable tx; a
// sell needs a one-time ERC-20 approval first, so the panel reads allowance and
// offers Approve before Sell rather than shipping a tx that would revert.
//
// The presentational core (CurveTradeView) is pure and prop-driven so it tests
// without a wallet; the container wires the reads/writes.

import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { toast } from 'sonner';
import { formatEther, maxUint256, type Address } from 'viem';
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
import {
  twitterUrl,
  telegramUrl,
  type CurveIdentityResolution,
} from '../../lib/launcher/curveIdentity';
import { useCurveIdentity } from '../../hooks/useCurveIdentity';

const ERC20_MIN_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  // create() stored the real name/symbol IN the token contract — the honest
  // fallback when the Irys identity is missing (a launch is never "TOKEN").
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
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
  /** On-chain ERC20 name — the honest header fallback when identity is absent. */
  fallbackName?: string;
  nativeSymbol?: string;
  /** Creator-published identity (image/description/socials), when resolved.
   *  Absent/none renders an honest monogram tile — never a fabricated image. */
  identity?: CurveIdentityResolution;
  /** Wallet's balance of the launch token (for the sell tab). */
  tokenBalance?: bigint;
  /** True when a sell needs an ERC-20 approval before it can run. */
  needsApproval: boolean;
  pending: boolean;
  /** True from tx submission until the RECEIPT lands — the 08-24 receipt-status
   *  standard: "submitted" is not "done", and a revert must come back as a red
   *  toast, not silence. The container drives this. */
  mining?: boolean;
  /** Deferred graduation (audit find): the contract rejects every buy with
   *  CurveComplete once ethReserve >= graduationEth even while `graduated` is
   *  still false (a third party can force this window by LP-minting into the
   *  pair pre-graduation). Buys must be disabled with an explanation instead of
   *  inviting guaranteed-revert gas burns; sells stay open; the permissionless
   *  finalize call gets its first UI surface here. */
  deferredGraduation?: boolean;
  onFinalizeGraduation?: () => void;
  onBuy: (ethGross: bigint, minTokensOut: bigint) => void;
  onSell: (tokensIn: bigint, minEthOut: bigint) => void;
  onApprove: () => void;
}

/** Image-or-monogram identity header. The monogram is the explicit no-image
 *  state (resolving, none, invalid, error, or a broken image URL). */
function IdentityHeader({
  identity,
  tokenSymbol,
  fallbackName,
}: {
  identity?: CurveIdentityResolution;
  tokenSymbol: string;
  fallbackName?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const ok = identity?.status === 'ok' ? identity.identity : null;
  const monogram = (ok?.symbol ?? tokenSymbol).slice(0, 3).toUpperCase();
  const showImage = ok !== null && !imgFailed;
  return (
    <div className="flex items-center gap-3">
      {showImage ? (
        <img
          src={ok.imageUrl}
          alt={`${ok.name} token image`}
          className="w-12 h-12 rounded-xl object-cover shrink-0"
          style={{ border: '1px solid rgba(255,255,255,0.14)' }}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div
          aria-hidden="true"
          className={`w-12 h-12 rounded-xl shrink-0 flex items-center justify-center bg-black/50 text-white/45 text-[12px] font-mono font-semibold ${
            identity?.status === 'resolving' ? 'animate-pulse' : ''
          }`}
          style={{ border: '1px solid rgba(255,255,255,0.14)' }}
        >
          {monogram}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-white/90 text-sm font-semibold truncate">
          {ok ? ok.name : (fallbackName ?? tokenSymbol)}
          {ok && <span className="text-white/45 font-mono font-normal text-[12px]"> · {ok.symbol}</span>}
        </p>
        {ok?.description && (
          <p className="text-white/55 text-[11px] leading-snug line-clamp-2">{ok.description}</p>
        )}
        {ok && (ok.website || ok.twitter || ok.telegram) && (
          <p className="text-[11px] space-x-2 mt-0.5">
            {ok.website && (
              <a className="text-sky-300/80 hover:text-sky-200" href={ok.website} target="_blank" rel="noopener noreferrer">
                website
              </a>
            )}
            {ok.twitter && (
              <a className="text-sky-300/80 hover:text-sky-200" href={twitterUrl(ok.twitter)} target="_blank" rel="noopener noreferrer">
                @{ok.twitter}
              </a>
            )}
            {ok.telegram && (
              <a className="text-sky-300/80 hover:text-sky-200" href={telegramUrl(ok.telegram)} target="_blank" rel="noopener noreferrer">
                telegram
              </a>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export function CurveTradeView({
  launch,
  tokenSymbol,
  fallbackName,
  nativeSymbol = 'ETH',
  identity,
  tokenBalance,
  needsApproval,
  pending,
  mining = false,
  deferredGraduation = false,
  onFinalizeGraduation,
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
      <div className="rounded-2xl p-5 space-y-3" style={cardStyle}>
        <IdentityHeader identity={identity} tokenSymbol={tokenSymbol} fallbackName={fallbackName} />
        <p className="text-white/90 text-sm font-semibold">This launch has graduated 🎓</p>
        <p className="text-white/60 text-[12px] mt-1 leading-relaxed">
          The curve is closed. Its liquidity is live in our own pool with the LP burned to
          <span className="font-mono"> 0x…dEaD</span> —{' '}
          <Link to="/swap" className="text-sky-300/80 hover:text-sky-200 underline underline-offset-2">
            trade it on the venue swap
          </Link>
          , not here.
        </p>
      </div>
    );
  }

  const insufficientBalance =
    side === 'sell' && tokenBalance !== undefined && amountWei !== null && amountWei > tokenBalance;
  const buyClosedByDeferral = deferredGraduation && side === 'buy';
  const disabled =
    pending || buyClosedByDeferral || amountWei === null || quote === null || quote.dust || insufficientBalance;

  const act = () => {
    if (amountWei === null || quote === null) return;
    if (side === 'buy') onBuy(amountWei, quote.minOut);
    else if (needsApproval) onApprove();
    else onSell(amountWei, quote.minOut);
  };

  const actionLabel = pending
    ? mining
      ? 'Confirming on-chain…'
      : 'Confirm in wallet…'
    : buyClosedByDeferral
      ? 'Buys closed — curve at target'
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
      <IdentityHeader identity={identity} tokenSymbol={tokenSymbol} fallbackName={fallbackName} />

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

      {deferredGraduation && (
        <div className="rounded-lg p-3 space-y-2" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)' }}>
          <p className="text-emerald-200/90 text-[12px] leading-relaxed">
            The curve hit its raise target but graduation hasn't been finalized yet. Buys are
            closed (the contract rejects them); sells still work. Anyone may finalize —
            it seeds our own pool and burns the LP.
          </p>
          {onFinalizeGraduation && (
            <button
              type="button"
              disabled={pending}
              onClick={onFinalizeGraduation}
              className="btn-primary px-3 py-1.5 min-h-[44px] md:min-h-0 text-[12px] disabled:opacity-50"
            >
              {pending ? (mining ? 'Confirming on-chain…' : 'Confirm in wallet…') : 'Finalize graduation'}
            </button>
          )}
        </div>
      )}

      {/* Buy / Sell toggle */}
      <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-black/40">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`py-1.5 min-h-[44px] md:min-h-0 rounded-md text-xs font-semibold transition ${
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
            <button type="button" className="hover:text-white/90 font-mono px-3 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 inline-flex items-center justify-center" onClick={() => setAmount(formatEther(tokenBalance))}>
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
            className={`px-2 py-0.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded font-mono transition ${
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
            <p className="text-emerald-300/90 text-[11px] pt-1">This buy completes the curve — it graduates into our own pool.</p>
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
      {side === 'sell' && needsApproval && (
        <p className="text-white/50 text-[11px] leading-snug">
          Approval grants the launcher an unlimited {tokenSymbol} allowance (one transaction,
          never repeated). Revoke any time from your wallet's token approvals.
        </p>
      )}
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
  /** The chain the curve lives on. Reads/writes are pinned here — they must
   *  never follow the wallet's chain (the launcher address is per-chain, and
   *  the same address can be a DIFFERENT contract on another chain). */
  chainId: number;
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

export function CurveTradePanel({ launcher, token, chainId, tokenSymbol = 'TOKEN' }: CurveTradePanelProps) {
  const { address: account } = useAccount();
  const { writeContract, isPending } = useWriteContract();

  const { data: launchRaw, isError: launchReadFailed, refetch: refetchLaunch } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'getLaunch',
    args: [token],
    chainId,
    query: { refetchInterval: 15_000 },
  });
  // AUDIT 2026-08-28: balance/allowance used to be read ONCE (no poll, no
  // post-write invalidation) — after an approve the button kept offering
  // "Approve" until a stale-window refocus, inviting a double approval, and
  // after a buy the sell tab's max stayed stale while getLaunch ticked every
  // 15s. Same cadence as getLaunch + explicit refetch on every confirmed
  // receipt.
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    chainId,
    query: { enabled: Boolean(account), refetchInterval: 15_000 },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'allowance',
    args: account ? [account, launcher] : undefined,
    chainId,
    query: { enabled: Boolean(account), refetchInterval: 15_000 },
  });

  // AUDIT 2026-08-28 (receipt-status standard, same as useFarmActions): track
  // the submitted hash to the RECEIPT. wagmi's fetch-success is not on-chain
  // success — a reverted tx also has a receipt — so status is checked
  // explicitly and a revert comes back as a red toast, never silence.
  const [tx, setTx] = useState<{ hash: `0x${string}`; label: string } | null>(null);
  const { data: receipt, isSuccess: receiptFetched } = useWaitForTransactionReceipt({
    hash: tx?.hash,
    chainId,
    query: { enabled: tx !== null },
  });
  useEffect(() => {
    if (!tx || !receiptFetched || !receipt) return;
    if (receipt.status === 'success') {
      toast.success(`${tx.label} confirmed.`);
    } else {
      toast.error(`${tx.label} failed on-chain (reverted) — nothing changed. Check slippage, or whether the curve just closed.`);
    }
    setTx(null);
    void refetchLaunch();
    void refetchBalance();
    void refetchAllowance();
  }, [tx, receiptFetched, receipt, refetchLaunch, refetchBalance, refetchAllowance]);

  const launch = useMemo(() => toCurveLaunch(launchRaw), [launchRaw]);
  // Hook order: resolve identity unconditionally (before the loading return).
  const identity = useCurveIdentity(token, chainId, launch?.creator);
  // Honest fallback: create() stored the REAL name/symbol in the token
  // contract, so a missing/failed Irys identity must never render "TOKEN" —
  // read them on-chain instead. Enabled only while identity isn't ok.
  const wantOnChainId = identity.status !== 'ok';
  const { data: onChainSymbol } = useReadContract({
    address: token, abi: ERC20_MIN_ABI, functionName: 'symbol', chainId,
    query: { enabled: wantOnChainId },
  });
  const { data: onChainName } = useReadContract({
    address: token, abi: ERC20_MIN_ABI, functionName: 'name', chainId,
    query: { enabled: wantOnChainId },
  });
  if (!launch) {
    // AUDIT 2026-08-28: getLaunch REVERTS (UnknownLaunch) for a non-curve
    // address — rendering that as eternal "Loading…" dressed a failed read as
    // progress, against the read-vs-zero honesty rule.
    if (launchReadFailed) {
      return (
        <div className="rounded-2xl p-5" style={cardStyle}>
          <p className="text-white/85 text-sm font-semibold">No curve launch at this address.</p>
          <p className="text-white/55 text-[12px] mt-1 leading-relaxed">
            Nothing launched from this chain&apos;s Tegridy curve lives at{' '}
            <span className="font-mono break-all">{token}</span>. Double-check the address and the
            chain.
          </p>
        </div>
      );
    }
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
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'buy', args: [token, minTokensOut], value: ethGross, chainId },
      {
        onSuccess: (hash) => {
          toast.success('Buy submitted — waiting for confirmation…');
          setTx({ hash, label: 'Buy' });
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the buy.'),
      },
    );
  };
  const onApprove = () => {
    writeContract(
      { address: token, abi: ERC20_MIN_ABI, functionName: 'approve', args: [launcher, maxUint256], chainId },
      {
        onSuccess: (hash) => {
          toast.success('Approval submitted — waiting for confirmation…');
          setTx({ hash, label: 'Approval' });
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the approval.'),
      },
    );
  };
  const onSell = (tokensIn: bigint, minEthOut: bigint) => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'sell', args: [token, tokensIn, minEthOut], chainId },
      {
        onSuccess: (hash) => {
          toast.success('Sell submitted — waiting for confirmation…');
          setTx({ hash, label: 'Sell' });
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the sell.'),
      },
    );
  };

  // A sell needs approval when the allowance can't cover the whole balance
  // (we approve maxUint256, so once approved this is false forever).
  const needsApproval = tokenBalance !== undefined && currentAllowance < tokenBalance;

  // Permissionless recovery for the deferred-graduation window — first UI
  // caller of finalizeGraduation (audit find: it had none anywhere).
  const onFinalizeGraduation = () => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'finalizeGraduation', args: [token], chainId },
      {
        onSuccess: (hash) => {
          toast.success('Finalize submitted — waiting for confirmation…');
          setTx({ hash, label: 'Finalize graduation' });
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the finalize call.'),
      },
    );
  };

  return (
    <CurveTradeView
      launch={launch}
      tokenSymbol={
        identity.status === 'ok'
          ? identity.identity.symbol
          : (typeof onChainSymbol === 'string' && onChainSymbol ? onChainSymbol : tokenSymbol)
      }
      fallbackName={typeof onChainName === 'string' && onChainName ? onChainName : undefined}
      identity={identity}
      tokenBalance={tokenBalance}
      needsApproval={needsApproval}
      pending={isPending || tx !== null}
      mining={tx !== null}
      deferredGraduation={!launch.graduated && launch.ethReserve >= launch.graduationEth}
      onFinalizeGraduation={onFinalizeGraduation}
      onBuy={onBuy}
      onSell={onSell}
      onApprove={onApprove}
    />
  );
}
