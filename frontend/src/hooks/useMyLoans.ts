import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContract, usePublicClient, useChainId } from 'wagmi';
import { type Address } from 'viem';
import { TEGRIDY_LENDING_ADDRESS, TEGRIDY_NFT_LENDING_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import { TEGRIDY_LENDING_ABI, TEGRIDY_NFT_LENDING_ABI } from '../lib/contracts';

// R044: chunk large loan-id sweeps into batches of 50 so a 5000-loan
// system doesn't fire one giant multicall. 60s refetch (F130) — loan state
// (repaid / defaulted / overdue) doesn't move per-block but must not freeze
// for the whole session either.
const LOAN_CHUNK_SIZE = 50;
const REFETCH_MS = 60_000;
// F130: re-evaluate overdue status on a 60s minute-tick so a loan crossing its
// deadline while the dashboard is open flips to "overdue" without a reload.
const STATUS_TICK_MS = 60_000;

/** Which lending contract the loan came from — drives routing + UI labels. */
export type LoanSource = 'token' | 'nft';
/** User's side of the loan. Drives how we frame numbers (owed vs earning). */
export type LoanRole = 'borrower' | 'lender';

export interface MyLoan {
  id: number;
  source: LoanSource;
  role: LoanRole;
  borrower: string;
  lender: string;
  offerId: bigint;
  tokenId: bigint;
  /** Only set for NFT-lending loans; token-lending uses the shared staking NFT. */
  collateralContract?: string;
  principal: bigint;
  aprBps: bigint;
  startTime: bigint;
  deadline: bigint;
  repaid: boolean;
  defaultClaimed: boolean;
  status: 'active' | 'overdue' | 'repaid' | 'defaulted';
}

/**
 * Returns the connected wallet's outstanding loans across BOTH TegridyLending
 * (token-backed) and TegridyNFTLending (NFT-backed), as either borrower or
 * lender. Repaid / defaulted loans are filtered out — this is a
 * "what's open on my books" view, not a history log.
 */
type ReadResult = { status: 'success'; result: unknown } | { status: 'failure' };

export function useMyLoans() {
  const { address } = useAccount();
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const tokenDeployed = isDeployed(TEGRIDY_LENDING_ADDRESS);
  const nftDeployed = isDeployed(TEGRIDY_NFT_LENDING_ADDRESS);

  const { data: tokenLoanCount, isError: tokenCountError } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'loanCount',
    chainId: CHAIN_ID,
    query: { enabled: tokenDeployed && onMainnet, refetchInterval: REFETCH_MS },
  });

  const { data: nftLoanCount, isError: nftCountError } = useReadContract({
    address: TEGRIDY_NFT_LENDING_ADDRESS as Address,
    abi: TEGRIDY_NFT_LENDING_ABI,
    functionName: 'loanCount',
    chainId: CHAIN_ID,
    query: { enabled: nftDeployed && onMainnet, refetchInterval: REFETCH_MS },
  });

  const tokenCount = tokenLoanCount ? Number(tokenLoanCount) : 0;
  const nftCount = nftLoanCount ? Number(nftLoanCount) : 0;

  const [tokenResults, setTokenResults] = useState<ReadResult[]>([]);
  const [nftResults, setNftResults] = useState<ReadResult[]>([]);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [nftLoading, setNftLoading] = useState(false);
  // F130: a real refresh tick (the old `setTokenLoading((p) => p)` interval was a
  // no-op identity setState that React bailed out of, so loans never re-scanned).
  const [refreshNonce, setRefreshNonce] = useState(0);
  // F130: per-minute tick consumed by the `outstanding` memo so overdue status
  // recomputes live against a fresh `now` even between full re-scans.
  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setRefreshNonce((n) => n + 1);
      setStatusTick((n) => n + 1);
    }, STATUS_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // R044: chunk loan IDs into batches of 50 via Promise.all. Avoids one
  // giant multicall for high-id contracts and lets a single bad loan in
  // one chunk fail without poisoning the whole batch.
  useEffect(() => {
    if (!publicClient || !onMainnet || !tokenDeployed || tokenCount === 0 || !address) {
      setTokenResults([]);
      setTokenLoading(false);
      return;
    }
    let cancelled = false;
    setTokenLoading(true);
    (async () => {
      const ids = Array.from({ length: tokenCount }, (_, i) => i);
      const chunks: number[][] = [];
      for (let i = 0; i < ids.length; i += LOAN_CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + LOAN_CHUNK_SIZE));
      }
      const all: ReadResult[] = [];
      for (const chunk of chunks) {
        const settled = await Promise.all(
          chunk.map((id) =>
            publicClient
              .readContract({
                address: TEGRIDY_LENDING_ADDRESS as Address,
                abi: TEGRIDY_LENDING_ABI,
                functionName: 'getLoan',
                args: [BigInt(id)],
              })
              .then<ReadResult>((result) => ({ status: 'success', result }))
              .catch<ReadResult>(() => ({ status: 'failure' })),
          ),
        );
        if (cancelled) return;
        all.push(...settled);
      }
      if (!cancelled) {
        setTokenResults(all);
        setTokenLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // F130: refreshNonce in deps re-runs the scan every REFETCH_MS via the shared tick.
  }, [publicClient, onMainnet, tokenDeployed, tokenCount, address, refreshNonce]);

  useEffect(() => {
    if (!publicClient || !onMainnet || !nftDeployed || nftCount === 0 || !address) {
      setNftResults([]);
      setNftLoading(false);
      return;
    }
    let cancelled = false;
    setNftLoading(true);
    (async () => {
      const ids = Array.from({ length: nftCount }, (_, i) => i);
      const chunks: number[][] = [];
      for (let i = 0; i < ids.length; i += LOAN_CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + LOAN_CHUNK_SIZE));
      }
      const all: ReadResult[] = [];
      for (const chunk of chunks) {
        const settled = await Promise.all(
          chunk.map((id) =>
            publicClient
              .readContract({
                address: TEGRIDY_NFT_LENDING_ADDRESS as Address,
                abi: TEGRIDY_NFT_LENDING_ABI,
                functionName: 'getLoan',
                args: [BigInt(id)],
              })
              .then<ReadResult>((result) => ({ status: 'success', result }))
              .catch<ReadResult>(() => ({ status: 'failure' })),
          ),
        );
        if (cancelled) return;
        all.push(...settled);
      }
      if (!cancelled) {
        setNftResults(all);
        setNftLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // F130: refreshNonce in deps gives the NFT scan its own 60s refresh (it had none).
  }, [publicClient, onMainnet, nftDeployed, nftCount, address, refreshNonce]);

  const outstanding = useMemo<MyLoan[]>(() => {
    if (!address) return [];
    const now = BigInt(Math.floor(Date.now() / 1000));
    const lower = address.toLowerCase();
    const result: MyLoan[] = [];

    // TegridyLending tuple: (borrower, lender, offerId, tokenId, principal, aprBps, startTime, deadline, repaid, defaultClaimed)
    if (tokenResults) {
      for (let i = 0; i < tokenResults.length; i++) {
        const r = tokenResults[i];
        if (!r || r.status !== 'success' || !r.result) continue;
        const l = r.result as readonly [
          string, string, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean,
        ];
        if (l[8] || l[9]) continue;
        const isBorrower = l[0].toLowerCase() === lower;
        const isLender = l[1].toLowerCase() === lower;
        if (!isBorrower && !isLender) continue;
        const status: MyLoan['status'] = now > l[7] ? 'overdue' : 'active';
        result.push({
          id: i,
          source: 'token',
          role: isBorrower ? 'borrower' : 'lender',
          borrower: l[0], lender: l[1], offerId: l[2], tokenId: l[3],
          principal: l[4], aprBps: l[5], startTime: l[6], deadline: l[7],
          repaid: l[8], defaultClaimed: l[9], status,
        });
      }
    }

    // TegridyNFTLending tuple: same as above + `collateralContract` between `tokenId` and `principal`.
    if (nftResults) {
      for (let i = 0; i < nftResults.length; i++) {
        const r = nftResults[i];
        if (!r || r.status !== 'success' || !r.result) continue;
        const l = r.result as readonly [
          string, string, bigint, bigint, string, bigint, bigint, bigint, bigint, boolean, boolean,
        ];
        if (l[9] || l[10]) continue;
        const isBorrower = l[0].toLowerCase() === lower;
        const isLender = l[1].toLowerCase() === lower;
        if (!isBorrower && !isLender) continue;
        const status: MyLoan['status'] = now > l[8] ? 'overdue' : 'active';
        result.push({
          id: i,
          source: 'nft',
          role: isBorrower ? 'borrower' : 'lender',
          borrower: l[0], lender: l[1], offerId: l[2], tokenId: l[3],
          collateralContract: l[4],
          principal: l[5], aprBps: l[6], startTime: l[7], deadline: l[8],
          repaid: l[9], defaultClaimed: l[10], status,
        });
      }
    }

    // Surface the most urgent first: overdue, then soonest deadline.
    result.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'overdue' ? -1 : 1;
      return Number(a.deadline - b.deadline);
    });
    return result;
    // F130: statusTick re-evaluates `now` (and therefore overdue) on the minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusTick is the intentional time dep
  }, [tokenResults, nftResults, address, statusTick]);

  // Distinguish "no loans" from "couldn't read": the count read failing, or every
  // per-loan detail read failing (RPC down), previously rendered as an empty list
  // that looked like the user had no loans. Surface it so the UI can say so.
  const tokenReadFailed = tokenCountError || (tokenResults.length > 0 && tokenResults.every((r) => r.status === 'failure'));
  const nftReadFailed = nftCountError || (nftResults.length > 0 && nftResults.every((r) => r.status === 'failure'));

  // OUTAGE-AS-COMPLETE. The two flags above fire only when NOTHING came back, so
  // a chunk sweep that lost SOME ids returned a shorter list under the same
  // "these are your loans" heading: the dashboard counted it, summed the
  // principal and badged the overdue ones off a set it had no reason to believe
  // was whole, and the shield watched a book with holes in it. A partial read is
  // still unread - carry how many records did not answer, and let every claim of
  // completeness gate on that rather than on the length of the list.
  //
  // `null`, never 0, when a loanCount read failed: those ids were never
  // enumerated, so the size of the gap is itself unread, and "0 could not be
  // read" is exactly the false zero this exists to refuse.
  const loanCountUnread = Boolean(tokenCountError || nftCountError);
  const unreadCount = loanCountUnread
    ? null
    : tokenResults.filter((r) => r.status === 'failure').length
      + nftResults.filter((r) => r.status === 'failure').length;
  const loansUnread = unreadCount === null || unreadCount > 0;

  return {
    loans: outstanding,
    isLoading: tokenLoading || nftLoading,
    isError: Boolean(tokenReadFailed || nftReadFailed),
    /**
     * The list is real but NOT known to be complete: at least one loan record
     * did not answer, or a `loanCount` read failed so a contract was never
     * enumerated. Strictly weaker than `isError`, which means nothing was read.
     * Every consumer that states or implies "this is all of them" - totals,
     * counts, the empty state, the shield's watch list - must branch on this,
     * never on `loans.length`.
     */
    loansUnread,
    /**
     * How many loan records were asked for and did not answer. Null when a
     * `loanCount` read failed, because the size of the gap is unread too and
     * must render as unknown rather than as a number. A 0 means a whole sweep.
     */
    unreadCount,
    deployed: tokenDeployed || nftDeployed,
  };
}
