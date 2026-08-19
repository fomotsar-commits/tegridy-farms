// Typed client for the hosted airdrop manifest store at
// `/api/aggregator?resource=airdrop`.
//
// ZERO NEW SERVERLESS FUNCTIONS: the store is a `?resource=` branch on the aggregator
// catchall behind a lazy import, per api/SERVERLESS_BUDGET.md. The Vercel Hobby plan
// caps the deployment at 12 functions and the repo is at 11.
//
// ─── THE DEGRADATION CONTRACT ───────────────────────────────────────────────
//
// This file exists to keep one distinction alive across a network boundary:
//
//     "the store says this wallet is not a recipient"    — a fact about the wallet
//     "the store did not tell us anything"               — a fact about us
//
// Both arrive as "no allocation to show" by the time they reach a component, and the
// tempting shape is a single `manifest: CampaignManifest | null` where null means both.
// That shape renders "you are not eligible" during an outage, which tells a recipient to
// walk away from their own money.
//
// So: `manifest` is non-null ONLY when a list was actually read. Every failure — an
// unconfigured deployment, an unapplied migration, an unreachable store, a campaign with
// no stored manifest, a proof that would not verify — returns `manifest: null` AND a
// status naming which one it was. `evaluateEligibility` turns a null manifest into
// `unknown`, never into `not-listed`, and src/lib/merkle/storeHonesty.test.ts pins that
// the whole way through.
//
// `not-listed` is the only status that carries a negative verdict, and the server emits
// the `listed: false` it is built from on exactly one code path: manifest read, list
// queried, zero rows for this account.

import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import type { CampaignManifest, CampaignRow } from './campaign';

export const AIRDROP_STORE_ENDPOINT = '/api/aggregator?resource=airdrop';

export type ManifestStoreStatus =
  /** A list was read and this wallet has a row in it. `manifest` holds that one row. */
  | 'listed'
  /** A list was read and this wallet is not in it. The only honest negative. */
  | 'not-listed'
  /** The store answered, and holds no manifest for this campaign. Offer the paste path. */
  | 'no-manifest'
  /** The deployment has no manifest store configured at all. */
  | 'not-configured'
  /** Configured, but the manifest tables do not exist yet. */
  | 'schema-missing'
  /** The store generated a proof that does not verify. Nothing was served, by design. */
  | 'proof-unverifiable'
  /** Asked, no usable answer. */
  | 'unreachable';

/** Campaign-level facts. Carries no addresses — the store never serves the list. */
export interface StoredManifestMeta {
  chainId: number;
  root: Hex;
  distributor: Address | null;
  token: Address | null;
  recipientCount: number;
  /** Base units, as a decimal string. A uint256 total does not survive a JS number. */
  total: string;
  criteria: string | null;
  publishedAt: string | null;
}

export interface ManifestStoreResult {
  status: ManifestStoreStatus;
  /**
   * A PARTIAL manifest (`partial: true`) holding at most this wallet's row.
   *
   * Non-null only for `listed` and `not-listed` — the two statuses that mean a list was
   * genuinely read. Null for every failure, which is what keeps an outage out of the
   * eligibility verdict.
   */
  manifest: CampaignManifest | null;
  /** Campaign facts, when the store got far enough to report them. */
  meta: StoredManifestMeta | null;
  /** Null only when `status === 'listed'`. Rendered verbatim. */
  detail: string | null;
  /** What an operator must do, when anything. */
  operatorStep: string | null;
  /** True when the surface should offer the paste-a-manifest fallback. */
  pasteFallback: boolean;
}

function fail(
  status: Exclude<ManifestStoreStatus, 'listed' | 'not-listed'>,
  detail: string,
  operatorStep: string | null = null,
  pasteFallback = false,
): ManifestStoreResult {
  return { status, manifest: null, meta: null, detail, operatorStep, pasteFallback };
}

function coerceMeta(raw: unknown): StoredManifestMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const root = typeof m.root === 'string' && isHex(m.root) && m.root.length === 66 ? (m.root as Hex) : null;
  const chainId = typeof m.chainId === 'number' && Number.isInteger(m.chainId) ? m.chainId : null;
  const recipientCount =
    typeof m.recipientCount === 'number' && Number.isInteger(m.recipientCount) && m.recipientCount > 0
      ? m.recipientCount
      : null;
  // A meta block missing any of these three is not partially usable: `recipientCount` is
  // the number a negative verdict quotes, and quoting a guess is worse than saying the
  // store answered badly.
  if (!root || chainId === null || recipientCount === null) return null;
  return {
    chainId,
    root,
    distributor:
      typeof m.distributor === 'string' && isAddress(m.distributor) ? (getAddress(m.distributor) as Address) : null,
    token: typeof m.token === 'string' && isAddress(m.token) ? (getAddress(m.token) as Address) : null,
    recipientCount,
    total: typeof m.total === 'string' && /^\d+$/.test(m.total) ? m.total : '0',
    criteria: typeof m.criteria === 'string' && m.criteria.trim() !== '' ? m.criteria : null,
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : null,
  };
}

