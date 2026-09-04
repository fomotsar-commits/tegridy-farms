import { useEffect, useState } from 'react';
import { fetchHeat, isSupportedHeatAddress } from '../lib/heat/heatClient';
import type { HeatReading } from '../lib/heat/heatOracle';
import type { GeckoNetwork } from '../lib/geckoTerminal/pools';
import { useTokenScan, type ScanStatus } from './useTokenScan';
import { useDeployerReputation, type DeployerStatus } from './useDeployerReputation';
import {
  assessRowSafety,
  componentUnread,
  deployerReadFrom,
  distributionReadFrom,
  heatReadFrom,
  type ComponentRead,
  type DeployerRead,
  type DistributionRead,
  type HeatRead,
  type RowSafety,
} from '../lib/terminal/rowSafety';

// Composes the three live reads behind one row's safety verdict.
//
// ONE ROW AT A TIME, on request. Three upstreams (holder enumeration, the
// explorer's creation list, the Heat oracle) times fifty rows is a request storm
// that would rate-limit all three and then report the rate limiting as a page
// full of unknowns — the outage would be self-inflicted and would look exactly
// like the honest state. So the page scores the row a trader asked about, and
// every other row stays explicitly unscored rather than optimistically green.
//
// THE DEPLOYER GAP IS REAL AND IS NOT PAPERED OVER. Resolving which address
// created a token needs Etherscan's `getcontractcreation`, which is not in
// frontend/api/etherscan.js's action allowlist, so no creator lookup exists on
// this build. A caller that has the deployer from elsewhere passes it; a caller
// that does not gets `unread` with that sentence, and the row stays unrated. The
// alternative — treating an unknown deployer as a deployer with nothing against
// them — is the exact inversion this page exists to refuse.
//
// AND THE GAP IS WIDER OFF ETHEREUM. The reputation core reads Ethereum
// mainnet's explorer; Base creations are not read here and Solana has no
// equivalent at all. On those chains a pasted address is IGNORED rather than
// used, because scoring a Base row against its address's Ethereum history would
// be a confident answer to a different question. See
// DEPLOYER_NOT_ON_THIS_CHAIN.

// Words each scan status contributes, as a statement about the READ.
//
// KEYED BY THE STATUS UNION, NOT BY `string`. A `Record<string, string>` has no
// key it is required to carry, so a lookup off it is `string | undefined` and the
// miss has to be papered over with a fallback — which is how a status nobody
// wrote a sentence for ends up described by whichever sentence the fallback
// points at. Typed this way the compiler names any status that has no words yet.
//
// `success` is in here because these lookups are reached whenever the row could
// not be SCORED, and a read can report success while carrying no analysis. That
// state is not a failed read and must not borrow the failed-read sentence.
const SCAN_UNREAD_REASON: Record<ScanStatus, string> = {
  idle: 'No holder read has been requested for this token yet.',
  loading: 'The holder read for this token is still running.',
  invalid: 'This token address is not a well-formed Ethereum or Solana address, so no holder read was attempted.',
  empty: 'No holder data came back for this token, so concentration could not be measured.',
  unavailable: 'The holder data source for this chain is not enabled on this deployment.',
  error: 'The holder read did not complete. This is a statement about the read, not about the token.',
  success: 'The holder read completed but carried no analysis, so concentration could not be measured.',
};

const DEPLOYER_UNREAD_REASON: Record<DeployerStatus, string> = {
  idle: 'No deployer read has been requested.',
  loading: 'The deployer read is still running.',
  invalid: 'The supplied deployer address is not a well-formed Ethereum address.',
  empty: 'No contracts deployed directly by this address were found, so there is no history to read.',
  error: 'The deployer read did not complete. This is a statement about the read, not about the address.',
  success: 'The deployer read completed but carried no reputation, so the deployer history could not be scored.',
};

export const NO_CREATOR_LOOKUP_REASON =
  'The address that deployed this token has not been resolved: this build has no contract-creator lookup, so the deployer history could not be read. Paste the deployer to score this row.';

/**
 * The deployer read is an ETHEREUM-MAINNET explorer read, and there is no
 * equivalent on the other two chains this feed covers.
 *
 * Stated per chain rather than with one vague sentence, because the two gaps
 * have different shapes and different fixes: on Base the creation exists and is
 * simply not read here, on Solana the concept the reputation core measures —
 * "contracts this address deployed, and whether they still have a live market" —
 * has no direct analogue at all. A trader deciding whether to wait for a better
 * answer needs to know which of those they are looking at.
 *
 * Keyed by the network union, not `string`, so a fourth network cannot be added
 * without someone writing its sentence.
 */
export const DEPLOYER_NOT_ON_THIS_CHAIN: Record<Exclude<GeckoNetwork, 'eth'>, string> = {
  base:
    'Deployer history is an Ethereum-mainnet explorer read, and Base contract creations are not read on this build — so this half of the score is missing for every Base row. The holder read (top-20 concentration, via Base’s keyless explorer) still runs.',
  solana:
    'Deployer history is read from the Ethereum explorer and no equivalent read exists for Solana on this build, so this half of the score is missing. The holder read — mint and freeze authority, top-20 concentration — still runs.',
};

