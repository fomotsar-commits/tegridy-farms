import { useAccount, useChainId, useReadContracts } from 'wagmi';
import { Link } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';
import { bungalowExplorerUrl, bungalowScanRoute, bungalowTradeRoute } from '../../lib/bungalows';
import { isSolanaSwapLive } from '../../lib/solana';
import { ERC20_ABI } from '../../lib/contracts';
import { fmtRaw } from '../../lib/evmLighthouse';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';
import { BungalowMarket } from './BungalowMarket';
import { BungalowHolders } from './BungalowHolders';
import { LIGHTHOUSE_LADDER_ABI } from '../../lib/contracts';

/**
 * The EVM sibling of BungalowDashboardPanel — the seam that panel's header
 * documents, built the day its first consumers arrived (the 2026-08-30
 * placeholder-skin flip made every settled EVM resident live). Composes the
 * chain-generic cards that already exist — market strip, holders, and the
 * lighthouse card when a pool ships — plus one wagmi balance read. Same
 * honesty rules as everything else here: an unreadable balance is a dash,
 * never a zero, and nothing on this page invents a number.
 */

const CHAIN_IDS: Record<string, number> = { ethereum: 1, base: 8453 };
const CHAIN_LABEL: Record<string, string> = { ethereum: 'Ethereum', base: 'Base' };
const PLACEHOLDER_ADDR = '0x0000000000000000000000000000000000000001' as const;

