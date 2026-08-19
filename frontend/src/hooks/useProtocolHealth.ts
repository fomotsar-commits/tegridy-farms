import { useReadContracts } from 'wagmi';
import { TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';

/**
 * The four states a health indicator is allowed to occupy.
 *
 * `unknown` is not a loading nicety — it is the state every other state decays
 * into. Absence of evidence resolves here, never to `active`.
 */
export type ProtocolHealthStatus = 'active' | 'degraded' | 'paused' | 'unknown';

export interface ProtocolHealth {
  status: ProtocolHealthStatus;
  /** User-facing label. Only `active` is permitted to read as a positive claim. */
  label: string;
  /** What the status was derived from, verbatim, for a tooltip/aria description. */
  basis: string;
  /** Dot colour. Green exists only on `active`. */
  color: string;
}

/** Inputs the mapping is allowed to consider. Keeping it a plain record makes the
 *  mapping unit-testable without a chain, which is the point: the rule matters
 *  more than the wiring. */
export interface ProtocolHealthInputs {
  /** The staking address is wired (non-zero) in constants. */
  stakingDeployed: boolean;
  /** The `paused()` call came back `status: 'success'`. A pending or failed read is `false`. */
  pausedReadOk: boolean;
  /** Only meaningful when `pausedReadOk`. */
  paused: boolean;
  /** No price at all — neither on-chain nor API nor cache. */
  priceUnavailable: boolean;
  /** The only price on hand came from a >5min-old localStorage cache. */
  displayPriceStale: boolean;
}

const GREEN = '#22c55e';
const AMBER = '#d4a843';
const RED = 'var(--color-danger)';
const GREY = '#94a3b8';

/**
 * PURE: map real reads onto a health claim.
 *
 * The ordering below is the whole safety property, so it is written as a ladder
 * rather than a boolean expression. A green dot is a factual claim about the
 * chain, and the only thing that can license one is a *successful* read that
 * came back false — an RPC outage, a not-yet-resolved query, and an unwired
 * address are all indistinguishable from the outside and all land on `unknown`.
 *
 * Why the price legs sit under, not beside, the pause leg: `paused()` proves the
 * venue is open, the price legs prove the venue can quote. The indicator sits
 * next to a price, so a venue that cannot quote must not read as fully healthy —
 * but neither should it read as paused, which is a different and more alarming
 * fact.
 *
 * Two price signals are deliberately NOT consulted:
 *   • `oracleStale` — its 300s window is tighter than mainnet ETH/USD's own 3600s
 *     heartbeat, so it is true for ~85% of wallclock against a perfectly healthy
 *     feed (measured; see MAX_LAUNCH_STALENESS_SECONDS in useToweliPrice). An
 *     indicator that reads degraded most of the time is noise, and noise is how a
 *     real degradation gets ignored.
 *   • `pairTooThinToPrice` — a standing condition of the native pair, not an
 *     incident, and the API leg answers through it. It belongs on the surfaces
 *     that explain provenance, not on a liveness dot.
 * Both remain available on the price context for a surface that wants to say so.
 */
export function deriveProtocolHealth(i: ProtocolHealthInputs): ProtocolHealth {
  if (!i.stakingDeployed) {
    return {
      status: 'unknown',
      label: 'Status unknown',
      basis: 'No staking address is wired in this build, so protocol state cannot be read.',
      color: GREY,
    };
  }
  if (!i.pausedReadOk) {
    return {
      status: 'unknown',
      label: 'Status unknown',
      basis: 'The on-chain pause read has not returned. Protocol state is unverified, not assumed healthy.',
      color: GREY,
    };
  }
  if (i.paused) {
    return {
      status: 'paused',
      label: 'Staking paused',
      basis: 'TegridyStaking.paused() returned true on mainnet.',
      color: RED,
    };
  }
  if (i.priceUnavailable) {
    return {
      status: 'degraded',
      label: 'Degraded · no price',
      basis: 'Staking is unpaused on-chain, but no TOWELI price source is answering.',
      color: AMBER,
    };
  }
  if (i.displayPriceStale) {
    return {
      status: 'degraded',
      label: 'Degraded · stale price',
      basis: 'Staking is unpaused on-chain, but the only TOWELI price on hand is a cached one over 5 minutes old.',
      color: AMBER,
    };
  }
  return {
    status: 'active',
    label: 'Protocol Active',
    basis: 'TegridyStaking.paused() returned false on mainnet and a fresh TOWELI price is answering.',
    color: GREEN,
  };
}

/**
 * Wallet-free, chainId-pinned protocol health.
 *
 * Deliberately reads nothing that a connected wallet is required for: this feeds a
 * globally-mounted indicator that a disconnected visitor sees, and a signal that
 * only works once you connect is a signal that lies to everyone else.
 */
export function useProtocolHealth(): ProtocolHealth {
  const stakingDeployed = checkDeployed(TEGRIDY_STAKING_ADDRESS);
  const { priceUnavailable, displayPriceStale } = useTOWELIPrice();

  const { data } = useReadContracts({
    contracts: [
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'paused', chainId: CHAIN_ID },
    ],
    query: { enabled: stakingDeployed, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  const pausedReadOk = data?.[0]?.status === 'success';

  return deriveProtocolHealth({
    stakingDeployed,
    pausedReadOk,
    paused: pausedReadOk ? (data![0].result as boolean) : false,
    priceUnavailable,
    displayPriceStale,
  });
}
