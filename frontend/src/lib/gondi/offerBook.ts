// The site's client for the NFT loan offer book (api/orderbook.js, loan actions;
// api/_lib/loanOffers.js). The book only stores and serves signed offers and loan
// records; every screen re-checks what it shows against the loan contract.
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import type { LoanOfferJson } from './loanOffer.js';
import type { LoanJson } from './loanMath';

const API = '/api/orderbook';

export interface BookOffer {
  offer: LoanOfferJson;
  signature: Hex;
  createdAt: string;
}

export interface BookLoan {
  loanId: string;
  loan: LoanJson;
  status: 'open' | 'repaid' | 'liquidated' | 'refinanced';
  emitTx: Hex;
  closeTx: Hex | null;
}

async function readJson<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok || !body) throw new Error(body?.error || `The offer book answered ${r.status}`);
  return body;
}

export async function fetchOffers(params: { collection?: Address; lender?: Address }) {
  const q = new URLSearchParams({ action: 'loan-offers' });
  if (params.collection) q.set('collection', params.collection);
  if (params.lender) q.set('lender', params.lender);
  return readJson<{ offers: BookOffer[]; count: number; live: boolean }>(await fetch(`${API}?${q}`));
}

export async function fetchLoans(wallet: Address) {
  const q = new URLSearchParams({ action: 'loans', wallet });
  return readJson<{ loans: BookLoan[]; live: boolean }>(await fetch(`${API}?${q}`));
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  return readJson<T>(
    await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

export const postOffer = (offer: LoanOfferJson, signature: Hex) =>
  post<{ ok: true; offer: LoanOfferJson }>({ action: 'loan-offer-create', offer, signature });

export const syncOffer = (lender: Address, offerId: string) =>
  post<{ status: 'active' | 'closed' }>({ action: 'loan-offer-sync', lender, offerId });

export const recordLoanTx = (txHash: Hex) =>
  post<{ loans: { loanId: string; status: string }[] }>({ action: 'loan-record', txHash });

export const syncLoan = (loanId: string) =>
  post<{ status: BookLoan['status']; loans: { loanId: string; status: string }[] }>({ action: 'loan-sync', loanId });

export function useBookOffers(params: { collection?: Address; lender?: Address; enabled?: boolean }) {
  return useQuery({
    queryKey: ['gondi-offers', params.collection ?? 'all', params.lender ?? 'any'],
    queryFn: () => fetchOffers(params),
    enabled: params.enabled ?? true,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useBookLoans(wallet: Address | undefined) {
  return useQuery({
    queryKey: ['gondi-loans', wallet ?? 'none'],
    queryFn: () => fetchLoans(wallet!),
    enabled: !!wallet,
    staleTime: 15_000,
  });
}

const ZERO_HASH = `0x${'0'.repeat(64)}`;

/**
 * A loan the book holds open whose hash reads zero on chain closed where the site did not see
 * it: repaid elsewhere, claimed, or taken over by another lender (Gondi's refinanceFull needs
 * no borrower). Asks the book once per loan to find out how (loan-sync), then refreshes, so a
 * taken-over loan shows as its new loan, with its new deadline. `hashReads[i]` is
 * getLoanHash for `openRows[i]`.
 */
export function useSyncClosedLoans(
  openRows: readonly { loanId: string }[],
  hashReads: readonly { status: string; result?: unknown }[] | undefined,
) {
  const refresh = useRefreshBook();
  const asked = useRef(new Set<string>());
  useEffect(() => {
    openRows.forEach((row, i) => {
      const read = hashReads?.[i];
      if (read?.status !== 'success' || String(read.result).toLowerCase() !== ZERO_HASH) return;
      if (asked.current.has(row.loanId)) return;
      asked.current.add(row.loanId);
      void syncLoan(row.loanId).catch(() => undefined).finally(refresh);
    });
  }, [openRows, hashReads, refresh]);
}

export function useRefreshBook() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['gondi-offers'] });
    void qc.invalidateQueries({ queryKey: ['gondi-loans'] });
  };
}
