import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { CHAIN_ID, isDeployed } from '../lib/constants';
import { BNPL_DESK_ADDRESS, NFTFI_BNPL_ABI } from './usePooledLendingConfig';

// The instalment desk's own posted terms, and whether it exists at all.
//
// Same three-state rule as the pooled-vault hook: `not-deployed` and
// `unreadable` are separate from `live`, and neither is allowed to produce a
// number. Every field is null outside `live`, so a surface cannot accidentally
// render a written default as a live reading.
//
// THERE IS NO PLAN LIST HERE, ON PURPOSE. Enumerating every plan means walking
// `plans(i)` from zero, which is a payment schedule belonging to strangers, and
// the venue has no indexer to ask for a wallet-filtered view instead
// (VITE_INDEXER_URL is unset). A "my plans" surface waits for that; it does not
// get built by scraping the whole book.

export type BnplDeskStatus = 'not-deployed' | 'unreadable' | 'live';

export interface BnplDeskState {
  status: BnplDeskStatus;
  /** Every field below is meaningful only in `live`. */
  depositBps: number | null;
  saleFeeBps: number | null;
  instalments: number | null;
  instalmentIntervalSeconds: number | null;
  paymentGraceSeconds: number | null;
  planCount: number | null;
  /** Plain-language reason the surface should show instead of numbers. */
  detail: string | null;
}

const NOT_DEPLOYED_DETAIL =
  'The instalment desk has no contract on any chain yet. Any terms shown alongside this are what the written contract sets, not what a deployment reports.';

const UNREADABLE_DETAIL =
  'The instalment desk could not be read just now, so nothing here is a statement about live terms.';

/**
 * The terms the SOURCE sets, for a surface that has to describe the product
 * before a deployment exists to ask.
 *
 * Mirrors the constants and constructor defaults in
 * contracts/src/nftfi/NftfiBnpl.sol. Anything drawn from these must be labelled
 * as the written terms — that is the whole reason they are a separate export
 * from `useBnplDesk` rather than a fallback inside it. A fallback would let a
 * dead read look like a live one.
 */
export const BNPL_WRITTEN_TERMS = {
  depositBps: 2_500,
  saleFeeBps: 0,
  instalments: 3,
  instalmentIntervalSeconds: 30 * 24 * 60 * 60,
  paymentGraceSeconds: 3 * 24 * 60 * 60,
} as const;

function empty(status: BnplDeskStatus, detail: string): BnplDeskState {
  return {
    status,
    depositBps: null,
    saleFeeBps: null,
    instalments: null,
    instalmentIntervalSeconds: null,
    paymentGraceSeconds: null,
    planCount: null,
    detail,
  };
}

export function useBnplDesk(): BnplDeskState {
  const deployed = isDeployed(BNPL_DESK_ADDRESS);

  const { data } = useReadContracts({
    contracts: [
      { address: BNPL_DESK_ADDRESS, abi: NFTFI_BNPL_ABI, functionName: 'depositBps', chainId: CHAIN_ID },
      { address: BNPL_DESK_ADDRESS, abi: NFTFI_BNPL_ABI, functionName: 'saleFeeBps', chainId: CHAIN_ID },
      { address: BNPL_DESK_ADDRESS, abi: NFTFI_BNPL_ABI, functionName: 'planCount', chainId: CHAIN_ID },
      { address: BNPL_DESK_ADDRESS, abi: NFTFI_BNPL_ABI, functionName: 'INSTALMENTS', chainId: CHAIN_ID },
      { address: BNPL_DESK_ADDRESS, abi: NFTFI_BNPL_ABI, functionName: 'INSTALMENT_INTERVAL', chainId: CHAIN_ID },
      { address: BNPL_DESK_ADDRESS, abi: NFTFI_BNPL_ABI, functionName: 'PAYMENT_GRACE', chainId: CHAIN_ID },
    ] as const,
    query: { enabled: deployed, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    if (!deployed) return empty('not-deployed', NOT_DEPLOYED_DETAIL);
    if (!data) return empty('unreadable', UNREADABLE_DETAIL);
    // Named, one per call, in the order the batch was written. Each is checked
    // before it is read: a positional `data[i]` says nothing about whether slot
    // `i` exists or landed, and `Number(undefined)` is NaN — a field that would
    // render as a number nobody read. All six or none, because five live terms
    // beside a sixth that silently failed is a term sheet that is wrong in one
    // place and looks right everywhere.
    const [deposit, saleFee, plans, instalments, interval, grace] = data;
    if (
      deposit.status !== 'success' ||
      saleFee.status !== 'success' ||
      plans.status !== 'success' ||
      instalments.status !== 'success' ||
      interval.status !== 'success' ||
      grace.status !== 'success'
    ) {
      return empty('unreadable', UNREADABLE_DETAIL);
    }
    return {
      status: 'live' as const,
      depositBps: Number(deposit.result),
      saleFeeBps: Number(saleFee.result),
      planCount: Number(plans.result),
      instalments: Number(instalments.result),
      instalmentIntervalSeconds: Number(interval.result),
      paymentGraceSeconds: Number(grace.result),
      detail: null,
    };
  }, [deployed, data]);
}
