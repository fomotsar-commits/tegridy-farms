// Typed client for the referral-code store at `/api/aggregator?resource=referrals`.
//
// ZERO NEW SERVERLESS FUNCTIONS: a `?resource=` branch on the aggregator
// catchall behind a lazy import, per api/SERVERLESS_BUDGET.md.
//
// ─── WHAT THIS STORE IS AND IS NOT ───────────────────────────────────────────
//
// It maps a short code to an address. That is all it does. It is NOT the
// referral ledger: it holds no earnings, no referee counts, and no balances —
// those come from ReferralSplitter, on-chain, via hooks/useReferralStanding.ts.
// A code store that also reported earnings would be a second, unreconciled
// account of money, and a surface with two numbers shows the fast one.
//
// ─── THE ROSTER THAT IS NOT HERE, AND WHY ────────────────────────────────────
//
// An earlier draft of this file exported `readRoster()` — an opt-in list of
// referrer addresses for a referral LEADERBOARD to rank — and pointed at a
// `hooks/useReferralLeaderboard.ts`. Both are gone, and the hook was never
// written, because the leaderboard cannot be built honestly on this deployment:
//
//   · Ranking referrers needs every referrer's earnings, which means the
//     splitter's `FeeRecorded` / `ReferrerSet` history. The Ponder indexer does
//     not subscribe to ReferralSplitter at all — no entry in
//     indexer/ponder.config.ts, no table in indexer/ponder.schema.ts, no entity
//     in the generated schema. There is nothing to query.
//   · lib/referrals/splitterAbi.ts carries view functions only and no event
//     fragments, so the history cannot be reconstructed with getLogs either.
//   · Ranking only the wallets that opted into a database row is a directory of
//     volunteers. Printing a crown on top of it tells a reader that #1 is the
//     top referrer, which is unknowable — the honesty failure this codebase
//     keeps catching, wearing a leaderboard's clothes.
//
// If the indexer ever subscribes to the splitter, the ranking comes from THERE,
// on-chain, for every referrer — not from an opt-in flag in this table. Until
// then the absent capability is the honest answer, the same way api/_lib/
// airdrop.js has no endpoint that returns a recipient list.
//
// ─── DEGRADATION CONTRACT ────────────────────────────────────────────────────
//
// Same shape as lib/alerts/rulesClient.ts, for the same reason: an empty
// roster and an unreachable store both render as "nobody here". So every
// non-ready state carries its own status and its own explanation, and the
// payload is empty in all of them. `schema-missing` stays separate from
// `not-configured` because one is an env var and the other is a migration.
//
// A `resolve` that returns no address is the one case with two honest answers,
// and they are different statuses: `ready` with `address: null` means the store
// answered and the code genuinely does not exist; anything else means we could
// not ask, and the visitor must not be told their link was fake.

import { isAddress } from 'viem';
import { REF_CODE_RE } from './attribution';

export const REFERRALS_ENDPOINT = '/api/aggregator?resource=referrals';

export type CodeStoreStatus =
  /** The store answered. The payload is the answer, including a null address. */
  | 'ready'
  /** No SIWE session. Minting is per-wallet; nothing could be written. */
  | 'signed-out'
  /** The deployment has no Supabase configuration for the store. */
  | 'not-configured'
  /** Configured, but `referral_codes` does not exist yet. */
  | 'schema-missing'
  /** Asked, no usable answer: network, timeout, 5xx, or unparseable body. */
  | 'unreachable'
  /** The store refused this request and said why (taken code, bad shape, cap). */
  | 'rejected';

export interface CodeResolution {
  status: CodeStoreStatus;
  /** Non-null only when `status === 'ready'` AND the code exists. */
  address: string | null;
  /** Null only on a `ready` hit. Rendered verbatim otherwise. */
  detail: string | null;
  operatorStep: string | null;
}

export interface CodeOwnership {
  status: CodeStoreStatus;
  /** The caller's own code, or null on a `ready` read with none minted. */
  code: string | null;
  detail: string | null;
  operatorStep: string | null;
}

const TIMEOUT_MS = 8000;

interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

interface RawEnvelope {
  status: number;
  body: Record<string, unknown> | null;
}