export type HeatStatus = 'idle' | 'loading' | 'read' | 'unread';

export interface TerminalSafetyState {
  safety: RowSafety;
  /** True while any component read is still in flight. */
  loading: boolean;
  /** Live sub-states, so a panel can show which read is still running. */
  scanStatus: string;
  deployerStatus: string;
  heatStatus: HeatStatus;
}

export interface UseTerminalSafetyOptions {
  /** Token to score. Empty parks every read in `idle`. */
  token: string;
  /**
   * Deploying address, when the caller knows it. Empty means unknown — see the
   * deployer gap above — and produces an explicit unread, never a pass.
   */
  deployer?: string;
  /**
   * Wallet whose Heat standing to display beside the row. Defaults to the
   * deployer. Heat never scores the row (see HEAT_IS_NOT_A_RISK_SIGNAL).
   */
  heatAddress?: string;
  /**
   * Which chain the row is on.
   *
   * Load-bearing for the HOLDER read: Base shares Ethereum's 0x address format,
   * so `detectChain` cannot tell them apart and a Base token would otherwise be
   * scanned against Ethereum's holder source — which answers about a different
   * contract at the same address, or about nothing, and either way answers
   * confidently. Only an explicit override is honest here (the same reason
   * ScannerPage carries a chain toggle).
   *
   * Omitted means "auto-detect from the address format", which is correct for a
   * pasted address and wrong for a feed row.
   */
  network?: GeckoNetwork;
}

export function useTerminalSafety(opts: UseTerminalSafetyOptions): TerminalSafetyState {
  const token = (opts.token ?? '').trim();
  const network = opts.network;
  const suppliedDeployer = (opts.deployer ?? '').trim();

  // OFF ETHEREUM THE PASTE IS IGNORED, not merely unused. The reputation core
  // reads Ethereum mainnet, so running it against an address a visitor believes
  // is a Base or Solana deployer would return that address's ETHEREUM history
  // and present it as this row's — a real answer to a question nobody asked.
  // Passing '' keeps the request from being made at all, and the row carries the
  // per-chain sentence instead.
  const deployerOnChain = network !== undefined && network !== 'eth';
  const deployer = deployerOnChain ? '' : suppliedDeployer;
  const heatAddress = (opts.heatAddress ?? deployer).trim();

  // Base is 0x-shaped, so it can only ever arrive as an explicit override;
  // Solana is unambiguous from its base58 form and Ethereum is the default, so
  // both are left to auto-detect rather than forced.
  const scan = useTokenScan(token, network === 'base' ? 'base' : undefined);
  const deployerState = useDeployerReputation(deployer);

  const [heat, setHeat] = useState<{ status: HeatStatus; read: ComponentRead<HeatRead> }>({
    status: 'idle',
    read: componentUnread('No Heat reading has been requested.'),
  });

  useEffect(() => {
    if (!heatAddress || !isSupportedHeatAddress(heatAddress)) {
      setHeat({
        status: 'unread',
        read: componentUnread(
          heatAddress
            ? 'That is not an address the Heat instrument can read.'
            : 'No wallet was supplied, so no Heat reading was requested.',
        ),
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setHeat({ status: 'loading', read: componentUnread('The Heat reading is still running.') });

    fetchHeat(heatAddress, { signal: controller.signal })
      .then((reading: HeatReading) => {
        if (cancelled) return;
        setHeat({ status: 'read', read: heatReadFrom(reading) });
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        // An unreachable instrument is never a cold wallet. The oracle client
        // already refuses to collapse those two; this keeps the distinction on
        // the way into the row.
        setHeat({
          status: 'unread',
          read: componentUnread(
            err instanceof Error ? err.message : 'The Heat instrument could not be read.',
          ),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [heatAddress]);

  const distribution: ComponentRead<DistributionRead> =
    scan.status === 'success' && scan.outcome
      ? distributionReadFrom(scan.outcome.analysis)
      : componentUnread(SCAN_UNREAD_REASON[scan.status]);

  const deployerRead: ComponentRead<DeployerRead> = deployerOnChain
    ? componentUnread(DEPLOYER_NOT_ON_THIS_CHAIN[network as Exclude<GeckoNetwork, 'eth'>])
    : !deployer
      ? componentUnread(NO_CREATOR_LOOKUP_REASON)
      : deployerState.status === 'success' && deployerState.reputation
        ? deployerReadFrom(deployerState.reputation)
        : componentUnread(DEPLOYER_UNREAD_REASON[deployerState.status]);

  return {
    safety: assessRowSafety({ distribution, deployer: deployerRead, heat: heat.read }),
    loading: scan.status === 'loading' || deployerState.status === 'loading' || heat.status === 'loading',
    scanStatus: scan.status,
    deployerStatus: deployerState.status,
    heatStatus: heat.status,
  };
}
