import { m } from 'framer-motion';
import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { REVENUE_DISTRIBUTOR_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';

/**
 * Real-yield proof strip — the protocol's one true differentiator is
 * "100% of protocol fees → stakers, in ETH", and this makes it VERIFIABLE:
 * cumulative ETH distributed, epochs completed, and % already claimed, read
 * straight from RevenueDistributor with an Etherscan link to check the math.
 *
 * SELF-GATING BY DESIGN (2026-06-09): renders nothing until the first real
 * distribution lands (totalDistributed > 0), so it can ship pre-LP-seed
 * without adding another zero to the page — and lights up on its own the
 * day the flywheel turns. Additive — drop <RealYieldProof/> on any page.
 *
 * The gate is on the READ, not the value. "Nothing has been paid yet" is a claim
 * about the chain and needs a successful call behind it; an unreturned read says
 * so in words instead of borrowing the zero-state's copy.
 */
export function RealYieldProof({ showWhenEmpty = false }: { showWhenEmpty?: boolean } = {}) {
  const deployed = isDeployed(REVENUE_DISTRIBUTOR_ADDRESS);
  const price = useTOWELIPrice();

  const { data } = useReadContracts({
    contracts: [
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalDistributed', chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalClaimed', chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'epochCount', chainId: CHAIN_ID },
    ],
    query: { enabled: deployed, refetchInterval: 60_000 },
  });

  // Per-call status, not just the value. Collapsing a failed read to 0n makes an
  // RPC outage indistinguishable from "nothing has been distributed yet" — and
  // this panel's entire job is to state which of those two is true.
  const distributedOk = data?.[0]?.status === 'success';
  const claimedOk = data?.[1]?.status === 'success';
  const epochsOk = data?.[2]?.status === 'success';

  const totalDistributed = distributedOk ? (data![0].result as bigint) : 0n;
  const totalClaimed = claimedOk ? (data![1].result as bigint) : 0n;
  const epochCount = epochsOk ? (data![2].result as bigint) : 0n;

  // Self-gating: by default render nothing until the first distribution lands (never a
  // zero-stat). With showWhenEmpty (the Farm staking loop) surface the thesis + mechanism +
  // Etherscan link in a graceful "accrues as volume grows" state instead of a stark zero.
  if (!deployed) return null;
  // Three states, and the middle one used to be swallowed by the third: proven,
  // UNREADABLE, and proven-empty. Only a successful read licenses the claim that
  // nothing has been paid yet.
  const unreadable = !distributedOk;
  const isEmpty = distributedOk && totalDistributed === 0n;
  if ((unreadable || isEmpty) && !showWhenEmpty) return null;

  const distEth = Number(formatEther(totalDistributed));
  const distUsd = distEth * price.ethUsd;
  const claimedPct = totalDistributed > 0n ? Number((totalClaimed * 10000n) / totalDistributed) / 100 : 0;

  // A stat whose own read failed renders an em dash. The distributed total is
  // known good here (we would not be in this branch otherwise), but its two
  // companions can fail independently, and "0 epochs" / "0.0% claimed" printed
  // over a live distribution is a worse lie than saying nothing.
  const items = [
    { l: 'ETH Paid to Stakers', v: `${distEth.toFixed(4)} ETH`, sub: distUsd > 0 ? `≈ $${distUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} all-time` : 'all-time', icon: '💎' },
    { l: 'Distribution Epochs', v: epochsOk ? epochCount.toString() : '–', sub: epochsOk ? 'completed' : 'read unavailable', icon: '🗓️' },
    { l: 'Claimed by Stakers', v: claimedOk ? `${claimedPct.toFixed(1)}%` : '–', sub: claimedOk ? 'of all ETH distributed' : 'read unavailable', icon: '🤝' },
  ];

  return (
    <m.div
      className="mb-10"
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
    >
      <div className="mb-4">
        <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          {/* "Proven On-Chain" is a claim that has to be EARNED by a distribution. In the
              showWhenEmpty state (the Farm loop) nothing has been distributed, so the
              heading said "Proven" over an empty panel while the note under it correctly
              explained that no epoch had settled. Matches the wording /premium already
              chose for the same zero ("ETH yield — not yet paid"). */}
          {unreadable ? 'Real Yield — Figures Unavailable' : isEmpty ? 'Real Yield — Not Yet Paid' : 'Real Yield, Proven On-Chain'}
        </h2>
        <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Not emissions. Not IOUs. ETH from protocol fees, distributed to stakers —{' '}
          <a
            href={`https://etherscan.io/address/${REVENUE_DISTRIBUTOR_ADDRESS}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            verify on Etherscan ↗
          </a>
        </p>
      </div>
      {unreadable ? (
        <div className="rounded-xl p-4" style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
          <p className="text-[13px] leading-relaxed text-white" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            The cumulative-distribution read has not returned, so this panel cannot say whether any
            ETH has been paid out. That is a gap in what we can show you, not a figure of zero — the
            Etherscan link above answers it directly in the meantime.
          </p>
        </div>
      ) : isEmpty ? (
        <div className="rounded-xl p-4" style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
          {/* 2026-08-07: dropped "100% of protocol swap fees". AUDIT R073 — swap fees
              split 5/6 to LPs and 1/6 to the protocol, and the protocol's share then
              splits again between stakers, liquidity and operations. Same correction
              as ConnectPrompt.tsx:30 (F109), OnboardingModal.tsx and Footer.tsx. The
              routing claim is true and checkable; the percentage was not. */}
          <p className="text-[13px] leading-relaxed" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            ETH distributions to stakers begin as native-pool swap volume comes online — the protocol&apos;s share of swap fees routes here on-chain. This panel fills with the live cumulative the moment the first epoch settles.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {items.map((it) => (
            <div
              key={it.l}
              className="rounded-xl p-3 md:p-4"
              style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
            >
              <p
                className="text-[11px] uppercase tracking-wider mb-1.5 flex items-center gap-1.5"
                style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
              >
                <span aria-hidden="true">{it.icon}</span>{it.l}
              </p>
              <p className="stat-value text-lg md:text-xl" style={{ color: '#22c55e', textShadow: '0 1px 8px rgba(0,0,0,0.95)' }}>
                {it.v}
              </p>
              <p className="text-[10px] mt-0.5" style={{ color: '#22c55e', opacity: 0.75 }}>{it.sub}</p>
            </div>
          ))}
        </div>
      )}
    </m.div>
  );
}
