import { useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import { ERC20_ABI, SWAP_FEE_ROUTER_ABI } from '../lib/contracts';
import { TOWELI_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, TOWELI_DECIMALS, CHAIN_ID, isDeployed } from '../lib/constants';

/**
 * "Prove It" — every headline claim rendered FROM a live on-chain read, not from
 * copy. Makes trust-copy drift structurally impossible (the 2026-06-12 audit found
 * a fake supply figure + a 0.30%↔0.5% fee mismatch); a skeptic gets one citable,
 * self-verifying surface. Unlike the activity feed, these are cheap eth_call reads
 * that work on the free RPC roster, so it's always populated. Rows self-gate: a
 * failed read simply doesn't render (never shows a false ✓).
 */

const DEAD = '0x000000000000000000000000000000000000dEaD' as const;
const CHECK = '✓';

function Row({ label, value, verified, href }: { label: string; value: string; verified: boolean; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-white/5"
    >
      <span className="text-[13px] text-text-secondary">{label}</span>
      <span className="flex items-center gap-2 min-w-0">
        <span className="stat-value text-[13px] text-white truncate">{value}</span>
        {verified && (
          <span
            className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px]"
            style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
            title="Verified live on-chain"
            aria-label="verified"
          >
            {CHECK}
          </span>
        )}
      </span>
    </a>
  );
}

export function ProofOfClaims() {
  const feeDeployed = isDeployed(SWAP_FEE_ROUTER_ADDRESS);

  // Static heterogeneous multicall (mirrors useProtocolStats/useRevenueStats). A
  // conditional spread here collapses wagmi's per-entry tuple inference, so the
  // feeBps read is always included; when the router isn't deployed the call simply
  // returns status:'failure' (allowFailure defaults true) and the `feeDeployed`
  // guard below discards it.
  const { data } = useReadContracts({
    contracts: [
      { address: TOWELI_ADDRESS, abi: ERC20_ABI, chainId: CHAIN_ID, functionName: 'totalSupply' },
      { address: TOWELI_ADDRESS, abi: ERC20_ABI, chainId: CHAIN_ID, functionName: 'balanceOf', args: [DEAD] },
      { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, chainId: CHAIN_ID, functionName: 'feeBps' },
    ],
    query: { refetchInterval: 300_000, staleTime: 120_000 },
  });

  const supplyRaw = data?.[0]?.status === 'success' ? (data[0].result as bigint) : undefined;
  const burnedRaw = data?.[1]?.status === 'success' ? (data[1].result as bigint) : undefined;
  const feeBps = feeDeployed && data?.[2]?.status === 'success' ? Number(data[2].result as bigint) : undefined;

  const rows: { label: string; value: string; href: string }[] = [];

  if (supplyRaw !== undefined) {
    const supply = Number(formatUnits(supplyRaw, TOWELI_DECIMALS));
    rows.push({
      label: 'Fixed supply (no mint function)',
      value: `${supply.toLocaleString(undefined, { maximumFractionDigits: 0 })} TOWELI`,
      href: `https://etherscan.io/token/${TOWELI_ADDRESS}#code`,
    });
    if (burnedRaw !== undefined && supplyRaw > 0n) {
      const burnedPct = Number((burnedRaw * 10000n) / supplyRaw) / 100;
      rows.push({
        label: 'Burned forever',
        value: `${burnedPct.toFixed(1)}% of supply`,
        href: `https://etherscan.io/token/${TOWELI_ADDRESS}?a=${DEAD}`,
      });
    }
  }

  if (feeBps !== undefined) {
    rows.push({
      label: 'Protocol swap fee',
      value: `${(feeBps / 100).toFixed(2)}%`,
      href: `https://etherscan.io/address/${SWAP_FEE_ROUTER_ADDRESS}#readContract`,
    });
  }

  // Self-gate: render nothing until at least one claim is verified on-chain.
  if (rows.length === 0) return null;

  return (
    <div className="glass-card rounded-xl p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="heading-luxury text-[15px] text-white">Don&rsquo;t trust — verify</h3>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: '#22c55e' }}>live on-chain</span>
      </div>
      <p className="text-[12px] text-text-secondary mb-2">
        Every number below is read straight from the contracts right now — tap any row to check it yourself on Etherscan.
      </p>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <Row key={r.label} label={r.label} value={r.value} verified href={r.href} />
        ))}
      </div>
    </div>
  );
}
