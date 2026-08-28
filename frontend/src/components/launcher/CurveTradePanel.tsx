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
  /** Creator-published identity (image/description/socials), when resolved.
   *  Absent/none renders an honest monogram tile — never a fabricated image. */
  identity?: CurveIdentityResolution;
  /** Wallet's balance of the launch token (for the sell tab). */
  tokenBalance?: bigint;
  /** True when a sell needs an ERC-20 approval before it can run. */
  needsApproval: boolean;
  pending: boolean;
  /** The connected wallet's claimable creator fees for THIS token. Defined only
   *  when the viewer IS the launch's creator — its presence is what renders the
   *  claim strip (a 0n renders the strip with an honest zero, so creators can
   *  see the surface exists before the first trade accrues anything). */
  creatorClaimable?: bigint;
  onClaimCreatorFees?: () => void;
  onBuy: (ethGross: bigint, minTokensOut: bigint) => void;
  onSell: (tokensIn: bigint, minEthOut: bigint) => void;
  onApprove: () => void;
}

/** The creator's earnings strip — the missing half of the 40% story: the claim
 *  button. Rendered only for the launch's creator (see creatorClaimable). Fees
 *  accrued pre-graduation stay claimable forever, so the graduated branch shows
 *  this too. */
function CreatorFeesStrip({
  claimable,
  pending,
  nativeSymbol,
  onClaim,
}: {
  claimable: bigint;
  pending: boolean;
  nativeSymbol: string;
  onClaim?: () => void;
}) {
  return (
    <div
      className="rounded-lg p-3 flex items-center justify-between gap-3"
      style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)' }}
    >
      <div className="min-w-0">
        <p className="text-emerald-200/90 text-[11px] font-semibold uppercase tracking-wide">Your creator fees</p>
        <p className="text-white/85 text-[13px] font-mono">
          {fmt(claimable)} {nativeSymbol}
          <span className="text-white/45 font-sans text-[11px]"> · 40% of every trade, claimable any time</span>
        </p>
      </div>
      <button
        type="button"
        disabled={pending || claimable === 0n || !onClaim}
        onClick={onClaim}
        className="btn-primary px-3 py-1.5 text-[12px] disabled:opacity-50 shrink-0"
        aria-label="Claim your accrued creator fees"
      >
        {pending ? 'Confirm…' : 'Claim'}
      </button>
    </div>
  );
}

/** Image-or-monogram identity header. The monogram is the explicit no-image
 *  state (resolving, none, invalid, error, or a broken image URL).
 *  Exported for the launch-explorer cards, which render the same identity the
 *  trade panel does — one component, one spoof-filter path, no drift. */
export function IdentityHeader({
  identity,
  tokenSymbol,
  socials = true,
}: {
  identity?: CurveIdentityResolution;
  tokenSymbol: string;
  /** Explorer cards are one big <button>, and an <a> inside a <button> is
   *  invalid HTML + a nested-interactive a11y violation — they pass false. */
  socials?: boolean;
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
          {ok ? ok.name : tokenSymbol}
          {ok && <span className="text-white/45 font-mono font-normal text-[12px]"> · {ok.symbol}</span>}
        </p>
        {ok?.description && (
          <p className="text-white/55 text-[11px] leading-snug line-clamp-2">{ok.description}</p>
        )}
        {socials && ok && (ok.website || ok.twitter || ok.telegram) && (
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
  nativeSymbol = 'ETH',
  identity,
  tokenBalance,
  needsApproval,
  pending,
  creatorClaimable,
  onClaimCreatorFees,
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
        <IdentityHeader identity={identity} tokenSymbol={tokenSymbol} />
        <p className="text-white/90 text-sm font-semibold">This launch has graduated 🎓</p>
        <p className="text-white/60 text-[12px] mt-1 leading-relaxed">
          The curve is closed. Its liquidity is live in the Tegridy pool with the LP burned to
          <span className="font-mono"> 0x…dEaD</span> — trade it on the swap, not here.
        </p>
        {creatorClaimable !== undefined && (
          <CreatorFeesStrip
            claimable={creatorClaimable}
            pending={pending}
            nativeSymbol={nativeSymbol}
            onClaim={onClaimCreatorFees}
          />
        )}
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
      <IdentityHeader identity={identity} tokenSymbol={tokenSymbol} />

      {creatorClaimable !== undefined && (
        <CreatorFeesStrip
          claimable={creatorClaimable}
          pending={pending}
          nativeSymbol={nativeSymbol}
          onClaim={onClaimCreatorFees}
        />
      )}

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

  const { data: launchRaw } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'getLaunch',
    args: [token],
    chainId,
    query: { refetchInterval: 15_000 },
  });
  const { data: balance } = useReadContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    chainId,
    query: { enabled: Boolean(account) },
  });
  const { data: allowance } = useReadContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'allowance',
    args: account ? [account, launcher] : undefined,
    chainId,
    query: { enabled: Boolean(account) },
  });
  // The creator's accrued 40% share for this token. Read whenever a wallet is
  // connected — whether it renders is decided below by the creator match, and
  // the refetch keeps the strip live as trades land.
  const { data: creatorFeeRaw, refetch: refetchCreatorFee } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'creatorFeeOf',
    args: [token],
    chainId,
    query: { enabled: Boolean(account), refetchInterval: 15_000 },
  });

  const launch = useMemo(() => toCurveLaunch(launchRaw), [launchRaw]);
  // Hook order: resolve identity unconditionally (before the loading return).
  const identity = useCurveIdentity(token, chainId, launch?.creator);
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
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'buy', args: [token, minTokensOut], value: ethGross, chainId },
      {
        onSuccess: () => toast.success('Buy submitted.'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the buy.'),
      },
    );
  };
  const onApprove = () => {
    writeContract(
      { address: token, abi: ERC20_MIN_ABI, functionName: 'approve', args: [launcher, maxUint256], chainId },
      {
        onSuccess: () => toast.success('Approval submitted — confirm, then sell.'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the approval.'),
      },
    );
  };
  const onSell = (tokensIn: bigint, minEthOut: bigint) => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'sell', args: [token, tokensIn, minEthOut], chainId },
      {
        onSuccess: () => toast.success('Sell submitted.'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the sell.'),
      },
    );
  };

  // A sell needs approval when the allowance can't cover the whole balance
  // (we approve maxUint256, so once approved this is false forever).
  const needsApproval = tokenBalance !== undefined && currentAllowance < tokenBalance;

  // The claim strip renders only for the launch's creator; the ADDRESS match is
  // the gate, the amount may honestly be zero. Case-insensitive compare — the
  // wallet and the chain don't agree on checksum casing.
  const isCreator =
    account !== undefined && account.toLowerCase() === launch.creator.toLowerCase();
  const creatorClaimable =
    isCreator && typeof creatorFeeRaw === 'bigint' ? creatorFeeRaw : undefined;
  const onClaimCreatorFees = () => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'claimCreatorFees', args: [token], chainId },
      {
        onSuccess: () => {
          toast.success('Creator fees claim submitted.');
          void refetchCreatorFee();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the claim.'),
      },
    );
  };

  return (
    <CurveTradeView
      launch={launch}
      tokenSymbol={identity.status === 'ok' ? identity.identity.symbol : tokenSymbol}
      identity={identity}
      tokenBalance={tokenBalance}
      needsApproval={needsApproval}
      pending={isPending}
      creatorClaimable={creatorClaimable}
      onClaimCreatorFees={creatorClaimable !== undefined ? onClaimCreatorFees : undefined}
      onBuy={onBuy}
      onSell={onSell}
      onApprove={onApprove}
    />
  );
}
