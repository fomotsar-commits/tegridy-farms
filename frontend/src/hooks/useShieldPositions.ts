import { useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { CHAIN_ID, TEGRIDY_NFT_LENDING_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_NFT_LENDING_ABI } from '../lib/contracts';
import { useMyLoans } from './useMyLoans';
import {
  buildSnapshot,
  idleSnapshot,
  loadingSnapshot,
  unreadableSnapshot,
  type RawLoanRead,
  type ShieldPositionsSnapshot,
} from '../lib/shield/positions';
import { shieldVenueReadiness } from '../lib/shield/venues';

// The shield's read layer.
//
// It leans on useMyLoans for loan discovery rather than re-scanning, so the
// shield and the loan dashboard can never show a different set of loans. What it
// adds is the two facts the dashboard does not read and the health model needs:
// `effectiveDeadline` (the pause-adjusted deadline the claim path acts on, which
// is NOT the `deadline` field on the loan struct) and the live repayment quote.
//
// FAILURE IS A STATE, NOT AN EMPTY LIST. useMyLoans already distinguishes "no
// loans" from "could not read"; this hook carries that through and adds its own:
// a loan whose deadline read failed keeps its row and reports `unreadable`
// health, because dropping it would shrink the list silently and a shorter list
// on this surface reads as less risk.

/** Deadline and quote move on their own clock; a minute is fine and cheap. */
const REFRESH_MS = 60_000;

export function useShieldPositions(): ShieldPositionsSnapshot {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { loans, isLoading: loansLoading, isError: loansError } = useMyLoans();

  const onExpectedChain = chainId === CHAIN_ID;
  const lendingDeployed = isDeployed(TEGRIDY_NFT_LENDING_ADDRESS);

  // Borrower side only. A lender's exposure is real but it is not a liquidation
  // risk — a lender whose borrower defaults RECEIVES the collateral — and
  // showing those rows here would put positions under a "shield" heading that
  // the shield has nothing to say about.
  const myBorrows = useMemo(
    () => loans.filter((l) => l.role === 'borrower' && l.source === 'nft'),
    [loans],
  );
  const borrowKey = myBorrows.map((l) => l.id).join(',');

  const [reads, setReads] = useState<RawLoanRead[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [reading, setReading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNonce((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // `setReading(false)` on both early returns: a pass cancelled mid-flight by a
    // dependency change would otherwise leave the flag stuck true, and the panel
    // would report "reading" forever — a loading state that never resolves reads
    // as a system still working on it, which is its own false reassurance.
    if (!publicClient || !address || !onExpectedChain || !lendingDeployed) {
      setReads(null);
      setReadFailed(false);
      setReading(false);
      return;
    }
    if (myBorrows.length === 0) {
      setReads([]);
      setReadFailed(false);
      setReading(false);
      return;
    }
    let cancelled = false;
    setReading(true);
    (async () => {
      const contract = TEGRIDY_NFT_LENDING_ADDRESS as Address;
      // GRACE_PERIOD is a constant on the contract, so one read covers every
      // loan. Failing it makes every deadline unjudgeable, which is why it is
      // read as `null` rather than defaulted to the value in the source: a
      // constant we assume is a constant nobody read.
      const grace = await publicClient
        .readContract({ address: contract, abi: TEGRIDY_NFT_LENDING_ABI, functionName: 'GRACE_PERIOD' })
        .then((v) => Number(v as bigint))
        .catch(() => null);

      const settled = await Promise.all(
        myBorrows.map(async (loan) => {
          const [deadline, quote] = await Promise.all([
            publicClient
              .readContract({
                address: contract,
                abi: TEGRIDY_NFT_LENDING_ABI,
                functionName: 'effectiveDeadline',
                args: [BigInt(loan.id)],
              })
              .then((v) => Number(v as bigint))
              .catch(() => null),
            publicClient
              .readContract({
                address: contract,
                abi: TEGRIDY_NFT_LENDING_ABI,
                functionName: 'getRepaymentAmount',
                args: [BigInt(loan.id)],
              })
              .then((v) => v as bigint)
              .catch(() => null),
          ]);
          const raw: RawLoanRead = {
            loanId: loan.id,
            venue: 'tegridy-nft-lending',
            lendingContract: contract,
            collateralContract: loan.collateralContract ?? null,
            tokenId: loan.tokenId,
            principal: loan.principal,
            borrower: loan.borrower,
            repaid: loan.repaid,
            defaultClaimed: loan.defaultClaimed,
            effectiveDeadlineUnix: deadline,
            graceSeconds: grace,
            quotedRepayWei: quote,
          };
          return raw;
        }),
      );
      if (cancelled) return;
      // Every deadline read failing is an RPC outage, not many independently
      // broken loans, and it is reported as one rather than as a list of rows
      // that each individually say "unknown".
      const allDark = settled.length > 0 && settled.every((r) => r.effectiveDeadlineUnix == null);
      setReadFailed(allDark);
      setReads(settled);
      setReading(false);
    })().catch(() => {
      if (cancelled) return;
      setReadFailed(true);
      setReading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- borrowKey is the structural stand-in for myBorrows; nonce is the refresh tick
  }, [publicClient, address, onExpectedChain, lendingDeployed, borrowKey, nonce]);

  return useMemo<ShieldPositionsSnapshot>(() => {
    const readiness = shieldVenueReadiness()['tegridy-nft-lending'];
    if (!readiness.readable) return idleSnapshot(readiness.detail ?? undefined);
    if (!address) return idleSnapshot();
    if (!onExpectedChain) {
      return idleSnapshot(
        'This wallet is on another network, so its Ethereum Mainnet loans were not read. Switch networks to see them — nothing is being watched from here.',
      );
    }
    if (loansError) return unreadableSnapshot();
    if (readFailed) return unreadableSnapshot();
    if (loansLoading || reading || reads === null) return loadingSnapshot();
    return buildSnapshot(reads, Math.floor(Date.now() / 1000));
  }, [address, onExpectedChain, loansError, loansLoading, readFailed, reading, reads]);
}
