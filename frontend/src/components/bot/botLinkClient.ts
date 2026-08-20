// Typed client for the Telegram link store at `/api/aggregator?resource=bot-link`.
//
// ZERO NEW SERVERLESS FUNCTIONS: the store is a `?resource=` branch on the
// aggregator catchall behind a lazy import, per api/SERVERLESS_BUDGET.md. The
// Vercel Hobby plan caps the deployment at 12 functions and the repo is at 11.
//
// DEGRADATION CONTRACT, the same one rulesClient.ts keeps and for a sharper
// reason: an empty link list and an unreachable link store both render as "no
// chats linked", and only one of them is true. A user who reads the second as the
// first concludes their Telegram binding was dropped and re-links — which is
// harmless — or, far worse, concludes an unwanted binding is gone when it is still
// live. So `links` is EMPTY IN EVERY NON-READY STATE and every non-ready state
// carries its own explanation.
//
// `schema-missing` is separated from `not-configured` because the fix differs: one
// is an environment variable, the other is a migration an operator applies by hand.
//
// WHAT THIS FILE NEVER SENDS: a key, a phrase, or anything derived from one. The
// only secret in this flow is the user's wallet signature, and that is spent on the
// SIWE cookie by api/auth/siwe.js before this client is ever called.

export const BOT_LINK_ENDPOINT = '/api/aggregator?resource=bot-link';

export type LinkStoreStatus =
  /** The store answered. `links` is the answer. */
  | 'ready'
  /** No SIWE session. Bindings are per-wallet, so there is nothing to read. */
  | 'signed-out'
  /** The deployment has no Supabase/JWT/bot configuration for the store. */
  | 'not-configured'
  /** Configured, but `telegram_links` does not exist yet. */
  | 'schema-missing'
  /** Asked, no usable answer. */
  | 'unreachable';

export interface TelegramLink {
  id: string;
  /** Unix seconds. Zero when the row carried no parseable timestamp. */
  linkedAt: number;
}

export interface LinkStoreResult {
  status: LinkStoreStatus;
  /** Non-empty only when `status === 'ready'`. */
  links: TelegramLink[];
  /** Null only when `status === 'ready'`. */
  detail: string | null;
  operatorStep: string | null;
}

/** Outcome of spending a link code. */
export type ClaimOutcome =
  | { status: 'linked' }
  /** The store answered and the code is expired, spent, or was never real. */
  | { status: 'code-not-open'; detail: string }
  /** Everything else, including "we could not ask". */
  | { status: 'failed'; detail: string; operatorStep: string | null };

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mirrors LINK_CODE_RE in api/_lib/botLink.js and the alphabet in bot/src. */
export const LINK_CODE_RE = /^[2-9A-HJ-NP-TV-Z]{10}$/;

function fail(
  status: Exclude<LinkStoreStatus, 'ready'>,
  detail: string,
  operatorStep: string | null = null,
): LinkStoreResult {
  return { status, links: [], detail, operatorStep };
}

/** Coerce one server row. Rejects rather than repairs. */
export function coerceLink(raw: unknown): TelegramLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && UUID_RE.test(r.id) ? r.id : null;
  if (!id) return null;
  let linkedAt = 0;
  const stamp = r.linked_at ?? r.linkedAt;
  if (typeof stamp === 'string') {
    const parsed = Date.parse(stamp);
    if (Number.isFinite(parsed)) linkedAt = Math.floor(parsed / 1000);
  }
  return { id, linkedAt };
}

interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

interface RawResponse {
  res: Response | null;
  body: Record<string, unknown>;
}

async function call(init: RequestInit, opts: RequestOptions): Promise<RawResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.endpoint ?? BOT_LINK_ENDPOINT, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: opts.signal,
      ...init,
    });
  } catch {
    return { res: null, body: {} };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    // A body we cannot read is not a body that said "no linked chats".
    payload = null;
  }
  return { res, body: (payload ?? {}) as Record<string, unknown> };
}

