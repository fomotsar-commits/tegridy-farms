import { useMemo } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { TEGRIDY_LENDING_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_LENDING_ABI } from '../lib/contracts';

export interface MyLoan {
  id: number;
  borrower: string;
  lender: string;
  offerId: bigint;
  tokenId: bigint;
  principal: bigint;
  aprBps: bigint;
  startTime: bigint;
  deadline: bigint;
  repaid: boolean;
  defaultClaimed: boolean;
  /** 'active' = within deadline, 'overdue' = past deadline but not yet defaulted */
  status: 'active' | 'overdue' | 'repaid' | 'defaulted';
}

/**
 * Returns the connected wallet's outstanding (active + overdue) loans from TegridyLending.
 * Does not include repaid or defaulted loans — those are historical, not outstanding.
 */
export function useMyLoans() {
  const { address } = useAccount();
  const deployed = isDeployed(TEGRIDY_LENDING_ADDRESS);

  const { data: loanCountData } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'loanCount',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });

  const count = loanCountData ? Number(loanCountData) : 0;

  const contracts = useMemo(() => {
    if (!deployed || count === 0) return [];
    return Array.from({ length: count }, (_, i) => ({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'getLoan' as const,
      args: [BigInt(i)] as const,
    }));
  }, [count, deployed]);

  const { data: loanResults, isLoading } = useReadContracts({
    contracts,
    query: { enabled: deployed && count > 0 && !!address, refetchInterval: 30_000 },
  });

  const outstanding = useMemo<MyLoan[]>(() => {
    if (!loanResults || !address) return [];
    const now = BigInt(Math.floor(Date.now() / 1000));
    const lower = address.toLowerCase();
    const result: MyLoan[] = [];
    for (let i = 0; i < loanResults.length; i++) {
      const r = loanResults[i];
      if (!r || r.status !== 'success' || !r.result) continue;
      const l = r.result as readonly [string, string, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean];
      if (l[0].toLowerCase() !== lower) continue;
      if (l[8] || l[9]) continue; // repaid or defaulted
      const status: MyLoan['status'] = now > l[7] ? 'overdue' : 'active';
      result.push({
        id: i,
        borrower: l[0],
        lender: l[1],
        offerId: l[2],
        tokenId: l[3],
        principal: l[4],
        aprBps: l[5],
        startTime: l[6],
        deadline: l[7],
        repaid: l[8],
        defaultClaimed: l[9],
        status,
      });
    }
    // Surface most-urgent (overdue first, then soonest deadline) at the top.
    result.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'overdue' ? -1 : 1;
      return Number(a.deadline - b.deadline);
    });
    return result;
  }, [loanResults, address]);

  return { loans: outstanding, isLoading, deployed };
}
