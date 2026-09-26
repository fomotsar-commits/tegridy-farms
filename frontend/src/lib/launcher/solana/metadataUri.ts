// Metadata-URI checks for the Solana launch path.
//
// ## Why this is worth its own module
//
// Launched tokens are created with `AUTHORITY_IMMUTABLE` — no mint authority and
// NO UPDATE AUTHORITY (dbc.ts:519). The metadata URI is therefore **permanent**:
// whatever a launcher types is the name, symbol and image every wallet and explorer
// will show for that token forever. There is no edit, no re-upload, no support
// ticket. A typo is not a bad first impression, it is the token.
//
// Everything here is pure or dependency-injected so it can be tested without a
// network, and the shape check runs before any signature is requested.

import { IPFS_GATEWAYS, IPFS_STEP_TIMEOUT_MS, fetchIpfsStep, ipfsGatewayUrls } from '../../ipfsGateways';

/** An https:// or ar:// host answers for itself: one request, this long. */
const SINGLE_HOST_DEADLINE_MS = 8000;

/**
 * An ipfs:// check may have to walk every gateway, each with its own step
 * budget (IPFS_STEP_TIMEOUT_MS), and then read a small JSON body. The overall
 * deadline must cover that walk, or it cuts the walk short: with a total of 8s
 * and a 6s step, a hung first gateway left 2s for the other three, and Pinata,
 * the one gateway that served every uncached CID, takes up to 7.5s.
 */
export const IPFS_CHECK_DEADLINE_MS = IPFS_STEP_TIMEOUT_MS * IPFS_GATEWAYS.length + 2000;

/** Schemes a wallet or explorer will actually resolve. */
const ALLOWED_SCHEMES = ['ipfs://', 'https://', 'ar://'] as const;

export type UriShape =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate the SHAPE of a metadata URI. Pure, instant, and blocking.
 *
 * Deliberately rejects `http://`: wallets and explorers routinely refuse or
 * mixed-content-block plain HTTP, so a token launched with one shows no image
 * anywhere, permanently — and unlike a 404 it looks like it should work.
 */
export function validateMetadataUri(raw: string): UriShape {
  const uri = raw.trim();
  if (!uri) return { ok: false, reason: 'A metadata URI is required.' };

  if (uri.startsWith('http://')) {
    return {
      ok: false,
      reason: 'Use https:// — plain http:// is blocked by most wallets, and this URI can never be changed.',
    };
  }
  if (!ALLOWED_SCHEMES.some((s) => uri.startsWith(s))) {
    return { ok: false, reason: 'Must start with ipfs://, https:// or ar://.' };
  }
  // A scheme with nothing after it is a common paste error and would otherwise
  // sail through to an on-chain write.
  for (const s of ALLOWED_SCHEMES) {
    if (uri.startsWith(s) && uri.length <= s.length) {
      return { ok: false, reason: 'The URI is just a scheme — the path is missing.' };
    }
  }
  if (/\s/.test(uri)) return { ok: false, reason: 'The URI contains a space.' };
  return { ok: true };
}

/**
 * Turn a URI into something fetchable, for CHECKING ONLY.
 *
 * The gateway is never stored or submitted — the token records the original
 * `ipfs://`/`ar://` URI, which is the durable form. This exists solely so the
 * pre-launch check can look at the document.
 *
 * Returns every URL worth trying, in order. Only `ipfs://` has more than one
 * (the site-wide gateway list in lib/ipfsGateways.ts): see
 * {@link checkMetadataDocument} for why one gateway's answer is not an answer
 * about the content.
 */
export function toFetchableUrls(uri: string): string[] {
  const u = uri.trim();
  if (u.startsWith('https://')) return [u];
  if (u.startsWith('ar://')) return [`https://arweave.net/${u.slice('ar://'.length)}`];
  if (u.startsWith('ipfs://')) return ipfsGatewayUrls(u);
  return [];
}

/** The first URL to try. Kept for callers that just want something to link to. */
export function toFetchableUrl(uri: string): string | null {
  return toFetchableUrls(uri)[0] ?? null;
}

export type DocumentVerdict =
  /** Fetched, parsed, and it looks like token metadata. */
  | { status: 'ok'; name?: string; symbol?: string; image?: string }
  /** Reached it, but it is not usable as token metadata. */
  | { status: 'invalid'; reason: string }
  /**
   * Could NOT check — offline, CORS, gateway down. Never treated as a failure.
   *
   * `severity` separates the two very different reasons a check comes back
   * unknown, because a UI that renders them identically buries the one that
   * matters. `notice` is "our browser could not look", which says nothing about
   * the metadata. `warning` is "we looked and found nothing, and we are not
   * entitled to call that proof" — the launcher has to act on it, so it must not
   * be shown in the same grey as a CORS refusal.
   */
  | { status: 'unknown'; reason: string; severity?: 'notice' | 'warning' };

/**
 * Best-effort look at the metadata document.
 *
 * ADVISORY, never blocking. A cross-origin gateway may legitimately refuse the
 * read, and a launcher whose metadata is perfectly fine must not be stopped by our
 * inability to see it — so an unreachable document is `unknown`, not `invalid`.
 * Only a document we genuinely read and found wrong is `invalid`.
 */
