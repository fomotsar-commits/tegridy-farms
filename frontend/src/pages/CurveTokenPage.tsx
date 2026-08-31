// Permanent, shareable per-token page for OWN-curve launches — /eth-curve/:token.
// This is the URL a creator shares and a buyer lands on: identity + live trade
// panel + honest stats + (for the creator's own wallet) the claim-fees surface
// that completes launch → share → earn → claim entirely in-app.
//
// A token address does not name its chain — and the same address IS a different
// contract on another chain in this deploy history — so the page probes
// getLaunch on every DEPLOYED launcher and resolves via the pure
// pickResolvedCurveChain (?c= query param preferred). All probes failing is an
// honest not-found state, never a guess; the state still renders the page's h1
// (the a11y sweep loads this route with the zero address).

import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { toast } from 'sonner';
import { formatEther, isAddress, type Address } from 'viem';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { WrongChainBanner } from '../components/ui/WrongChainGuard';
import { getChainConfig } from '../lib/chains/registry';
import {
  CURVE_LAUNCHER_ABI,
  curveLauncherOn,
  curveMarketCapWei,
  curveSpotPriceWei,
  pickResolvedCurveChain,
} from '../lib/launcher/curve';
import { CurveTradePanel } from '../components/launcher/CurveTradePanel';
import { EvmCurveChart } from '../components/launcher/EvmCurveChart';
import { CopyButton } from '../components/ui/CopyButton';
import { getTokenUrl } from '../lib/explorer';

const PAGE_ID = 'eth-curve';
const cardStyle = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;

/** Every chain the curve can be deployed on, in probe order (mainnet first). */
const CURVE_CHAIN_IDS = [1, 8453, 4663] as const;

function fmtEth(wei: bigint, dp = 6): string {
  const s = formatEther(wei);
  const dot = s.indexOf('.');
  if (dot === -1) return s;
  const frac = s.slice(dot + 1, dot + 1 + dp);
  return frac ? `${s.slice(0, dot)}.${frac}` : s.slice(0, dot);
}

// ─────────────────────────── creator claim (pure view + container) ───────────────────────────

export interface CurveCreatorClaimViewProps {
  claimableWei: bigint;
  pending: boolean;
  /** Submission→receipt window (the 08-24 receipt-status standard). */
  mining?: boolean;
  onClaim: () => void;
}

/** Rendered ONLY for the launch's creator — the gating lives in the container,
 *  where it is enforced against the on-chain creator, not a prop a caller can
 *  forget. Never pausable on-chain; never hidden behind a dead control here. */
export function CurveCreatorClaimView({ claimableWei, pending, mining = false, onClaim }: CurveCreatorClaimViewProps) {
  return (
    <div className="rounded-2xl p-4" style={cardStyle}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-white/90 text-[13px] font-semibold">Your creator fees</p>
          <p className="text-white/55 text-[12px] font-mono">{fmtEth(claimableWei)} ETH claimable</p>
        </div>
        <button
          type="button"
          disabled={pending || claimableWei === 0n}
          onClick={onClaim}
          className="btn-primary px-4 py-2 text-[13px] disabled:opacity-50"
        >
          {pending ? (mining ? 'Confirming on-chain…' : 'Confirm in wallet…') : 'Claim'}
        </button>
      </div>
      <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
        40% of every trade's fee accrues here while the curve runs — on-chain, claimable only by
        the creator address, never pausable.
      </p>
    </div>
  );
}

function CurveCreatorClaim({ launcher, chainId, token, creator }: { launcher: Address; chainId: number; token: Address; creator: Address }) {
  const { address: account } = useAccount();
  const { writeContract, isPending } = useWriteContract();
  const { data: claimableRaw, refetch } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'creatorFeeOf',
    args: [token],
    chainId,
    query: { refetchInterval: 15_000 },
  });

  // AUDIT 2026-08-28 (receipt-status): `pending` used to span only the wallet
  // prompt, and the refetch fired PRE-MINE (returning the old claimable) — so
  // Claim re-enabled against a stale non-zero while the first claim mined, and
  // a second click submitted a guaranteed NothingToClaim revert. The button now
  // holds through the receipt, the refetch runs after it, and a revert comes
  // back as a red toast instead of silence.
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const { data: receipt, isSuccess: receiptFetched } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId,
    query: { enabled: txHash !== null },
  });
  useEffect(() => {
    if (!txHash || !receiptFetched || !receipt) return;
    if (receipt.status === 'success') toast.success('Creator fees claimed.');
    else toast.error('Claim failed on-chain (reverted) — nothing was paid out.');
    setTxHash(null);
    void refetch();
  }, [txHash, receiptFetched, receipt, refetch]);

  // The gate: only the on-chain creator ever sees this surface.
  if (!account || account.toLowerCase() !== creator.toLowerCase()) return null;
  const claimableWei = typeof claimableRaw === 'bigint' ? claimableRaw : 0n;

  const onClaim = () => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'claimCreatorFees', args: [token], chainId },
      {
        onSuccess: (hash) => {
          toast.success('Claim submitted — waiting for confirmation…');
          setTxHash(hash);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the claim.'),
      },
    );
  };

  return (
    <CurveCreatorClaimView
      claimableWei={claimableWei}
      pending={isPending || txHash !== null}
      mining={txHash !== null}
      onClaim={onClaim}
    />
  );
}

