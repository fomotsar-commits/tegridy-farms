// Browser boundary for the invoice store at `/api/aggregator?resource=commerce`.
//
// FAIL-CLOSED, with the same distinction referrals.ts draws and for a sharper
// reason. Three answers must never collapse into each other:
//
//   "this invoice does not exist"   — the store looked. A 200.
//   "the store could not be asked"  — outage, misconfiguration, missing table.
//   "this invoice is not payable"   — it exists and invoice.ts refused it.
//
// The middle one rendered as the first is the damaging case: a buyer following a
// real payment link would be told the merchant's invoice is not real, and the
// merchant would be told nobody tried to pay. Every non-200 below therefore
// throws with a reason instead of returning null.
//
// NOTHING HERE HOLDS OR MOVES MONEY. The store maps an id to a set of numbers a
// merchant published. Every transfer is signed in the buyer's own wallet against
// the plan built in settlement.ts, and this file is not on that path.

import { invoiceFromWire, type Invoice } from './invoice';

export type CommerceStoreReason =
  /** Reached, and it answered that it has no such row. Not an error. */
  | 'not-found'
  /** The deployment has no store configured at all. */
  | 'not-configured'
  /** The table has not been created — a missing migration, not an answer. */
  | 'schema-missing'
  /** Asked, no usable answer. */
  | 'unreachable'
  /** Answered with something off-shape. */
  | 'malformed'
  /** Answered, and refused. */
  | 'rejected';

export class CommerceStoreError extends Error {
  readonly reason: CommerceStoreReason;
  /** The operator's next step, when the server named one. */
  readonly operatorStep: string | null;

  constructor(reason: CommerceStoreReason, message: string, operatorStep: string | null = null) {
    super(message);
    this.name = 'CommerceStoreError';
    this.reason = reason;
    this.operatorStep = operatorStep;
  }
}

const ENDPOINT = '/api/aggregator?resource=commerce';

/** Hard ceiling per request — matched to the indexer client's, same rationale. */
export const COMMERCE_TIMEOUT_MS = 8000;