/**
 * Coerce the one served entry into a `CampaignRow`.
 *
 * Rejects rather than repairs. A row with a mangled amount or a dropped proof element is
 * not a smaller allocation, it is a claim that reverts — and the claim surface re-verifies
 * this proof locally against the root the DISTRIBUTOR reports before offering a button,
 * so a row that cannot be coerced must not become a row at all.
 */
function coerceRow(raw: unknown): CampaignRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.index !== 'number' || !Number.isInteger(r.index) || r.index < 0) return null;
  if (typeof r.account !== 'string' || !isAddress(r.account)) return null;
  if (typeof r.amount !== 'string' || !/^\d+$/.test(r.amount)) return null;
  if (typeof r.leaf !== 'string' || !isHex(r.leaf) || r.leaf.length !== 66) return null;
  if (!Array.isArray(r.proof)) return null;
  const proof: Hex[] = [];
  for (const p of r.proof) {
    if (typeof p !== 'string' || !isHex(p) || p.length !== 66) return null;
    proof.push(p as Hex);
  }
  const amount = BigInt(r.amount);
  if (amount === 0n) return null;
  return { index: r.index, account: getAddress(r.account) as Address, amount, leaf: r.leaf as Hex, proof };
}

interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/**
 * Fetch one wallet's leaf and proof for one campaign.
 *
 * @param campaign Name the campaign by its `distributor` address (what a claimant has)
 *                 or by its `root` (what a creator has before funding). One is required.
 */
