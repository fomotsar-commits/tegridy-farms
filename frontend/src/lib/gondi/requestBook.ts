// The site's client for the NFT loan request book (api/orderbook.js, request actions;
// api/_lib/loanRequests.js). The book only stores and serves signed requests; every screen
// re-checks who holds the NFT on chain before it shows one.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { ZERO_ADDRESS } from './loanOffer.js';
import type { LoanRequestJson } from './loanRequest.js';

const API = '/api/orderbook';

export interface BookRequest {
  request: LoanRequestJson;
  signature: Hex;
  createdAt: string;
}

async function readJson<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok || !body) throw new Error(body?.error || `The request book answered ${r.status}`);
  return body;
}

export async function fetchRequests(params: { collection?: Address; borrower?: Address }) {
  const q = new URLSearchParams({ action: 'loan-requests' });
  if (params.collection) q.set('collection', params.collection);
  if (params.borrower) q.set('borrower', params.borrower);
  const body = await readJson<{ requests?: BookRequest[]; open?: boolean }>(await fetch(`${API}?${q}`));
  // A book that answers without a list (an older deploy, a stand-in) holds no requests, and
  // one that does not say it is open takes none.
  return { requests: Array.isArray(body.requests) ? body.requests : [], open: body.open === true };
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  return readJson<T>(
    await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

export const postRequest = (request: LoanRequestJson, signature: Hex) =>
  post<{ ok: true; request: LoanRequestJson }>({ action: 'loan-request-create', request, signature });

export const cancelRequest = (borrower: Address, nonce: string, signature: Hex) =>
  post<{ status: 'closed' }>({ action: 'loan-request-cancel', borrower, nonce, signature });

export const syncRequest = (collection: Address, tokenId: string) =>
  post<{ status: 'active' | 'closed' | 'none' }>({ action: 'loan-request-sync', collection, tokenId });

export function useBookRequests(params: { collection?: Address; borrower?: Address; enabled?: boolean }) {
  return useQuery({
    queryKey: ['gondi-requests', params.collection ?? 'all', params.borrower ?? 'any'],
    queryFn: () => fetchRequests(params),
    enabled: params.enabled ?? true,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

/**
 * Whether the book takes requests: false until its table exists (migration 032). No request
 * has the zero address as its borrower (validateRequestShape refuses one), so this reads the
 * book's state and no rows.
 */
export function useRequestBookOpen(enabled: boolean) {
  const q = useQuery({
    queryKey: ['gondi-requests', 'open'],
    queryFn: () => fetchRequests({ borrower: ZERO_ADDRESS as Address }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  return q.data?.open === true;
}

export function useRefreshRequests() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['gondi-requests'] });
}
