// The NFT loan offer book, for e2e: the REAL handler (api/_lib/loanOffers.js) served to the
// page through page.route, reading the Anvil fork for every chain check, with an
// in-memory table in place of Supabase. So a spec exercises the book's own rules — the
// signature checked as Gondi checks it, the lender's WETH read from the fork, loans
// recorded from the fork's own receipts — and only the storage is stand-in.
import type { Page } from '@playwright/test';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { handleLoanAction, makeChain } from '../../api/_lib/loanOffers.js';
import { GONDI_LOAN_ADDRESS, type LoanOfferJson } from '../../src/lib/gondi/loanOffer.js';

type Row = Record<string, unknown>;

/** Enough of supabase-js's query builder for loanOffers.js, over two arrays. */
function memoryTables() {
  const tables: Record<string, Row[]> = { nft_loan_offers: [], nft_loans: [] };
  const from = (table: string) => {
    let op: 'select' | 'update' = 'select';
    let patch: Row = {};
    let max: number | null = null;
    const filters: ((r: Row) => boolean)[] = [];
    const key = (r: Row) => (table === 'nft_loan_offers' ? `${r.lender}:${r.offer_id}` : String(r.loan_id));
    const b = {
      select: () => b,
      insert: (row: Row) => {
        if (tables[table]!.some((r) => key(r) === key(row))) return Promise.resolve({ error: { code: '23505', message: 'duplicate' } });
        tables[table]!.push({ status: table === 'nft_loans' ? 'open' : 'active', created_at: new Date().toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
      upsert: (row: Row) => {
        if (!tables[table]!.some((r) => key(r) === key(row))) tables[table]!.push({ status: 'open', created_at: new Date().toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
      update: (p: Row) => {
        op = 'update';
        patch = p;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filters.push((r) => String(r[c]) === String(v));
        return b;
      },
      gt: (c: string, v: unknown) => {
        filters.push((r) => String(r[c]) > String(v));
        return b;
      },
      or: (expr: string) => {
        const ors = expr.split(',').map((p) => p.split('.eq.'));
        filters.push((r) => ors.some(([c, v]) => r[c!] === v));
        return b;
      },
      order: () => b,
      limit: (n: number) => {
        max = n;
        return b;
      },
      then: (resolve: (v: unknown) => void) => {
        const hit = tables[table]!.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') {
          for (const r of hit) Object.assign(r, patch);
          return resolve({ error: null });
        }
        return resolve({ data: max ? hit.slice(0, max) : hit, error: null });
      },
    };
    return b;
  };
  return { tables, from };
}

export async function installLoanBook(page: Page, rpcUrl: string) {
  const db = memoryTables();
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const deps = { supabase: db, chain: makeChain(() => client), loanAddress: GONDI_LOAN_ADDRESS };

  const call = async (method: string, query: Record<string, string>, body: Record<string, unknown>) => {
    let status = 0;
    let json: unknown = null;
    const res = {
      status(c: number) {
        status = c;
        return res;
      },
      json(b: unknown) {
        json = b;
        return res;
      },
    };
    const handled = await handleLoanAction({ method, query, body }, res, deps);
    return { handled, status, json };
  };

  await page.route('**/api/orderbook**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.method() === 'POST' ? (JSON.parse(req.postData() || '{}') as Record<string, unknown>) : {};
    const out = await call(req.method(), Object.fromEntries(url.searchParams), body);
    if (!out.handled) return route.fallback();
    await route.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify(out.json) });
  });

  return {
    tables: db.tables,
    /** Post a signed offer through the book's own create action. */
    create: (offer: LoanOfferJson, signature: string) => call('POST', {}, { action: 'loan-offer-create', offer, signature }),
  };
}
