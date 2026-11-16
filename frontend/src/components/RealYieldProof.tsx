import { m } from 'framer-motion';
import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { REVENUE_DISTRIBUTOR_ADDRESS, TREASURY_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { CardArt } from './ui/CardArt';
import { FinePrint } from './ui/FinePrint';

// The three stat tiles (idx 1-3; idx 0 is the unread / empty notice card).
const YIELD_ART_SLOTS = 3;

/**
 * Where the venue's swap fee goes on Ethereum: the treasury Safe, not stakers (owner ruling
 * 2026-11-15). Beside it, what the stakers' payout contract has paid, read live: only a returned
 * read may say "none", and with nothing paid it renders nothing unless asked (the Farm loop).
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
  // RPC outage indistinguishable from "nothing has been paid" — and
  // this panel's entire job is to state which of those two is true.
  const distributedOk = data?.[0]?.status === 'success';
  const claimedOk = data?.[1]?.status === 'success';
  const epochsOk = data?.[2]?.status === 'success';

  const totalDistributed = distributedOk ? (data![0].result as bigint) : 0n;
  const totalClaimed = claimedOk ? (data![1].result as bigint) : 0n;
  const epochCount = epochsOk ? (data![2].result as bigint) : 0n;

  if (!deployed) return null;
  // Three states: paid, UNREADABLE, and proven-empty. Only a successful read
  // licenses the claim that nothing has been paid.
  const unreadable = !distributedOk;
  const isEmpty = distributedOk && totalDistributed === 0n;
  if ((unreadable || isEmpty) && !showWhenEmpty) return null;

  const distEth = Number(formatEther(totalDistributed));
  const distUsd = distEth * price.ethUsd;
  const claimedPct = totalDistributed > 0n ? Number((totalClaimed * 10000n) / totalDistributed) / 100 : 0;

  // A stat whose own read failed renders a dash. The distributed total is
  // known good here (we would not be in this branch otherwise), but its two
  // companions can fail independently, and "0 epochs" / "0.0% claimed" printed
  // over a live distribution is a worse lie than saying nothing.
  const items = [
    { l: 'ETH Paid to Stakers', v: `${distEth.toFixed(4)} ETH`, sub: distUsd > 0 ? `≈ $${distUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} all-time` : 'all-time', icon: '💎' },
    { l: 'Distribution Epochs', v: epochsOk ? epochCount.toString() : '–', sub: epochsOk ? 'completed' : 'read unavailable', icon: '🗓️' },
    { l: 'Claimed by Stakers', v: claimedOk ? `${claimedPct.toFixed(1)}%` : '–', sub: claimedOk ? 'of all ETH distributed' : 'read unavailable', icon: '🤝' },
  ];

  const payoutLink = (
    <a
      href={`https://etherscan.io/address/${REVENUE_DISTRIBUTOR_ADDRESS}`}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 text-white hover:text-white/80"
    >
      stakers&apos; payout contract on Etherscan ↗
    </a>
  );

  return (
    <m.div
      className="mb-10"
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
    >
      <div className="mb-4">
        <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Where swap fees go
        </h2>
        <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          To the venue&apos;s treasury, not to stakers.{' '}
          <a
            href={`https://etherscan.io/address/${TREASURY_ADDRESS}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            See the treasury ↗
          </a>
        </p>
      </div>
      {unreadable ? (
        <div className="relative isolate rounded-xl p-4" style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
          <CardArt pageId="real-yield-proof" idx={0} />
          <p className="text-[13px] leading-relaxed text-white" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Not read yet. This is not a zero.
          </p>
          <FinePrint summary="Details">
            <p>
              The read of what stakers were paid has not returned, so this panel does not know whether
              any ETH was paid to them. That is a gap in what we can show you, not a figure of zero. The{' '}
              {payoutLink} answers it.
            </p>
          </FinePrint>
        </div>
      ) : isEmpty ? (
        <div className="relative isolate rounded-xl p-4" style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
          <CardArt pageId="real-yield-proof" idx={0} />
          {/* Rendered only on a successful read of zero, so "none" is the chain's word. The
              1 ETH round is RevenueDistributor.MIN_DISTRIBUTE_AMOUNT. */}
          <p className="text-[13px] leading-relaxed" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            No ETH has been paid to stakers.
          </p>
          <FinePrint summary="Details">
            <p>
              The swap fee used to be routed to the {payoutLink}, which pays only in rounds of 1 ETH.
              It never paid one out.
            </p>
          </FinePrint>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {items.map((it, i) => (
            <div
              key={it.l}
              className="relative isolate rounded-xl p-3 md:p-4"
              style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
            >
              <CardArt pageId="real-yield-proof" idx={1 + (i % YIELD_ART_SLOTS)} />
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
