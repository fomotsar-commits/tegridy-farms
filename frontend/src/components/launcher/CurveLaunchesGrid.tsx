// Live-launches grid for the OWN curve — the discovery surface. Reads come
// straight off the deployed launcher (launchCount + allLaunchesPaginated +
// getLaunch per token, all pinned to the curve's chain); identity (image/name)
// resolves per card via the creator-signed Irys binding. Every number shown is
// the same bigint math the contract runs (curve.ts); the empty state is honest
// copy, not a spinner that never resolves.
//
// The presentational pieces (CurveLaunchesGridView / CurveGridCardView) are
// pure and prop-driven so they test without a wallet; containers wire the reads.

import React, { useMemo } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useReadContract, useReadContracts } from 'wagmi';
import { formatEther, type Address } from 'viem';
import {
  CURVE_LAUNCHER_ABI,
  curveMarketCapWei,
  graduationProgressBps,
  type CurveLaunch,
} from '../../lib/launcher/curve';
import { useCurveIdentity } from '../../hooks/useCurveIdentity';

const cardStyle = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;

/** How many launches the grid shows (newest first). */
export const CURVE_GRID_PAGE = 12;

/**
 * The slice of allLaunches to fetch for a newest-first grid of `pageSize` over
 * `launchCount` entries. The on-chain array is append-only (oldest first), so
 * newest-first means "the LAST pageSize entries, reversed after fetch". Pure —
 * the off-by-one here would silently drop the newest or oldest launch, so it is
 * pinned by tests instead of trusted.
 */
export function newestFirstSlice(launchCount: bigint, pageSize: number): { start: bigint; count: bigint } {
  const size = BigInt(pageSize);
  if (launchCount <= size) return { start: 0n, count: launchCount };
  return { start: launchCount - size, count: size };
}

function fmtEth(wei: bigint, dp = 4): string {
  const s = formatEther(wei);
  const dot = s.indexOf('.');
  if (dot === -1) return s;
  const frac = s.slice(dot + 1, dot + 1 + dp);
  return frac ? `${s.slice(0, dot)}.${frac}` : s.slice(0, dot);
}

// ─────────────────────────────── presentational core ───────────────────────────────

export interface CurveGridCardData {
  token: Address;
  /** Identity name/symbol when resolved; the card falls back to the address. */
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  /** True while identity is still resolving (renders the pulse tile). */
  identityResolving: boolean;
  marketCapWei: bigint;
  progressBps: number;
  graduated: boolean;
}

