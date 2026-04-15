/* ─── Shared small components for Launchpad ─── */
import { useAccount, useChains } from 'wagmi';
import { formatEther } from 'viem';
import { ART } from '../../lib/artConfig';
import { PHASE_LABELS, LABEL } from './launchpadConstants';

/** Return the block explorer address URL for the current chain */
export function useExplorerAddressUrl(address: string) {
  const chains = useChains();
  const { chain } = useAccount();
  const activeChain = chain ?? chains[0]!;
  const base = activeChain?.blockExplorers?.default?.url ?? 'https://etherscan.io';
  return `${base}/address/${address}`;
}

/* ─── Art-backed glass card helper ─── */
export function ArtCard({
  art,
  opacity = 1,
  overlay = 'none',
  className = '',
  children,
}: {
  art: { src: string };
  opacity?: number;
  overlay?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl glass-card-animated ${className}`}
      style={{ border: '1px solid rgba(139,92,246,0.75)' }}
    >
      <div className="absolute inset-0">
        <img src={art.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ opacity }} />
        <div className="absolute inset-0" style={{ background: overlay }} />
      </div>
      <div className="relative z-10 p-5">{children}</div>
    </div>
  );
}

/* ─── Phase badge for cards ─── */
export function PhaseBadge({ phase }: { phase: number }) {
  const config =
    phase === 2
      ? { color: 'bg-emerald-500', ring: 'ring-emerald-400/30', text: 'text-emerald-300', label: 'Public', pulse: true }
      : phase === 1
        ? { color: 'bg-yellow-500', ring: 'ring-yellow-400/30', text: 'text-yellow-300', label: 'Allowlist', pulse: false }
        : { color: 'bg-gray-500', ring: 'ring-gray-400/20', text: 'text-gray-400', label: 'Paused', pulse: false };

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/40 backdrop-blur-sm ring-1 ${config.ring}`}>
      <span className="relative flex h-2 w-2">
        {config.pulse && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.color} opacity-60`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${config.color}`} />
      </span>
      <span className={`text-[10px] font-medium uppercase tracking-wider label-pill ${config.text}`}>
        {config.label}
      </span>
    </div>
  );
}

/* ─── Phase Indicator ─── */
export function PhaseIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {PHASE_LABELS.map((label, i) => (
        <div key={label} className="flex items-center">
          {i > 0 && (
            <div
              className={`w-8 sm:w-12 h-[2px] transition-colors duration-500 ${
                i <= current ? 'bg-emerald-500' : 'bg-black/60'
              }`}
            />
          )}
          <div className="flex flex-col items-center gap-1.5">
            <div
              className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${
                i === current
                  ? 'border-emerald-400 bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.4)]'
                  : i < current
                    ? 'border-emerald-500/60 bg-emerald-500/30'
                    : 'border-white/15 bg-transparent'
              }`}
            >
              {i <= current && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
            </div>
            <span
              className={`text-[10px] uppercase tracking-wider label-pill ${
                i === current ? 'text-black' : 'text-white'
              }`}
            >
              {label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Creator Revenue Dashboard ─── */
export function CreatorRevenueDashboard({ drop }: { drop: { mintPrice: bigint; totalMinted: number } }) {
  const totalRevenue = Number(formatEther(drop.mintPrice * BigInt(drop.totalMinted)));

  return (
    <ArtCard art={ART.roseApe} opacity={1} overlay="none" className="mb-6">
      <h3 className="text-black font-semibold tracking-wide uppercase text-[11px] mb-4">
        Creator Revenue Dashboard
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Total Minted</p>
          <p className="text-white font-mono text-xl tabular-nums">{drop.totalMinted}</p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Total Revenue</p>
          <p className="text-white font-mono text-xl tabular-nums">{totalRevenue.toFixed(4)} <span className="text-white text-sm">ETH</span></p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Unique Holders</p>
          <p className="text-white font-mono text-xl tabular-nums">--</p>
          <p className="text-[9px] text-white mt-0.5">Coming soon</p>
        </div>
      </div>
    </ArtCard>
  );
}

/* ─── Live Mint Feed ─── */
export function LiveMintFeed() {
  const mockMints = [
    { addr: '0x1a2b...3c4d', qty: 3, time: '2m ago' },
    { addr: '0x5e6f...7a8b', qty: 1, time: '5m ago' },
    { addr: '0x9c0d...1e2f', qty: 5, time: '12m ago' },
    { addr: '0x3a4b...5c6d', qty: 2, time: '18m ago' },
  ];

  return (
    <ArtCard art={ART.danceNight} opacity={1} overlay="none" className="mb-6">
      <h3 className="text-black font-semibold tracking-wide uppercase text-[11px] mb-4">
        Live Mint Feed
      </h3>
      <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
        {mockMints.map((m, i) => (
          <div
            key={i}
            className="flex items-center justify-between py-2 px-3 rounded-lg bg-black/60 border border-white/20"
          >
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-white font-mono text-xs">{m.addr}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-black/80 text-xs font-mono">x{m.qty}</span>
              <span className="text-white text-[10px]">{m.time}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="text-center text-[10px] text-white mt-3">
        Recent mints will appear here when the collection is live
      </p>
    </ArtCard>
  );
}