async function call(
  init: RequestInit,
  query: string,
  opts: RequestOptions,
): Promise<RawEnvelope | 'unreachable'> {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = (opts.endpoint ?? REFERRALS_ENDPOINT) + query;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const res = await doFetch(endpoint, { ...init, credentials: 'include', signal: ac.signal });
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function str(body: Record<string, unknown> | null, key: string): string | null {
  const v = body?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Map an HTTP status + server `code` onto our status vocabulary. */
function classify(env: RawEnvelope): Exclude<CodeStoreStatus, 'ready'> {
  const code = str(env.body, 'code');
  if (code === 'schema-missing') return 'schema-missing';
  if (code === 'not-configured') return 'not-configured';
  if (env.status === 401) return 'signed-out';
  if (env.status >= 400 && env.status < 500) return 'rejected';
  return 'unreachable';
}

const UNREACHABLE_DETAIL =
  'The referral-code store did not answer. Nothing here is a statement about which codes exist.';

/** Resolve a short code to the address it belongs to. */
export async function resolveCode(code: string, opts: RequestOptions = {}): Promise<CodeResolution> {
  const normalised = code.trim().toLowerCase();
  if (!REF_CODE_RE.test(normalised)) {
    return {
      status: 'rejected',
      address: null,
      detail: 'That referral code is not a valid shape, so it was not looked up.',
      operatorStep: null,
    };
  }
  const env = await call({ method: 'GET' }, `&action=resolve&code=${encodeURIComponent(normalised)}`, opts);
  if (env === 'unreachable') {
    return { status: 'unreachable', address: null, detail: UNREACHABLE_DETAIL, operatorStep: null };
  }
  if (env.status === 200) {
    const addr = str(env.body, 'address');
    if (addr === null) {
      // A 200 with no address is the store telling us the code does not exist.
      // That is an ANSWER, and it is the only branch allowed to say so.
      return {
        status: 'ready',
        address: null,
        detail: 'No referrer is registered under that code.',
        operatorStep: null,
      };
    }
    if (!isAddress(addr)) {
      return {
        status: 'unreachable',
        address: null,
        detail: 'The referral-code store returned something that is not an address, so it was discarded.',
        operatorStep: null,
      };
    }
    return { status: 'ready', address: addr, detail: null, operatorStep: null };
  }
  return {
    status: classify(env),
    address: null,
    detail: str(env.body, 'error') ?? UNREACHABLE_DETAIL,
    operatorStep: str(env.body, 'operatorStep'),
  };
}

/** Read the signed-in wallet's own code, if it has minted one. */
export async function readOwnCode(opts: RequestOptions = {}): Promise<CodeOwnership> {
  const env = await call({ method: 'GET' }, '&action=mine', opts);
  if (env === 'unreachable') {
    return { status: 'unreachable', code: null, detail: UNREACHABLE_DETAIL, operatorStep: null };
  }
  if (env.status === 200) {
    const code = str(env.body, 'code');
    return {
      status: 'ready',
      code: code !== null && REF_CODE_RE.test(code) ? code : null,
      detail: null,
      operatorStep: null,
    };
  }
  return {
    status: classify(env),
    code: null,
    detail: str(env.body, 'error') ?? UNREACHABLE_DETAIL,
    operatorStep: str(env.body, 'operatorStep'),
  };
}

/**
 * Mint (or re-read) the signed-in wallet's code.
 *
 * The returned `code` is whatever the STORE holds, which is not necessarily what
 * was asked for — a wallet holds one code, so a second mint updates the row. The
 * caller is about to paste it into a link, so it renders the answer, never the
 * request.
 */
export async function claimCode(
  args: { code: string },
  opts: RequestOptions = {},
): Promise<CodeOwnership> {
  const normalised = args.code.trim().toLowerCase();
  if (!REF_CODE_RE.test(normalised)) {
    return {
      status: 'rejected',
      code: null,
      detail: 'A code must be 4–12 characters, lowercase letters and digits only.',
      operatorStep: null,
    };
  }
  const env = await call(
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'claim', code: normalised }),
    },
    '',
    opts,
  );
  if (env === 'unreachable') {
    return { status: 'unreachable', code: null, detail: UNREACHABLE_DETAIL, operatorStep: null };
  }
  if (env.status === 200 || env.status === 201) {
    const code = str(env.body, 'code');
    return {
      status: 'ready',
      code: code !== null && REF_CODE_RE.test(code) ? code : null,
      detail: null,
      operatorStep: null,
    };
  }
  return {
    status: classify(env),
    code: null,
    detail: str(env.body, 'error') ?? UNREACHABLE_DETAIL,
    operatorStep: str(env.body, 'operatorStep'),
  };
}
