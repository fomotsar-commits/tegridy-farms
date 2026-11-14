import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContracts } from 'wagmi';
import type { Hex } from 'viem';
import { CHAIN_ID, isDeployed } from '../lib/constants';
import { GONDI_LOAN_ABI } from '../lib/gondi/abi.js';
import { GONDI_LOAN_ADDRESS, sameAddress } from '../lib/gondi/loanOffer.js';
import { loanEnd, loanFromJson, loanHash, type Loan } from '../lib/gondi/loanMath';
import { useBookLoans, useSyncClosedLoans } from '../lib/gondi/offerBook';

// The wallet's open NFT loans, for the dashboard.
//
// NFT lending runs on Gondi's v3.2 loan contract, which keeps only a hash of each loan. So
// the loans come from the offer book's records (lib/gondi/offerBook.ts), and each open one
// is checked against `getLoanHash` on mainnet, exactly as My Loans does
// (components/nftfinance/NFTLendingLoans.tsx). A zero hash is a loan closed on chain that
// the book has not heard about yet: it is left out, and the book is asked how it closed. A hash that does not match, or that
// could not be read, is UNREAD: counted, never shown as a loan and never dropped silently.

/** Re-evaluate overdue on a minute tick, so a loan passing its due time flips without a reload. */
const STATUS_TICK_MS = 60_000;
const REFETCH_MS = 60_000;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/** User's side of the loan. Drives how we frame numbers (owed vs earning). */
export type LoanRole = 'borrower' | 'lender';

export interface MyLoan {
  /** Gondi's loan id. */
  id: number;
  role: LoanRole;
  borrower: string;
  /** The first lender. A loan can have several (tranches); `principal` is this wallet's part when it lends. */
  lender: string;
  tokenId: bigint;
  collateralContract: string;
  /** Borrower: the whole loan. Lender: the sum of this wallet's tranches. */
  principal: bigint;
  aprBps: bigint;
  startTime: bigint;
  /** startTime + duration. Gondi has no grace period: from this second the loan can be claimed. */
  deadline: bigint;
  /** The loan as getLoanHash confirmed it. Repaying or claiming sends it back whole. */
  loan: Loan;
  /** Always false here: only open loans are listed. */
  repaid: boolean;
  defaultClaimed: boolean;
  status: 'active' | 'overdue' | 'repaid' | 'defaulted';
}

function toMyLoan(id: number, loan: Loan, wallet: string, now: bigint): MyLoan | null {
  const isBorrower = sameAddress(loan.borrower, wallet);
  const mine = loan.tranche.filter((t) => sameAddress(t.lender, wallet));
  if (!isBorrower && mine.length === 0) return null;
  const deadline = loanEnd(loan);
  return {
    id,
    role: isBorrower ? 'borrower' : 'lender',
    borrower: loan.borrower,
    lender: loan.tranche[0]?.lender ?? '',
    tokenId: loan.nftCollateralTokenId,
    collateralContract: loan.nftCollateralAddress,
    principal: isBorrower ? loan.principalAmount : mine.reduce((acc, t) => acc + t.principalAmount, 0n),
    aprBps: (isBorrower ? loan.tranche[0] : mine[0])?.aprBps ?? 0n,
    startTime: loan.startTime,
    deadline,
    loan,
    repaid: false,
    defaultClaimed: false,
    // Gondi: `expirationTime > block.timestamp` is the only thing that stops a claim.
    status: now >= deadline ? 'overdue' : 'active',
  };
}

export function useMyLoans() {
  const { address } = useAccount();
  const deployed = isDeployed(GONDI_LOAN_ADDRESS);
  const book = useBookLoans(deployed ? address : undefined);

  const openRows = useMemo(
    () => (book.data?.loans ?? []).filter((r) => r.status === 'open'),
    [book.data],
  );

  const hashes = useReadContracts({
    contracts: openRows.map((r) => ({
      address: GONDI_LOAN_ADDRESS,
      abi: GONDI_LOAN_ABI,
      functionName: 'getLoanHash',
      args: [BigInt(r.loanId)],
      chainId: CHAIN_ID,
    }) as const),
    query: { enabled: deployed && openRows.length > 0, refetchInterval: REFETCH_MS },
  });

  // A zero hash on an open record: the loan closed, or moved to a new lender, where the site
  // did not see it. The book finds out how, and a moved loan comes back as its new loan.
  useSyncClosedLoans(openRows, hashes.data);

  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStatusTick((n) => n + 1), STATUS_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const { loans, unreadRecords } = useMemo(() => {
    if (!address || openRows.length === 0 || !hashes.data) return { loans: [] as MyLoan[], unreadRecords: 0 };
    const now = BigInt(Math.floor(Date.now() / 1000));
    const out: MyLoan[] = [];
    let unread = 0;
    openRows.forEach((row, i) => {
      const read = hashes.data?.[i];
      if (!read || read.status !== 'success') { unread++; return; }
      const chainHash = String(read.result as Hex).toLowerCase();
      if (chainHash === ZERO_HASH) return;
      let loan: Loan;
      try {
        loan = loanFromJson(row.loan);
      } catch {
        unread++;
        return;
      }
      if (loanHash(loan).toLowerCase() !== chainHash) { unread++; return; }
      const mine = toMyLoan(Number(row.loanId), loan, address, now);
      if (mine) out.push(mine);
    });
    // Most urgent first: overdue, then soonest due.
    out.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'overdue' ? -1 : 1;
      return Number(a.deadline - b.deadline);
    });
    return { loans: out, unreadRecords: unread };
    // statusTick re-evaluates `now` (and therefore overdue) on the minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusTick is the intentional time dep
  }, [openRows, hashes.data, address, statusTick]);

  const hashesPending = openRows.length > 0 && !hashes.data;
  const allHashesFailed = openRows.length > 0 && !!hashes.data && hashes.data.every((r) => r.status !== 'success');
  const isError = book.isError || (openRows.length > 0 && hashes.isError) || allHashesFailed;

  // `null`, never 0, when the book itself did not answer: the wallet's loans were never
  // listed, so the size of the gap is unread too.
  const unreadCount = book.isError ? null : unreadRecords;

  return {
    loans,
    isLoading: book.isLoading || (hashesPending && !hashes.isError),
    isError,
    /**
     * The list is real but NOT known to be complete: a loan record did not answer, or the
     * book did not. Every consumer that states or implies "this is all of them" (totals,
     * counts, the empty state) must branch on this, never on `loans.length`.
     */
    loansUnread: unreadCount === null || unreadCount > 0,
    /** How many open loan records did not check out on chain. Null when the book did not answer. */
    unreadCount,
    deployed,
  };
}