// ────────────────────────────────────── the page ──────────────────────────────────────

export default function CurveTokenPage() {
  usePageTitle('Memetics Curve', 'A token on the zero-toll Memetics bonding curve.');
  useEffect(() => {
    trackPageView('/eth-curve/:token');
  }, []);

  const { token: tokenParam } = useParams();
  const [searchParams] = useSearchParams();
  const token = tokenParam && isAddress(tokenParam) ? (tokenParam as Address) : null;
  const preferredRaw = Number(searchParams.get('c'));
  const preferred = Number.isInteger(preferredRaw) && preferredRaw > 0 ? preferredRaw : undefined;

  // Probe every DEPLOYED launcher for this token. allowFailure (the default)
  // turns UnknownLaunch reverts into per-item failures — exactly the signal
  // pickResolvedCurveChain consumes.
  const deployed = useMemo(
    () =>
      CURVE_CHAIN_IDS.flatMap((cid) => {
        const a = curveLauncherOn(cid);
        return a.status === 'deployed' ? [{ chainId: cid, launcher: a.address }] : [];
      }),
    [],
  );
  const { data: probesRaw, isLoading: probing } = useReadContracts({
    contracts: token
      ? deployed.map((d) => ({
          address: d.launcher,
          abi: CURVE_LAUNCHER_ABI,
          functionName: 'getLaunch' as const,
          args: [token] as const,
          chainId: d.chainId,
        }))
      : [],
    query: { enabled: Boolean(token) },
  });

  const resolvedChainId = useMemo(() => {
    if (!token || !probesRaw) return null;
    const probes = deployed.map((d, i) => ({ chainId: d.chainId, ok: probesRaw[i]?.status === 'success' }));
    return pickResolvedCurveChain(probes, preferred);
  }, [token, probesRaw, deployed, preferred]);

  const resolved = useMemo(() => {
    if (resolvedChainId === null) return null;
    const idx = deployed.findIndex((d) => d.chainId === resolvedChainId);
    if (idx === -1) return null;
    const raw = probesRaw?.[idx];
    if (raw?.status !== 'success' || !raw.result || typeof raw.result !== 'object') return null;
    const launch = raw.result as { creator: Address; virtualEth: bigint; ethReserve: bigint; tokenReserve: bigint; graduationEth: bigint; graduated: boolean };
    return { chainId: resolvedChainId, launcher: deployed[idx]!.launcher, creator: launch.creator, launch };
  }, [resolvedChainId, deployed, probesRaw]);

  const chainName = resolved ? (getChainConfig(resolved.chainId)?.name ?? `chain ${resolved.chainId}`) : null;

  const share = () => {
    const url = `${window.location.origin}/eth-curve/${token}?c=${resolved?.chainId ?? ''}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.success('Link copied — share it anywhere.'),
      () => toast.error('Copy failed — grab it from the address bar.'),
    );
  };

  return (
    <>
      <PageArtBackdrop pageId={PAGE_ID} />
      <div className="relative z-10 max-w-xl mx-auto px-4 py-8 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="heading-luxury text-2xl">Memetics Curve</h1>
          {resolved && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold leading-none px-2 py-1 uppercase tracking-wide">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                {chainName}
              </span>
              <button type="button" onClick={share} className="btn-primary px-3 py-1.5 text-[12px]">
                Share
              </button>
            </div>
          )}
        </div>

        {!token ? (
          <div className="rounded-2xl p-5" style={cardStyle}>
            <p className="text-white/85 text-sm font-semibold">That's not a token address.</p>
            <p className="text-white/55 text-[12px] mt-1 leading-relaxed">
              The path needs a 0x… address of a curve launch.{' '}
              <Link className="text-sky-300/80 hover:text-sky-200" to="/eth-curve">
                Back to the curve
              </Link>
              .
            </p>
          </div>
        ) : probing || (probesRaw === undefined && deployed.length > 0) ? (
          <div className="rounded-2xl p-5 text-white/55 text-[13px]" style={cardStyle}>
            Looking for this token on {deployed.length} chain{deployed.length === 1 ? '' : 's'}…
          </div>
        ) : !resolved ? (
          <div className="rounded-2xl p-5" style={cardStyle}>
            <p className="text-white/85 text-sm font-semibold">No curve launch at this address.</p>
            <p className="text-white/55 text-[12px] mt-1 leading-relaxed">
              Checked every chain the Tegridy curve is deployed on — nothing launched from our
              launcher lives at{' '}
              <span className="font-mono break-all">{token}</span>. If it was just created, give
              the RPC a few seconds and reload.{' '}
              <Link className="text-sky-300/80 hover:text-sky-200" to="/eth-curve">
                Back to the curve
              </Link>
              .
            </p>
          </div>
        ) : (
          <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-4">
            <WrongChainBanner requiredChainId={resolved.chainId} />
            {!resolved.launch.graduated && (
              <>
                <div className="rounded-2xl p-4 grid grid-cols-2 gap-3" style={cardStyle}>
                  <div>
                    <p className="text-white/45 text-[11px]">Market cap</p>
                    <p className="text-white/90 text-[13px] font-mono">{fmtEth(curveMarketCapWei(resolved.launch), 4)} ETH</p>
                  </div>
                  <div>
                    <p className="text-white/45 text-[11px]">Spot price</p>
                    <p className="text-white/90 text-[13px] font-mono">{fmtEth(curveSpotPriceWei(resolved.launch), 9)} ETH</p>
                  </div>
                </div>
                <EvmCurveChart
                  virtualEth={resolved.launch.virtualEth}
                  ethReserve={resolved.launch.ethReserve}
                  tokenReserve={resolved.launch.tokenReserve}
                  graduationEth={resolved.launch.graduationEth}
                />
              </>
            )}
            <CurveTradePanel launcher={resolved.launcher} token={token} chainId={resolved.chainId} />
            {resolved.launch.graduated && (
              <div className="rounded-2xl p-4" style={cardStyle}>
                <p className="text-white/85 text-sm font-semibold mb-1">Graduated — it lives on the venue now</p>
                <p className="text-white/55 text-[12px] leading-relaxed mb-3">
                  The curve closed and its liquidity is live in our own pool with the LP burned.
                  This is the aftermarket the island runs on:
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link to="/swap" className="btn-primary px-4 py-2 text-[12px]">Trade it on the venue swap</Link>
                  <Link to="/farm" className="btn-secondary px-4 py-2 text-[12px]">The farm (real ETH yield)</Link>
                </div>
              </div>
            )}
            <CurveCreatorClaim launcher={resolved.launcher} chainId={resolved.chainId} token={token} creator={resolved.creator} />

            {/* Trust strip — the venue's whole pitch, placed where buyers decide.
                Scan is chain-gated (RH 4663 has no holder source yet) and the
                deployer graph reads mainnet only. */}
            <div className="rounded-2xl p-4 space-y-3" style={cardStyle}>
              <p className="text-white/45 text-[11px]">Verify it yourself — every token here is checkable</p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white/45 text-[10px] uppercase tracking-wider">CA</span>
                <CopyButton text={token} display={`${token.slice(0, 10)}…${token.slice(-8)}`} className="font-mono text-[12px]" style={{ color: 'var(--color-kyle)' }} />
                <a
                  href={getTokenUrl(resolved.chainId, token)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View token on block explorer (opens in new tab)"
                  className="text-[11px] underline underline-offset-2 text-white/60 hover:text-white"
                >
                  explorer ↗
                </a>
              </div>
              <div className="flex flex-wrap gap-2">
                {(resolved.chainId === 1 || resolved.chainId === 8453) && (
                  <Link
                    to={`/scan?token=${token}${resolved.chainId === 8453 ? '&chain=base' : ''}`}
                    className="btn-secondary px-4 py-2 text-[12px]"
                  >
                    Scan holders
                  </Link>
                )}
                {resolved.chainId === 1 && (
                  <Link to={`/deployer?address=${resolved.creator}`} className="btn-secondary px-4 py-2 text-[12px]">
                    Creator&apos;s deploy history
                  </Link>
                )}
                <Link to="/trust" className="btn-secondary px-4 py-2 text-[12px]">
                  Trust suite
                </Link>
              </div>
            </div>
          </m.div>
        )}
      </div>
    </>
  );
}