function classify(res: Response, body: Record<string, unknown>): Exclude<LinkStoreStatus, 'ready'> | null {
  const code = typeof body.code === 'string' ? body.code : null;
  if (res.status === 401) return 'signed-out';
  if (code === 'schema-missing') return 'schema-missing';
  if (code === 'not-configured') return 'not-configured';
  if (!res.ok) return 'unreachable';
  return null;
}

const step = (body: Record<string, unknown>) =>
  typeof body.operatorStep === 'string' ? body.operatorStep : null;
const serverDetail = (body: Record<string, unknown>) =>
  typeof body.error === 'string' ? body.error : null;

export async function listLinks(opts: RequestOptions = {}): Promise<LinkStoreResult> {
  const { res, body } = await call({ method: 'GET' }, opts);
  if (!res) {
    return fail(
      'unreachable',
      'The link store could not be reached, so your linked chats were not read. Nothing here says you have none.',
    );
  }
  const problem = classify(res, body);
  if (problem === 'signed-out') {
    return fail(
      'signed-out',
      'Telegram bindings are stored against your wallet, so they cannot be read until you sign in.',
    );
  }
  if (problem) {
    return fail(
      problem,
      serverDetail(body) ?? 'The link store could not answer, so your linked chats were not read.',
      step(body),
    );
  }
  const rows = Array.isArray(body.links) ? body.links : null;
  if (!rows) {
    return fail('unreachable', 'The link store returned an unexpected shape, so nothing was read.');
  }
  // Rows that fail coercion are DROPPED, not repaired: a binding rendered with a
  // guessed id offers a revoke button that would delete nothing, or worse.
  return {
    status: 'ready',
    links: rows.map(coerceLink).filter((l): l is TelegramLink => l !== null),
    detail: null,
    operatorStep: null,
  };
}

export async function claimLinkCode(code: string, opts: RequestOptions = {}): Promise<ClaimOutcome> {
  const normalised = code.trim().toUpperCase();
  if (!LINK_CODE_RE.test(normalised)) {
    // Rejected here rather than round-tripped: a malformed code is not a question
    // worth spending a rate-limit slot on, and the shape is the same on both ends.
    return {
      status: 'code-not-open',
      detail: 'That is not a link code. Codes are 10 characters and come from the bot when you send it /link.',
    };
  }
  const { res, body } = await call(
    { method: 'POST', body: JSON.stringify({ action: 'claim', code: normalised }) },
    opts,
  );
  if (!res) {
    return {
      status: 'failed',
      detail: 'The link store could not be reached, so this chat was NOT linked to your wallet.',
      operatorStep: null,
    };
  }
  if (res.ok) return { status: 'linked' };
  if (body.code === 'code-not-open') {
    return {
      status: 'code-not-open',
      detail: serverDetail(body) ?? 'That code is not open. Send the bot /link for a new one.',
    };
  }
  const problem = classify(res, body);
  return {
    status: 'failed',
    detail:
      problem === 'signed-out'
        ? 'Linking proves this wallet is yours by your signature, so you have to be signed in. Nothing was linked.'
        : (serverDetail(body) ?? 'The link was not completed.'),
    operatorStep: step(body),
  };
}

/**
 * Cut a binding.
 *
 * Returns the store's own verdict rather than an optimistic one. "Unlinked" is a
 * safety claim, and a user who believes a binding is gone stops watching one that
 * is live — the same reason the bot's own /unlink says "still in place" on failure.
 */
export async function revokeLinkById(
  id: string,
  opts: RequestOptions = {},
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { res, body } = await call({ method: 'POST', body: JSON.stringify({ action: 'revoke', id }) }, opts);
  if (!res) {
    return { ok: false, detail: 'The link store could not be reached. The binding is still in place.' };
  }
  if (res.ok) return { ok: true };
  return {
    ok: false,
    detail: serverDetail(body) ?? 'The binding was not removed. It is still in place.',
  };
}