export async function checkMetadataDocument(
  uri: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
  ipfsStepMs = IPFS_STEP_TIMEOUT_MS,
): Promise<DocumentVerdict> {
  const urls = toFetchableUrls(uri);
  if (urls.length === 0) return { status: 'unknown', reason: 'Unsupported URI scheme.' };
  const isIpfs = uri.trim().startsWith('ipfs://');
  timeoutMs ??= isIpfs ? IPFS_CHECK_DEADLINE_MS : SINGLE_HOST_DEADLINE_MS;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res: Response | undefined;
    // The body to judge, once one is chosen.
    let text: string | undefined;
    // Stays true only while every gateway that answered said 404.
    let every404 = true;
    // The first 200 whose body is not JSON, and whether a second gateway sent
    // the very same bytes.
    let nonJson: string | undefined;
    let nonJsonConfirmed = false;
    for (const url of urls) {
      if (!isIpfs) {
        res = await fetchImpl(url, { signal: ac.signal });
        if (res.ok) text = await textWithin(res, ac.signal);
        break;
      }
      // ── WHY IPFS RETRIES AND THE OTHERS DO NOT ────────────────────────────
      // A public IPFS gateway's answer is a statement about that gateway, not
      // about the content. Freshly pinned CIDs routinely 404 for minutes while
      // the announcement propagates; gateways prune, rate-limit (429), sit
      // behind bot challenges (403), hang, or are retired outright (ipfs.io and
      // dweb.link, 2026-09-21). Reading any of that as "nothing is published
      // there" would block a launcher whose upload is perfectly fine: an outage
      // rendered as a finding, which is the one thing this module is built not
      // to do. So every gateway failure moves on to the next gateway, and each
      // gets its own time limit so one hang cannot starve the rest. https://
      // and ar:// hosts ARE authoritative for their own paths, so their answer
      // stands.
      try {
        res = await fetchIpfsStep(fetchImpl, url, ac.signal, ipfsStepMs);
      } catch (e) {
        if (ac.signal.aborted) throw e; // the overall deadline, not this gateway
        every404 = false;
        continue;
      }
      if (res.ok) {
        const body = await textWithin(res, ac.signal);
        if (parsesAsJson(body)) {
          text = body;
          break;
        }
        // A 200 that is not JSON may be the gateway's own page (an error or a
        // challenge served as 200), which says nothing about the content. IPFS
        // content is the same bytes on every gateway, so a second gateway
        // sending the same body settles it; until then, keep walking.
        every404 = false;
        if (nonJson === undefined) nonJson = body;
        else if (body === nonJson) {
          nonJsonConfirmed = true;
          break;
        }
        continue;
      }
      if (res.status !== 404) every404 = false;
    }
    if (!res) return { status: 'unknown', reason: 'Could not read it from this browser.' };
    if (nonJsonConfirmed) return { status: 'invalid', reason: 'That URI does not return JSON.' };
    if (text === undefined && nonJson !== undefined) {
      return {
        status: 'unknown',
        severity: 'warning',
        reason:
          'One IPFS gateway returned something that is not JSON, and no other gateway could confirm it. Check that this URI points at the metadata file, not the image.',
      };
    }
    if (!res.ok) {
      if (isIpfs) {
        if (every404) {
          // Every gateway said 404: stronger, but still not proof. IPFS has no
          // authoritative "this CID does not exist" answer to give, so this
          // stays a warning the launcher must read, never a block.
          return {
            status: 'unknown',
            severity: 'warning',
            reason:
              'No IPFS gateway could find this CID. That often means it has not propagated yet — but if the upload failed, this URI is permanent. Confirm it resolves before launching.',
          };
        }
        // A mix of refusals, hangs and 404s says the gateways are unwell, not
        // that the content is missing.
        return { status: 'unknown', reason: `No IPFS gateway could serve it right now (the last one returned ${res.status}).` };
      }
      if (res.status === 404) return { status: 'invalid', reason: 'Nothing is published at that URI (404).' };
      return { status: 'unknown', reason: `The host returned ${res.status}.` };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text as string);
    } catch {
      return { status: 'invalid', reason: 'That URI does not return JSON.' };
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { status: 'invalid', reason: 'The metadata JSON is not an object.' };
    }
    const d = doc as Record<string, unknown>;
    const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
    const name = str('name');
    const image = str('image');
    if (!name && !image) {
      return { status: 'invalid', reason: 'The JSON has neither a name nor an image field.' };
    }
    return { status: 'ok', name, symbol: str('symbol'), image };
  } catch (e) {
    // Abort, CORS, DNS, offline — all indistinguishable from the browser, and none
    // of them prove the metadata is bad.
    const reason = e instanceof Error && e.name === 'AbortError' ? 'The check timed out.' : 'Could not read it from this browser.';
    return { status: 'unknown', reason };
  } finally {
    clearTimeout(timer);
  }
}

function parsesAsJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * The body, or an AbortError when `signal` fires first. fetchIpfsStep lets go
 * of the caller's signal once the headers arrive, so without this a gateway
 * that sent headers and then stalled would hold the check past its deadline.
 */
function textWithin(res: Response, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    res.text().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
