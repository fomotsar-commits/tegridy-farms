// Token identity for OWN-curve launches (image / description / socials) —
// fully serverless, spoof-resistant, and zero contract changes.
//
// The deployed TegridyCurveLauncher stores only name+symbol on-chain (its
// LaunchConfig/Launch structs have no metadata slot, and the contract is
// immutable on 3 chains). Identity therefore lives OFF-chain on Arweave via
// Irys — the same rail the NFT launchpad wizard already ships — and is bound
// to the launch by SIGNATURE, not by trust in a database:
//
//   write: the CREATOR's wallet signs an Irys upload of a metadata JSON,
//          tagged { App-Name, Tegridy-Token, Tegridy-Chain-Id }.
//   read:  query Irys GraphQL for those tags FILTERED BY owners=[creator]
//          (creator read from the chain via getLaunch). Only uploads signed
//          by the launch's own creator can ever resolve — a stranger tagging
//          someone else's token address is invisible to the query, and the
//          node's `address` is re-checked client-side as defence in depth.
//
// Latest-wins (order: DESC), so a creator can update their identity by
// re-uploading. Resolution NEVER fabricates: every failure mode is an explicit
// status ('none' | 'invalid' | 'error'), and the UI renders an honest
// no-image state — same philosophy as CurveChart's no-fallback rule.
//
// GraphQL query shape verified against the live endpoint 2026-08-27:
// transactions(owners, tags, limit, order: DESC) { edges { node { id address … } } }

import { arweaveHttpUrl } from '../irysClient';

// ─────────────────────────────── constants ───────────────────────────────

export const IDENTITY_GRAPHQL_ENDPOINT = 'https://uploader.irys.xyz/graphql';

/** Tag names/values binding an upload to a launch. Bump App-Version on shape changes. */
export const IDENTITY_APP_NAME = 'Tegridy-Curve-Identity';
export const IDENTITY_APP_VERSION = '1';
export const TAG_APP_NAME = 'App-Name';
export const TAG_APP_VERSION = 'App-Version';
export const TAG_TOKEN = 'Tegridy-Token';
export const TAG_CHAIN_ID = 'Tegridy-Chain-Id';

/** Irys uploads under 100 KiB ride the free tier — no fund() leg, no wallet
 *  drain surface. Memecoin thumbnails fit comfortably; enforce before the SDK. */
export const IDENTITY_IMAGE_MAX_BYTES = 100 * 1024;
export const IDENTITY_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const IDENTITY_DESCRIPTION_MAX = 280;
/** Generous read-side bound so a future writer raising the cap doesn't
 *  invalidate old identities; the create panel still writes ≤280. */
const DESCRIPTION_READ_MAX = 1000;
const NAME_MAX = 64; // mirrors the contract's BadTokenMetadata bounds
const SYMBOL_MAX = 16;
const HANDLE_RE = /^[A-Za-z0-9_]{1,32}$/; // anchored (CodeQL URL-regex gate)
const ARWEAVE_TX_RE = /^[A-Za-z0-9_-]{43}$/; // anchored; base64url tx id

// ─────────────────────────────── types ───────────────────────────────

export interface CurveIdentityDraft {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
}

/** The JSON uploaded to Arweave. `token`/`chainId` are duplicated INSIDE the
 *  body (not just in tags) so the binding survives any tag-less mirror. */
export interface CurveIdentityMetadata {
  version: 1;
  token: string;
  chainId: number;
  name: string;
  symbol: string;
  image: string; // ar://<txid>
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface CurveIdentity {
  name: string;
  symbol: string;
  /** https URL on arweave.net — allowed by the shipped CSP img-src. */
  imageUrl: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export type CurveIdentityResolution =
  | { status: 'resolving' }
  | { status: 'ok'; identity: CurveIdentity }
  /** No identity published by this creator for this token+chain. */
  | { status: 'none' }
  /** Something resolved but failed validation — treated as absent, never rendered. */
  | { status: 'invalid' }
  /** Network/endpoint failure — unknown, not absent. */
  | { status: 'error' };

// ─────────────────────────────── validation ───────────────────────────────

/** Returns a human-readable rejection or null when the file is acceptable. */
export function validateIdentityImage(file: { size: number; type: string }): string | null {
  if (!(IDENTITY_IMAGE_MIME as readonly string[]).includes(file.type)) {
    return 'Image must be PNG, JPG, WebP or GIF.';
  }
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > IDENTITY_IMAGE_MAX_BYTES) {
    return `Image must be ${Math.floor(IDENTITY_IMAGE_MAX_BYTES / 1024)} KB or smaller (free upload).`;
  }
  return null;
}

/** Strip a leading @ and validate; returns the clean handle or null. */
function cleanHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().replace(/^@/, '');
  return HANDLE_RE.test(h) ? h : null;
}

