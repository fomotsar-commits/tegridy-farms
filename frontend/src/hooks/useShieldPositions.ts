import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { GONDI_LOAN_ADDRESS } from '../lib/gondi/loanOffer.js';
import { useMyLoans } from './useMyLoans';
import {
  buildSnapshot,
  idleSnapshot,
  loadingSnapshot,
  unreadableSnapshot,
  type ShieldPositionsSnapshot,
} from '../lib/shield/positions';
import { shieldVenueReadiness } from '../lib/shield/venues';

// The shield's read layer, for loans on Gondi's v3.2 loan contract.
//
// It leans on useMyLoans for the loans rather than reading them again, so the shield and the
// loan dashboard can never show a different set. Gondi keeps only a hash of each loan;
// useMyLoans lists the offer book's records and keeps a loan only when `getLoanHash` on
// mainnet matches it. That check is what makes the loan's own `startTime + duration` the
// chain's deadline, so there is nothing more to read here: Gondi has no grace period and no
// pause extension, and what is owed is Gondi's own arithmetic (`owedAt`).
//
// FAILURE IS A STATE, NOT AN EMPTY LIST. useMyLoans distinguishes "no loans" from "could not
// read" and from "read, but some records did not check out"; the last two are refused here,
// because a shorter list on this surface reads as less risk.

/** Bands move with the clock: re-judge every minute, so a deadline passing flips without a reload. */
const REFRESH_MS = 60_000;

export function useShieldPositions(): ShieldPositionsSnapshot {
  const { address } = useAccount();
  // Not gated on the wallet's chain: useMyLoans reads mainnet from any chain, so a wallet on
  // Base or Robinhood sees its real deadlines here as on the loans tab. Repaying still needs
  // mainnet: prepareRepay refuses a wallet on another chain, and the send is pinned.
  const { loans, isLoading, isError, loansUnread } = useMyLoans();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return useMemo<ShieldPositionsSnapshot>(() => {
    const readiness = shieldVenueReadiness()['tegridy-nft-lending'];
    if (!readiness.readable) return idleSnapshot(readiness.detail ?? undefined);
    if (!address) return idleSnapshot();
    if (isError) return unreadableSnapshot();
    // A PARTIAL READ IS STILL UNREAD. Watching two of three loans and calling it a shield is
    // the failure this panel exists to prevent, so it declines the list rather than showing
    // part as the whole.
    if (loansUnread) {
      return unreadableSnapshot(
        'Some of this wallet’s loan records could not be checked on chain, so this list would be missing positions. It is withheld rather than shown short: a partial read here is an unknown risk, not a smaller one.',
      );
    }
    if (isLoading) return loadingSnapshot();
    // Borrower side only. A lender whose borrower defaults RECEIVES the collateral, so a
    // lender's row is not a liquidation risk and has no place under a "shield" heading.
    const reads = loans
      .filter((l) => l.role === 'borrower')
      .map((l) => ({ loanId: l.id, venue: 'tegridy-nft-lending' as const, lendingContract: GONDI_LOAN_ADDRESS, loan: l.loan }));
    return buildSnapshot(reads, Math.floor(Date.now() / 1000));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick is the intentional time dep
  }, [address, isError, loansUnread, isLoading, loans, tick]);
}