export async function fetchStoredProof(
  campaign: { chainId: number; distributor?: Address | null; root?: Hex | null },
  account: Address,
  opts: RequestOptions = {},
): Promise<ManifestStoreResult> {
  const params = new URLSearchParams({ resource: 'airdrop', chainId: String(campaign.chainId), account });
  if (campaign.distributor) params.set('distributor', campaign.distributor);
  else if (campaign.root) params.set('root', campaign.root);
  else {
    return fail('unreachable', 'No campaign was named, so the manifest store was not asked anything.');
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.endpoint ?? `/api/aggregator?${params.toString()}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    });
  } catch {
    return fail(
      'unreachable',
      'The manifest store could not be reached, so no claim list was loaded. Nothing here says this wallet is not a recipient.',
      null,
      true,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    // A body we cannot read is not a body that said "not a recipient".
    payload = null;
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : null;
  const operatorStep = typeof body.operatorStep === 'string' ? body.operatorStep : null;
  const serverDetail = typeof body.error === 'string' ? body.error : null;

  if (code === 'not-configured') {
    return fail(
      'not-configured',
      serverDetail ?? 'This deployment has no manifest store configured, so no claim list could be read.',
      operatorStep,
      true,
    );
  }
  if (code === 'schema-missing') {
    return fail(
      'schema-missing',
      serverDetail ?? 'The manifest tables do not exist on this deployment, so no claim list could be read.',
      operatorStep,
      true,
    );
  }
  if (code === 'manifest-missing') {
    return fail(
      'no-manifest',
      serverDetail ??
        'No manifest is stored for this campaign. The chain stores only the root, so its list was published somewhere else.',
      operatorStep,
      true,
    );
  }
  if (code === 'proof-unverifiable') {
    return fail(
      'proof-unverifiable',
      serverDetail ??
        'The store could not produce a proof that verifies against this campaign’s root, so it served none. This is a fault in the stored list, not a statement about this wallet.',
      operatorStep,
      true,
    );
  }
  if (!res.ok) {
    return fail(
      'unreachable',
      serverDetail ?? `The manifest store answered ${res.status}, so no claim list was loaded.`,
      operatorStep,
      true,
    );
  }

  const meta = coerceMeta(body.manifest);
  if (!meta) {
    return fail('unreachable', 'The manifest store returned a campaign record this page could not read.', null, true);
  }

  // ─── From here on, a list WAS read. Only now may a negative be reported. ───

  if (body.listed === false) {
    return {
      status: 'not-listed',
      manifest: manifestFrom(meta, []),
      meta,
      detail:
        typeof body.detail === 'string'
          ? body.detail
          : `This wallet is not among the ${meta.recipientCount} addresses in the campaign’s stored list.`,
      operatorStep: null,
      pasteFallback: false,
    };
  }

  const row = coerceRow(body.entry);
  if (!row) {
    // The server said `listed: true` and then handed over something unusable. That is
    // not a wallet with no allocation; it is an answer we cannot act on.
    return fail('unreachable', 'The manifest store returned a row this page could not read, so nothing was checked.', null, true);
  }
  if (row.account.toLowerCase() !== account.toLowerCase()) {
    // The store is only ever asked about one address. A row for a different one means
    // the wrong wallet's allocation, which must never be rendered as this wallet's.
    return fail('unreachable', 'The manifest store returned a row for a different wallet, so nothing was used.', null, true);
  }

  return {
    status: 'listed',
    manifest: manifestFrom(meta, [row]),
    meta,
    detail: null,
    operatorStep: null,
    pasteFallback: false,
  };
}

/**
 * Wrap store output in the manifest shape the eligibility evaluator already consumes.
 *
 * `partial` and `recipientCount` are what stop `rows.length` being mistaken for the
 * campaign size — see the comments on those fields in campaign.ts. `total` is the
 * campaign's, not the row's, and is only ever shown as the campaign's.
 */
function manifestFrom(meta: StoredManifestMeta, rows: CampaignRow[]): CampaignManifest {
  return {
    version: 1,
    root: meta.root,
    total: BigInt(meta.total),
    rows,
    token: meta.token ?? undefined,
    distributor: meta.distributor ?? undefined,
    chainId: meta.chainId,
    criteria: meta.criteria ?? undefined,
    partial: true,
    recipientCount: meta.recipientCount,
  };
}

// ─── Creator side ──────────────────────────────────────────────────────────

export interface PublishResult {
  ok: boolean;
  /** The root the store computed from the list it stored. Shown BEFORE funding. */
  root: Hex | null;
  meta: StoredManifestMeta | null;
  /** Null when `ok`. Rendered verbatim. */
  detail: string | null;
  operatorStep: string | null;
  /** True when the failure was "already published" — the root is still authoritative. */
  alreadyPublished: boolean;
}

/**
 * Publish a campaign list to the store and get back the root it computed.
 *
 * The root the STORE computed is the one returned, not the one the browser built. Those
 * two agreeing is the point: both sides run src/lib/merkle/core.js, and the creator is
 * about to commit the number on screen to a funding transaction. If the store ever
 * returned a different root, the caller must refuse to fund — CampaignBuilder does.
 */
export async function publishManifest(
  input: {
    chainId: number;
    token?: Address | null;
    criteria?: string | null;
    /** Base units as decimal strings. Never numbers. */
    entries: { account: Address; amount: string }[];
  },
  opts: RequestOptions = {},
): Promise<PublishResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.endpoint ?? AIRDROP_STORE_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        action: 'publish',
        chainId: input.chainId,
        token: input.token ?? undefined,
        criteria: input.criteria ?? undefined,
        entries: input.entries,
      }),
    });
  } catch {
    return {
      ok: false,
      root: null,
      meta: null,
      detail: 'The manifest store could not be reached, so nothing was published. Keep your manifest JSON.',
      operatorStep: null,
      alreadyPublished: false,
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  const root = typeof body.root === 'string' && isHex(body.root) && body.root.length === 66 ? (body.root as Hex) : null;
  const operatorStep = typeof body.operatorStep === 'string' ? body.operatorStep : null;
  const serverDetail = typeof body.error === 'string' ? body.error : null;

  if (res.status === 409 && body.code === 'already-published') {
    return {
      ok: false,
      root,
      meta: null,
      detail: serverDetail ?? 'This exact list is already published for this chain.',
      operatorStep,
      alreadyPublished: true,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      root,
      meta: null,
      detail: serverDetail ?? `The manifest store answered ${res.status}, so nothing was published.`,
      operatorStep,
      alreadyPublished: false,
    };
  }
  const meta = coerceMeta(body.manifest);
  if (!meta) {
    return {
      ok: false,
      root,
      meta: null,
      detail: 'The store accepted the list but returned a record this page could not read, so the stored root is unconfirmed.',
      operatorStep: null,
      alreadyPublished: false,
    };
  }
  return { ok: true, root: meta.root, meta, detail: null, operatorStep: null, alreadyPublished: false };
}

/** Record the distributor address against a published root, after `createCampaign` lands. */
export async function attachDistributor(
  input: { chainId: number; root: Hex; distributor: Address },
  opts: RequestOptions = {},
): Promise<{ ok: boolean; detail: string | null }> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(opts.endpoint ?? AIRDROP_STORE_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({ action: 'attach', ...input }),
    });
    if (res.ok) return { ok: true, detail: null };
    let detail: string | null = null;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      detail = typeof body.error === 'string' ? body.error : null;
    } catch {
      detail = null;
    }
    return { ok: false, detail: detail ?? `The store answered ${res.status}; the campaign address was not recorded.` };
  } catch {
    return { ok: false, detail: 'The manifest store could not be reached; the campaign address was not recorded.' };
  }
}