export function CurveGridCardView({ card, chainId }: { card: CurveGridCardData; chainId: number }) {
  const short = `${card.token.slice(0, 6)}…${card.token.slice(-4)}`;
  const monogram = (card.symbol ?? card.token.slice(2, 5)).slice(0, 3).toUpperCase();
  return (
    <Link
      to={`/eth-curve/${card.token}?c=${chainId}`}
      className="rounded-2xl p-3 flex gap-3 items-center hover:bg-white/5 transition-colors"
      style={cardStyle}
      aria-label={`Open ${card.name ?? short} on the curve`}
    >
      {card.imageUrl ? (
        <img
          src={card.imageUrl}
          alt=""
          className="w-11 h-11 rounded-xl object-cover shrink-0"
          style={{ border: '1px solid rgba(255,255,255,0.14)' }}
        />
      ) : (
        <div
          aria-hidden="true"
          className={`w-11 h-11 rounded-xl shrink-0 flex items-center justify-center bg-black/50 text-white/45 text-[11px] font-mono font-semibold ${
            card.identityResolving ? 'animate-pulse' : ''
          }`}
          style={{ border: '1px solid rgba(255,255,255,0.14)' }}
        >
          {monogram}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-white/90 text-[13px] font-semibold truncate">
          {card.name ?? short}
          {card.symbol && <span className="text-white/45 font-mono font-normal text-[11px]"> · {card.symbol}</span>}
        </p>
        <p className="text-white/50 text-[11px] font-mono">
          {card.marketCapWei > 0n ? `${fmtEth(card.marketCapWei)} ETH cap` : 'pool-priced'}
        </p>
        {card.graduated ? (
          <span className="inline-block mt-1 text-[10px] font-semibold text-emerald-300/90">GRADUATED 🎓</span>
        ) : (
          <div
            className="h-1 rounded-full bg-white/10 overflow-hidden mt-1.5"
            role="progressbar"
            aria-label="Graduation progress"
            aria-valuenow={card.progressBps}
            aria-valuemin={0}
            aria-valuemax={10000}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${card.progressBps / 100}%`, background: 'var(--color-stan, #7dd3fc)' }}
            />
          </div>
        )}
      </div>
    </Link>
  );
}

export interface CurveLaunchesGridViewProps {
  chainName: string;
  /** null while the count read is in flight. */
  launchCount: bigint | null;
  /** Newest-first token list (already reversed by the container). */
  tokens: Address[];
  /** Renders one card slot — the container injects the hook-carrying card here,
   *  so the view stays pure and testable with a stub. */
  renderCard: (token: Address) => React.ReactNode;
}

export function CurveLaunchesGridView({ chainName, launchCount, tokens, renderCard }: CurveLaunchesGridViewProps) {
  return (
    <m.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      aria-label="Live curve launches"
      className="space-y-3"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-white font-semibold text-sm">Live launches</h2>
        {launchCount !== null && (
          <span className="text-white/45 text-[11px] font-mono">
            {launchCount.toString()} on {chainName}
          </span>
        )}
      </div>
      {launchCount === null ? (
        <div className="rounded-2xl p-5 text-white/55 text-[13px]" style={cardStyle}>
          Reading the curve…
        </div>
      ) : launchCount === 0n ? (
        <div className="rounded-2xl p-5" style={cardStyle}>
          <p className="text-white/85 text-[13px] font-semibold">No launches on {chainName} yet.</p>
          <p className="text-white/55 text-[12px] mt-1 leading-relaxed">
            The curve is live and the first launch writes history — create one above and your coin
            opens this grid.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {tokens.map((t) => (
            <React.Fragment key={t}>{renderCard(t)}</React.Fragment>
          ))}
        </div>
      )}
    </m.section>
  );
}

// ────────────────────────────────── wired containers ────────────────────────────────

/** Parse the getLaunch tuple into CurveLaunch (same shape CurveTradePanel uses). */
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

function CurveGridCard({ launcher, chainId, token }: { launcher: Address; chainId: number; token: Address }) {
  const { data: launchRaw } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'getLaunch',
    args: [token],
    chainId,
    query: { refetchInterval: 30_000 },
  });
  const launch = useMemo(() => toCurveLaunch(launchRaw), [launchRaw]);
  const identity = useCurveIdentity(token, chainId, launch?.creator);

  if (!launch) {
    return (
      <div className="rounded-2xl p-3 text-white/45 text-[12px]" style={cardStyle}>
        Reading {token.slice(0, 8)}…
      </div>
    );
  }
  const ok = identity.status === 'ok' ? identity.identity : null;
  const card: CurveGridCardData = {
    token,
    name: ok?.name ?? null,
    symbol: ok?.symbol ?? null,
    imageUrl: ok?.imageUrl ?? null,
    identityResolving: identity.status === 'resolving',
    marketCapWei: curveMarketCapWei(launch),
    progressBps: graduationProgressBps(launch.ethReserve, launch.graduationEth),
    graduated: launch.graduated,
  };
  return <CurveGridCardView card={card} chainId={chainId} />;
}

export interface CurveLaunchesGridProps {
  launcher: Address;
  chainId: number;
  chainName: string;
}

export function CurveLaunchesGrid({ launcher, chainId, chainName }: CurveLaunchesGridProps) {
  const { data: countRaw } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'launchCount',
    args: [],
    chainId,
    query: { refetchInterval: 30_000 },
  });
  const launchCount = typeof countRaw === 'bigint' ? countRaw : null;
  const slice = launchCount === null ? null : newestFirstSlice(launchCount, CURVE_GRID_PAGE);

  const { data: pageRaw } = useReadContracts({
    contracts:
      slice && slice.count > 0n
        ? [
            {
              address: launcher,
              abi: CURVE_LAUNCHER_ABI,
              functionName: 'allLaunchesPaginated',
              args: [slice.start, slice.count],
              chainId,
            },
          ]
        : [],
    query: { enabled: Boolean(slice && slice.count > 0n), refetchInterval: 30_000 },
  });

  const tokens = useMemo<Address[]>(() => {
    const page = pageRaw?.[0]?.status === 'success' ? (pageRaw[0].result as Address[]) : [];
    // On-chain order is oldest-first; the grid is newest-first.
    return [...page].reverse();
  }, [pageRaw]);

  // Identity/launch reads live in per-card components so each card carries its
  // own hooks; the grid only fans out the token list.
  return (
    <CurveLaunchesGridView
      chainName={chainName}
      launchCount={launchCount}
      tokens={tokens}
      renderCard={(t) => <CurveGridCard launcher={launcher} chainId={chainId} token={t} />}
    />
  );
}