async function call(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), COMMERCE_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetchImpl(path, { ...init, signal: ac.signal, credentials: 'same-origin' });
  } catch {
    throw new CommerceStoreError(
      'unreachable',
      'The invoice store did not answer. Nothing here is a statement about this invoice.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    if (res.ok) throw new CommerceStoreError('malformed', 'The invoice store returned something unreadable.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const serverCode = typeof b.code === 'string' ? b.code : null;
  const operatorStep = typeof b.operatorStep === 'string' ? b.operatorStep : null;
  const error =
    typeof b.error === 'string' ? b.error : 'The invoice store could not answer.';

  if (res.status === 404 && serverCode === 'not-found') {
    // The ONE branch that is an answer rather than a failure.
    throw new CommerceStoreError('not-found', error);
  }
  if (serverCode === 'schema-missing') {
    throw new CommerceStoreError('schema-missing', error, operatorStep);
  }
  if (serverCode === 'not-configured') {
    throw new CommerceStoreError('not-configured', error, operatorStep);
  }
  if (res.status >= 500) {
    throw new CommerceStoreError('unreachable', error, operatorStep);
  }
  if (!res.ok) {
    throw new CommerceStoreError('rejected', error, operatorStep);
  }
  return body;
}

/**
 * Fetch one invoice by id.
 *
 * Throws on every failure. A caller that wants "null means missing" has to opt
 * into it by catching `reason === 'not-found'`, which forces the two cases apart
 * at the call site rather than letting one impersonate the other.
 */
export async function fetchInvoice(
  id: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Invoice> {
  const body = await call(
    `${ENDPOINT}&action=invoice&id=${encodeURIComponent(id)}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    opts.fetchImpl ?? fetch,
    opts.signal,
  );
  const invoice = invoiceFromWire((body as Record<string, unknown>)?.invoice);
  if (invoice === null) {
    throw new CommerceStoreError(
      'malformed',
      'The invoice store returned a row this build cannot read, so none of it is shown.',
    );
  }
  return invoice;
}

export interface WebhookOutcome {
  attempted: boolean;
  delivered: boolean;
  /** Always set. Says why it was not attempted, or how the attempt went. */
  detail: string;
  /** Always 'none' on this deployment; see api/_lib/commerce.js. */
  retries: string;
}

function readWebhook(value: unknown): WebhookOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.detail !== 'string') return null;
  return {
    attempted: v.attempted === true,
    delivered: v.delivered === true,
    detail: v.detail,
    retries: typeof v.retries === 'string' ? v.retries : 'none',
  };
}

/**
 * Publish an invoice. Requires the merchant's own SIWE session.
 *
 * The merchant address is NOT sent: the server takes it from the authenticated
 * wallet claim. A caller-supplied payee would let anyone publish an invoice
 * naming somebody else, which burns the id for its real owner and puts a
 * stranger's address behind this venue's checkout.
 *
 * Returns whatever the DATABASE stored, re-parsed, rather than echoing back what
 * was asked for — the merchant is about to paste this into a link and a buyer is
 * going to sign against it.
 */
export async function publishInvoice(
  args: {
    id: string;
    chainId: number;
    settleToken: string;
    settleSymbol: string;
    settleDecimals: number;
    /** Decimal string of smallest units. Never a JS number. */
    settleAmount: string;
    memo: string;
    expiresAt: number;
    webhookUrl?: string;
  },
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Invoice> {
  const body = await call(
    `${ENDPOINT}&action=create`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
    },
    opts.fetchImpl ?? fetch,
    opts.signal,
  );
  const invoice = invoiceFromWire((body as Record<string, unknown>)?.invoice);
  if (invoice === null) {
    throw new CommerceStoreError(
      'malformed',
      'The store did not return the invoice it stored, so what was published cannot be shown.',
    );
  }
  return invoice;
}

export interface SettlementClaim {
  invoiceId: string;
  txHash: string;
  payer: string;
  /** Always `client-reported` on this deployment; see api/_lib/commerce.js. */
  verification: string;
  recordedAt: number;
}

/**
 * Read the claims made against ONE of the caller's own invoices.
 *
 * A 200 with an empty list is an ANSWER — RLS looked and nobody has claimed to
 * have paid. Every failure throws, which is what lets a merchant tell "nobody
 * paid" from "we could not ask" before they decide whether to ship anything.
 */
export async function fetchSettlements(
  invoiceId: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ settlements: SettlementClaim[]; notice: string }> {
  const body = (await call(
    `${ENDPOINT}&action=settlements&id=${encodeURIComponent(invoiceId)}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    opts.fetchImpl ?? fetch,
    opts.signal,
  )) as Record<string, unknown>;

  const rows = Array.isArray(body.settlements) ? body.settlements : null;
  if (rows === null) {
    throw new CommerceStoreError('malformed', 'The settlement record returned an unrecognised shape.');
  }
  return {
    settlements: rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        invoiceId: String(row.invoice_id ?? ''),
        txHash: String(row.tx_hash ?? ''),
        payer: String(row.payer ?? ''),
        // Echoed, never defaulted to something friendlier. A merchant decides
        // whether to release goods on this word.
        verification: String(row.verification ?? 'client-reported'),
        recordedAt: Number(row.recorded_at ?? 0),
      };
    }),
    notice:
      typeof body.notice === 'string'
        ? body.notice
        : 'These rows are claims a browser made. Nothing here read a receipt.',
  };
}

/** Record a claimed settlement. The server decides what it is willing to call it. */
export async function recordSettlement(
  args: { invoiceId: string; txHash: string; payer: string; webhookUrl?: string },
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ verification: string; webhook: WebhookOutcome | null }> {
  const body = (await call(
    `${ENDPOINT}&action=settle`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
    },
    opts.fetchImpl ?? fetch,
    opts.signal,
  )) as Record<string, unknown>;

  return {
    // Echoed from the server, never assumed. The client cannot know whether a
    // receipt was read, and guessing "confirmed" here is what a merchant would
    // release goods against.
    verification: typeof body.verification === 'string' ? body.verification : 'client-reported',
    webhook: readWebhook(body.webhook),
  };
}
