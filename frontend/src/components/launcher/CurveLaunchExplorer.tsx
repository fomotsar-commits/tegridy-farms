// The curve's discovery surface — the "live launches" grid the 5D review found
// missing: launchCount/allLaunchesPaginated shipped in the ABI with ZERO UI
// consumers, so trading meant pasting an address. This renders the newest
// launches as identity cards (same IdentityHeader + spoof-filter path as the
// trade panel — one identity component, no drift) with the graduation progress
// bar and a client-computed FD mcap (spot × total supply, no price API), and a
// card click hands the token to the SAME trade prefill the create flow uses.
//
// Honesty rules carried from the rest of the launcher surface:
//   * an empty chain says "no launches yet", never a skeleton pretending load;
//   * mcap is labelled FD and computed from getLaunch alone (mcapWei) — when a
//     curve has graduated the spot no longer lives here, so the card shows the
//     graduated badge instead of a stale number;
//   * reads are pinned to the curve's chainId, never the wallet's (the same
//     launcher address can be a DIFFERENT contract on another chain).

import { useMemo, useState } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { formatEther, type Address } from 'viem';
import {
  CURVE_LAUNCHER_ABI,
  graduationProgressBps,
  latestLaunchWindow,
  mcapWei,
  type CurveLaunch,
} from '../../lib/launcher/curve';
import { useCurveIdentity } from '../../hooks/useCurveIdentity';
import { IdentityHeader } from './CurveTradePanel';

const cardStyle = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;

/** Newest page size. allLaunchesPaginated view-reverts on absurd counts, so the
 *  explorer never asks for more than this per read. */
const PAGE_SIZE = 12;

function fmtEth(wei: bigint, dp = 3): string {
  const s = formatEther(wei);
  const dot = s.indexOf('.');
  if (dot === -1) return s;
  const frac = s.slice(dot + 1, dot + 1 + dp);
  return frac ? `${s.slice(0, dot)}.${frac}` : s.slice(0, dot);
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Parse the getLaunch tuple (named components → object). Mirrors the trade
 *  panel's parser; returns null on anything malformed so a bad RPC row renders
 *  as nothing instead of NaN stats. */
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

function LaunchCard({
  token,
  launch,
  chainId,
  onTrade,
}: {
  token: Address;
  launch: CurveLaunch;
  chainId: number;
  onTrade: (token: Address) => void;
}) {
  const identity = useCurveIdentity(token, chainId, launch.creator);
  const progress = graduationProgressBps(launch.ethReserve, launch.graduationEth);
  const mcap = launch.graduated ? null : mcapWei(launch);
  const name = identity.status === 'ok' ? identity.identity.name : shortAddr(token);
  return (
    <button
      type="button"
      onClick={() => onTrade(token)}
      aria-label={`Trade ${name} on the curve`}
      className="text-left rounded-2xl p-4 space-y-3 w-full transition hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300/60"
      style={cardStyle}
    >
      <IdentityHeader identity={identity} tokenSymbol={shortAddr(token)} socials={false} />
      <div>
        <div className="flex justify-between text-[10px] text-white/55 mb-1">
          <span>{launch.graduated ? 'Graduated 🎓' : 'Graduation progress'}</span>
          <span className="font-mono">
            {fmtEth(launch.ethReserve)} / {fmtEth(launch.graduationEth)} ETH
          </span>
        </div>
        <div
          className="h-1.5 rounded-full bg-white/10 overflow-hidden"
          role="progressbar"
          aria-valuenow={launch.graduated ? 10000 : progress}
          aria-valuemin={0}
          aria-valuemax={10000}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${(launch.graduated ? 10000 : progress) / 100}%`,
              background: launch.graduated ? 'rgba(52,211,153,0.9)' : 'var(--color-stan, #7dd3fc)',
            }}
          />
        </div>
      </div>
      <div className="flex justify-between text-[11px]">
        <span className="text-white/45">
          by <span className="font-mono">{shortAddr(launch.creator)}</span>
        </span>
        {mcap !== null && (
          <span className="text-white/70 font-mono">FD mcap {fmtEth(mcap, 2)} ETH</span>
        )}
      </div>
    </button>
  );
}

export function CurveLaunchExplorer({
  launcher,
  chainId,
  onTrade,
}: {
  launcher: Address;
  chainId: number;
  onTrade: (token: Address) => void;
}) {
  // How many pages the viewer has asked for (Show more grows the window).
  const [pages, setPages] = useState(1);

  const { data: countRaw } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'launchCount',
    chainId,
    query: { refetchInterval: 30_000 },
  });
  const launchCount = typeof countRaw === 'bigint' ? countRaw : null;

  const window_ = useMemo(
    () => (launchCount === null ? null : latestLaunchWindow(launchCount, PAGE_SIZE * pages)),
    [launchCount, pages],
  );

  const { data: pageRaw } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'allLaunchesPaginated',
    args: window_ ? [window_.start, window_.count] : undefined,
    chainId,
    query: { enabled: window_ !== null && window_.count > 0n, refetchInterval: 30_000 },
  });

  // Newest first: the array is append-only on-chain, so reverse the tail page.
  const tokens = useMemo<Address[]>(() => {
    if (!Array.isArray(pageRaw)) return [];
    return [...(pageRaw as Address[])].reverse();
  }, [pageRaw]);

  const { data: launchesRaw } = useReadContracts({
    contracts: tokens.map((t) => ({
      address: launcher,
      abi: CURVE_LAUNCHER_ABI,
      functionName: 'getLaunch' as const,
      args: [t] as const,
      chainId,
    })),
    query: { enabled: tokens.length > 0, refetchInterval: 30_000 },
  });

  const cards = useMemo(() => {
    if (!launchesRaw) return [];
    return tokens.flatMap((token, i) => {
      const row = launchesRaw[i];
      const launch = row && row.status === 'success' ? toCurveLaunch(row.result) : null;
      return launch ? [{ token, launch }] : [];
    });
  }, [tokens, launchesRaw]);

  // Nothing to say until the count read answers — this section renders nothing
  // rather than a spinner (the page above it is already interactive).
  if (launchCount === null) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-white font-semibold text-sm">Live on the curve</h2>
        <span className="text-white/45 text-[11px] font-mono">
          {launchCount.toString()} launch{launchCount === 1n ? '' : 'es'}
        </span>
      </div>

      {launchCount === 0n ? (
        <div className="rounded-2xl p-5" style={cardStyle}>
          <p className="text-white/70 text-[13px]">No launches on this chain yet.</p>
          <p className="text-white/50 text-[12px] mt-1">
            The curve is live and waiting — the create panel above makes yours the first, in one signature.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {cards.map(({ token, launch }) => (
              <LaunchCard key={token} token={token} launch={launch} chainId={chainId} onTrade={onTrade} />
            ))}
          </div>
          {window_ !== null && window_.start > 0n && (
            <button
              type="button"
              className="w-full py-2 rounded-lg text-[12px] text-white/60 hover:text-white/90 transition"
              style={cardStyle}
              onClick={() => setPages((p) => p + 1)}
            >
              Show older launches
            </button>
          )}
        </>
      )}
    </div>
  );
}
