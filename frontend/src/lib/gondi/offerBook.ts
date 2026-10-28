// The site's client for the NFT loan offer book (api/orderbook.js, loan actions;
// api/_lib/loanOffers.js). The book only stores and serves signed offers and loan
// records; every screen re-checks what it shows against the loan contract.
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

export function useRefreshBook() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['gondi-offers'] });
    void qc.invalidateQueries({ queryKey: ['gondi-loans'] });
  };
}