/** Accept only https:// URLs; anything else is dropped (field, not identity). */
function cleanWebsite(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** ar://<txid> or bare <txid> → the 43-char tx id, else null. */
export function arweaveTxIdFrom(image: unknown): string | null {
  if (typeof image !== 'string') return null;
  const bare = image.startsWith('ar://') ? image.slice('ar://'.length).replace(/\/$/, '') : image;
  return ARWEAVE_TX_RE.test(bare) ? bare : null;
}

// ─────────────────────────────── build (write side) ───────────────────────────────

export function identityTags(token: string, chainId: number): Array<{ name: string; value: string }> {
  return [
    { name: TAG_APP_NAME, value: IDENTITY_APP_NAME },
    { name: TAG_APP_VERSION, value: IDENTITY_APP_VERSION },
    { name: TAG_TOKEN, value: token.toLowerCase() },
    { name: TAG_CHAIN_ID, value: String(chainId) },
  ];
}

export function buildIdentityMetadata(args: {
  token: string;
  chainId: number;
  imageTxId: string;
  draft: CurveIdentityDraft;
}): CurveIdentityMetadata {
  const { token, chainId, imageTxId, draft } = args;
  const meta: CurveIdentityMetadata = {
    version: 1,
    token: token.toLowerCase(),
    chainId,
    name: draft.name.trim().slice(0, NAME_MAX),
    symbol: draft.symbol.trim().slice(0, SYMBOL_MAX),
    image: `ar://${imageTxId}`,
  };
  const description = draft.description.trim().slice(0, IDENTITY_DESCRIPTION_MAX);
  if (description) meta.description = description;
  const website = cleanWebsite(draft.website);
  if (website) meta.website = website;
  const twitter = cleanHandle(draft.twitter);
  if (twitter) meta.twitter = twitter;
  const telegram = cleanHandle(draft.telegram);
  if (telegram) meta.telegram = telegram;
  return meta;
}

// ─────────────────────────────── resolve (read side) ───────────────────────────────

const IDENTITY_QUERY = `query($owners:[String!],$tags:[TagFilter!]){ transactions(owners:$owners, tags:$tags, limit:1, order:DESC){ edges { node { id address } } } }`;

interface GraphQlNode {
  id?: unknown;
  address?: unknown;
}

/** Parse + validate a fetched metadata body against the launch it claims. */
export function parseIdentityMetadata(
  body: unknown,
  expect: { token: string; chainId: number },
): CurveIdentity | null {
  if (!body || typeof body !== 'object') return null;
  const m = body as Record<string, unknown>;
  if (typeof m.token !== 'string' || m.token.toLowerCase() !== expect.token.toLowerCase()) return null;
  if (typeof m.chainId !== 'number' || m.chainId !== expect.chainId) return null;
  if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > NAME_MAX) return null;
  if (typeof m.symbol !== 'string' || m.symbol.length === 0 || m.symbol.length > SYMBOL_MAX) return null;
  const txId = arweaveTxIdFrom(m.image);
  if (!txId) return null;

  const identity: CurveIdentity = {
    name: m.name,
    symbol: m.symbol,
    imageUrl: arweaveHttpUrl(txId),
  };
  if (typeof m.description === 'string' && m.description.trim()) {
    identity.description = m.description.trim().slice(0, DESCRIPTION_READ_MAX);
  }
  const website = cleanWebsite(m.website);
  if (website) identity.website = website;
  const twitter = cleanHandle(m.twitter);
  if (twitter) identity.twitter = twitter;
  const telegram = cleanHandle(m.telegram);
  if (telegram) identity.telegram = telegram;
  return identity;
}

/**
 * Resolve the identity a launch's CREATOR published for it, if any.
 *
 * Spoof resistance is structural: the GraphQL query filters `owners` to the
 * on-chain creator, and the returned node's `address` is re-checked — an
 * upload signed by anyone else can never resolve, whatever it is tagged with.
 */
export async function resolveCurveIdentity(
  args: { token: string; chainId: number; creator: string },
  fetchFn: typeof fetch = fetch,
): Promise<CurveIdentityResolution> {
  const { token, chainId, creator } = args;
  try {
    const owners = Array.from(new Set([creator, creator.toLowerCase()]));
    const res = await fetchFn(IDENTITY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: IDENTITY_QUERY,
        variables: {
          owners,
          tags: [
            { name: TAG_APP_NAME, values: [IDENTITY_APP_NAME] },
            { name: TAG_TOKEN, values: [token.toLowerCase()] },
            { name: TAG_CHAIN_ID, values: [String(chainId)] },
          ],
        },
      }),
    });
    if (!res.ok) return { status: 'error' };
    const payload: unknown = await res.json();
    const edges = (payload as { data?: { transactions?: { edges?: unknown[] } } })?.data
      ?.transactions?.edges;
    if (!Array.isArray(edges) || edges.length === 0) return { status: 'none' };
    const node = (edges[0] as { node?: GraphQlNode })?.node;
    if (!node || typeof node.id !== 'string') return { status: 'invalid' };
    // Defence in depth — the owners filter should already guarantee this.
    if (typeof node.address !== 'string' || node.address.toLowerCase() !== creator.toLowerCase()) {
      return { status: 'invalid' };
    }

    const bodyRes = await fetchFn(arweaveHttpUrl(node.id));
    if (!bodyRes.ok) return { status: 'error' };
    const body: unknown = await bodyRes.json();
    const identity = parseIdentityMetadata(body, { token, chainId });
    return identity ? { status: 'ok', identity } : { status: 'invalid' };
  } catch {
    return { status: 'error' };
  }
}

// ─────────────────────────────── render helpers ───────────────────────────────

export function twitterUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

export function telegramUrl(handle: string): string {
  return `https://t.me/${handle}`;
}