export function EvmBungalowDashboardPanel({ bungalow }: { bungalow: Bungalow }) {
  const token = (bungalow.address ?? '') as `0x${string}`;
  const poolChainId = CHAIN_IDS[bungalow.chain] ?? 1;
  const accent = bungalow.accent ?? 'var(--color-kyle)';
  const { address: user, isConnected } = useAccount();
  const walletChainId = useChainId();

  const { data: reads } = useReadContracts({
    contracts: [
      { address: token, abi: ERC20_ABI, chainId: poolChainId, functionName: 'balanceOf', args: [user ?? PLACEHOLDER_ADDR] },
      { address: token, abi: ERC20_ABI, chainId: poolChainId, functionName: 'decimals' },
      // The lighthouse position, read (never written) from this page.
      { address: (bungalow.stakePool ?? token) as `0x${string}`, abi: LIGHTHOUSE_LADDER_ABI, chainId: poolChainId, functionName: 'balanceOf', args: [user ?? PLACEHOLDER_ADDR] },
      { address: (bungalow.stakePool ?? token) as `0x${string}`, abi: LIGHTHOUSE_LADDER_ABI, chainId: poolChainId, functionName: 'earned', args: [user ?? PLACEHOLDER_ADDR] },
    ],
    query: { enabled: Boolean(bungalow.address), refetchInterval: 60_000 },
  });
  const balRaw = user && reads?.[0]?.status === 'success' ? (reads[0].result as bigint) : null;
  const stakedRaw = user && reads?.[2]?.status === 'success' ? (reads[2].result as bigint) : null;
  const earnedRaw = user && reads?.[3]?.status === 'success' ? (reads[3].result as bigint) : null;
  const decimals = reads?.[1]?.status === 'success' ? Number(reads[1].result) : bungalow.decimals ?? 18;

  const explorer = bungalowExplorerUrl(bungalow);
  const trade = bungalowTradeRoute(bungalow, isSolanaSwapLive());
  const scanRoute = bungalowScanRoute(bungalow);

  return (
    <div className="space-y-4">
      {/* Header card: who this is + wallet position + the standing CTAs. */}
      <section
        className="rounded-2xl p-6"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
        aria-label={`${bungalow.symbol} dashboard`}
      >
        <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: accent }}>
          {bungalow.name} · {CHAIN_LABEL[bungalow.chain] ?? bungalow.chain}
        </p>
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <h2 className="heading-luxury text-xl text-white">{bungalow.symbol} Dashboard.</h2>
          {bungalow.address && (
            <CopyButton text={bungalow.address} display={shortenAddress(bungalow.address, 6)} className="font-mono text-[11px]" style={{ color: 'var(--color-kyle)' }} />
          )}
          {explorer && (
            <a href={explorer} target="_blank" rel="noopener noreferrer" aria-label="View token on block explorer (opens in new tab)" className="text-[11px] underline underline-offset-2 text-white/60 hover:text-white">
              explorer ↗
            </a>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 mb-4 max-w-md">
          <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">Your balance</p>
            <p className="text-white text-[15px] tabular-nums">
              {isConnected
                ? walletChainId === poolChainId || balRaw !== null
                  ? `${fmtRaw(balRaw, decimals)} ${bungalow.symbol}`
                  : '—'
                : 'connect a wallet'}
            </p>
          </div>
          <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">Chain</p>
            <p className="text-white text-[15px]">{CHAIN_LABEL[bungalow.chain] ?? bungalow.chain}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {trade && ('to' in trade ? (
            <Link to={trade.to} className="btn-primary px-5 py-2 text-[13px]">Trade {bungalow.symbol}</Link>
          ) : (
            <a href={trade.href} target="_blank" rel="noopener noreferrer"
              aria-label={`${trade.kind === 'chart' ? 'Chart for' : 'Trade'} ${bungalow.symbol} (opens in new tab)`}
              className="btn-primary px-5 py-2 text-[13px]">
              {trade.kind === 'chart' ? `${bungalow.symbol} chart ↗` : `Trade ${bungalow.symbol} ↗`}
            </a>
          ))}
          {scanRoute && (
            <Link to={scanRoute} className="btn-secondary px-5 py-2 text-[13px]">Scan {bungalow.symbol}</Link>
          )}
          {bungalow.community && (
            <a href={bungalow.community.url} target="_blank" rel="noopener noreferrer"
              aria-label={`${bungalow.name}'s community home (opens in new tab)`}
              className="btn-secondary px-5 py-2 text-[13px]">
              {bungalow.community.label} ↗
            </a>
          )}
        </div>
      </section>

      {/* Live market — self-hides when the registry has no indexed pool. */}
      <BungalowMarket bungalow={bungalow} />

      {/* THE LIGHTHOUSE: READ-ONLY HERE, MANAGED AT /farm.
          2026-08-31 BUG, caught by the TOWELI-parity study: this mounted the
          PLAIN Synthetix card against pools that are now LighthouseLadder.
          Every read the plain card issues also exists on the ladder, so the
          numbers looked right — but its buttons encode selectors the ladder
          does not have (stake takes two arguments there; withdraw(uint256)
          and exit() do not exist at all), so a staker would have paid gas for
          a real Approve and then watched every follow-up revert. Its copy
          also promised "no locks, withdraw free at any time" about a pool
          with 0-4 year locks and a 25% early-exit penalty.
          The fix is the shape both other dashboards already use: state the
          position, and send people to the one surface that owns the writes.
          A second write-capable copy of the staking UI is a divergence
          waiting to happen; there is now exactly one. */}
      {bungalow.stakePool && (
        <section
          className="rounded-2xl p-6"
          style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
          aria-label={`${bungalow.symbol} lighthouse position`}
        >
          <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: accent }}>
            The lighthouse
          </p>
          <div className="grid grid-cols-2 gap-3 mb-4 max-w-md">
            <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">Your principal</p>
              <p className="text-white text-[15px] tabular-nums">
                {isConnected ? `${fmtRaw(stakedRaw, decimals)} ${bungalow.symbol}` : 'connect a wallet'}
              </p>
            </div>
            <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">Claimable</p>
              <p className="text-white text-[15px] tabular-nums">
                {isConnected ? `${fmtRaw(earnedRaw, decimals)} ${bungalow.symbol}` : '—'}
              </p>
            </div>
          </div>
          <p className="text-[12px] text-white/70 mb-3">
            Locks run 7 days to 4 years, earning a 0.40x to 4.00x share — the same ladder the TOWELI farm
            uses. Staking, claiming and every exit live on the{' '}
            <Link to="/farm" className="underline underline-offset-2 text-white hover:text-white/80">pool page</Link>.
          </p>
          <Link to="/farm" className="btn-secondary px-5 py-2 text-[13px] inline-block">Manage at the lighthouse →</Link>
        </section>
      )}

      {/* Distribution — read-on-demand, the scanner's own honest caveats. */}
      <BungalowHolders bungalow={bungalow} />
    </div>
  );
}
