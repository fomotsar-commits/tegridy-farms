// Referral attribution: which link brought this visitor here, and how we know.
//
// ─── FIRST-TOUCH, AND WHY ────────────────────────────────────────────────────
//
// The on-chain ledger this feeds is one-time and permanent: ReferralSplitter's
// `setReferrer` reverts `AlreadyReferred` on a second call, and the only escape
// is `updateReferrer` behind a 30-day `REFERRER_COOLDOWN`. So the value this
// module carries is not a marketing attribution window, it is a prefill for an
// irreversible transaction, and the two failure directions are not symmetric:
// prefilling the recruiter costs nothing if the user declines, while prefilling
// a later link permanently pays someone who did not recruit them.
//
// Last-touch is also trivially stealable here. Every share surface produces a
// plain `?ref=<address>` URL, so anyone who gets a user to click one more link —
// a reply under the original tweet, a Telegram bot, a redirect — overwrites the
// recruiter. First-touch makes the recruiter's claim the one that survives, and
// it is the rule the contract itself already encodes.
//
// ─── NOT SILENT ──────────────────────────────────────────────────────────────
//
// "Do not overwrite" is only half the requirement. A later link that is dropped
// without trace produces a user who was told they were referred by B and a
// prefill that says A, with nothing on screen explaining the difference. So
// every ignored link is RECORDED (`ignored[]`) with the address and the path it
// arrived on, and the attribution surface renders them. The record is the
// observability; deleting it to "clean up" removes the only evidence that a
// second link was ever seen.
//
// ─── ONE STORAGE LOCATION ────────────────────────────────────────────────────
//
// `tegridy_ref` already exists and already holds a bare referrer address:
// HomePage.tsx writes it on `?ref=` capture and ReferralWidget.tsx reads it to
// prefill. This module does NOT introduce a competing key for the same fact — it
// reads and writes that exact key, in that exact bare-address format, so those
// two files keep working untouched. Everything this module knows that a bare
// string cannot express (when, from where, what was ignored) lives in a SIDECAR
// key, and the sidecar is never the authority for the address itself.
//
// The consequence to keep in mind: a record written by the legacy path has no
// capture time and no path, and `capturedAt` is `null` there rather than
// `Date.now()`. A synthesised timestamp would be a fabricated fact about when
// somebody clicked a link.

import { isAddress } from 'viem';
import { safeGetItem, safeSetItem } from '../storage';

/**
 * THE address key. Shared with HomePage.tsx and ReferralWidget.tsx, both of
 * which store/read a bare lowercase-or-checksummed address string. Changing the
 * format here silently breaks the prefill in both.
 */
export const REF_ADDRESS_KEY = 'tegridy_ref';

/** Sidecar: everything a bare address cannot carry. Never the address authority. */
export const REF_META_KEY = 'tegridy_ref_meta';

/** Query parameter carrying a raw referrer address. */
export const REF_PARAM = 'ref';

/**
 * Query parameter carrying a short code that resolves to an address server-side.
 * Distinct from `ref` on purpose: a code has NOT been resolved at capture time,
 * so a code-only capture is not yet an attribution and must not be stored as one.
 */
export const REF_CODE_PARAM = 'r';

/** Codes are minted by api/_lib/referrals.js; this is the shape it guarantees. */
export const REF_CODE_RE = /^[a-z0-9]{4,12}$/;

export type AttributionSource =
  /** Captured by this module from a URL, with a timestamp and path. */
  | 'link'
  /** Found in `tegridy_ref` with no sidecar — written by the pre-existing
   *  HomePage capture. Real, but its capture time is unknown and stays unknown. */
  | 'legacy';

export interface IgnoredLink {
  /** The referrer address that arrived after attribution was already settled. */
  address: string;
  /** Unix ms this module saw it. Always known — this module wrote the entry. */
  at: number;
  /** `location.pathname` it arrived on, for "where did this come from". */
  path: string | null;
}

export interface Attribution {
  /** The referrer address, exactly as stored under REF_ADDRESS_KEY. */
  address: string;
  /**
   * Unix ms of capture, or null when it cannot be known.
   *
   * Null is a real answer, not a missing one: a legacy record genuinely has no
   * capture time and any number here would be invented. Renderers must print
   * "time not recorded", never a date.
   */
  capturedAt: number | null;
  /** Path the link landed on, or null for legacy records. */
  path: string | null;
  source: AttributionSource;
  /**
   * Later, different referrer links that were seen and NOT applied, oldest
   * first. Empty is the common case; non-empty is what the surface must show.
   */
  ignored: IgnoredLink[];
}

/** Most recent ignored links retained. Older ones are dropped from the tail. */
export const MAX_IGNORED_RETAINED = 5;

interface StoredMeta {
  v: 1;
  /** Must match REF_ADDRESS_KEY's value or the sidecar is stale and discarded. */
  address: string;
  /**
   * Unix ms, or null for a record this module never saw arrive.
   *
   * Nullable rather than absent-or-number because a sidecar CAN exist for a
   * legacy address: the first ignored second-link creates one. That sidecar
   * still does not know when the original link arrived, and `0` would render as
   * January 1970 — a date, on screen, that nobody's click produced.
   */
  capturedAt: number | null;
  path: string | null;
  ignored: IgnoredLink[];
}

function normalise(addr: string): string | null {
  const trimmed = addr.trim();
  return isAddress(trimmed) ? trimmed : null;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function readMeta(): StoredMeta | null {
  const raw = safeGetItem(REF_META_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Partial<StoredMeta>;
  if (m.v !== 1) return null;
  if (typeof m.address !== 'string' || !isAddress(m.address)) return null;
  const capturedAt =
    m.capturedAt === null
      ? null
      : typeof m.capturedAt === 'number' && Number.isFinite(m.capturedAt)
        ? m.capturedAt
        : undefined;
  // `undefined` here means the field was neither null nor a usable number, i.e.
  // the sidecar is corrupt. Discard the whole record rather than default the
  // time — a defaulted capture time is the fabricated fact this file forbids.
  if (capturedAt === undefined) return null;
  const ignored: IgnoredLink[] = Array.isArray(m.ignored)
    ? m.ignored.filter(
        (e): e is IgnoredLink =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as IgnoredLink).address === 'string' &&
          isAddress((e as IgnoredLink).address) &&
          typeof (e as IgnoredLink).at === 'number' &&
          Number.isFinite((e as IgnoredLink).at),
      )
    : [];
  return {
    v: 1,
    address: m.address,
    capturedAt,
    path: typeof m.path === 'string' ? m.path : null,
    ignored,
  };
}

function writeMeta(meta: StoredMeta): void {
  safeSetItem(REF_META_KEY, JSON.stringify(meta));
}

/**
 * What this browser is currently attributed to, or null.
 *
 * The address key is the authority. A sidecar naming a different address is
 * treated as stale and its metadata dropped rather than trusted — the two
 * disagreeing means something wrote the address key directly (the legacy path
 * does exactly this), and the address is the half that feeds a transaction.
 */
export function readAttribution(): Attribution | null {
  const stored = safeGetItem(REF_ADDRESS_KEY);
  if (!stored) return null;
  const address = normalise(stored);
  if (address === null) return null;

  const meta = readMeta();
  if (meta && sameAddress(meta.address, address)) {
    return {
      address,
      capturedAt: meta.capturedAt,
      path: meta.path,
      // A sidecar with no capture time describes an address this module never
      // saw arrive — it exists only because a LATER link was ignored. That is
      // still a legacy attribution, and calling it `link` would imply we have a
      // capture record for it.
      source: meta.capturedAt === null ? 'legacy' : 'link',
      ignored: meta.ignored,
    };
  }
  return { address, capturedAt: null, path: null, source: 'legacy', ignored: [] };
}

export type CaptureOutcome =
  /** No referrer parameter in the URL. Nothing changed. */
  | { kind: 'none' }
  /** A `ref` parameter was present but is not a valid address. Nothing stored. */
  | { kind: 'invalid'; raw: string }
  /** First attribution — stored. */
  | { kind: 'captured'; attribution: Attribution }
  /** The same referrer arrived again. Not a conflict, nothing recorded. */
  | { kind: 'unchanged'; attribution: Attribution }
  /**
   * A DIFFERENT referrer arrived after attribution was settled. The stored
   * attribution is untouched and the new address is appended to `ignored`.
   */
  | { kind: 'ignored'; attribution: Attribution; ignoredAddress: string }
  /**
   * A `?r=<code>` was present with no `?ref=`. A code is not an address until
   * the server resolves it, so nothing is stored yet and the caller must resolve
   * before calling `applyResolvedCode`.
   */
  | { kind: 'code-pending'; code: string };

export interface CaptureInput {
  /** The URL's query string, e.g. `location.search`. */
  search: string;
  /** `location.pathname`, recorded so a user can see where a link landed. */
  path?: string | null;
  /** Injectable clock so tests are not time-dependent. */
  now?: number;
}

/**
 * Apply a URL to stored attribution under the first-touch rule.
 *
 * Pure with respect to its inputs and total with respect to its outcomes: every
 * branch returns a named outcome, including the two that change nothing, so a
 * caller cannot mistake "we ignored a second link" for "there was no link".
 */
export function captureFromUrl(input: CaptureInput): CaptureOutcome {
  const { search, path = null, now = Date.now() } = input;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { kind: 'none' };
  }

  const rawRef = params.get(REF_PARAM);
  if (rawRef === null) {
    const code = params.get(REF_CODE_PARAM);
    if (code !== null) {
      const trimmed = code.trim().toLowerCase();
      if (REF_CODE_RE.test(trimmed)) return { kind: 'code-pending', code: trimmed };
      return { kind: 'invalid', raw: code };
    }
    return { kind: 'none' };
  }

  const address = normalise(rawRef);
  if (address === null) return { kind: 'invalid', raw: rawRef };

  return applyAddress(address, path, now);
}

/**
 * Store an address that a `?r=<code>` resolved to, under the same first-touch
 * rule as a direct `?ref=`.
 *
 * Separate entry point rather than an option on `captureFromUrl` because
 * resolution is asynchronous and can fail, and a failed resolution must leave
 * attribution exactly as it was — not half-written.
 */
export function applyResolvedCode(
  address: string,
  opts: { path?: string | null; now?: number } = {},
): CaptureOutcome {
  const normalised = normalise(address);
  if (normalised === null) return { kind: 'invalid', raw: address };
  return applyAddress(normalised, opts.path ?? null, opts.now ?? Date.now());
}

function applyAddress(address: string, path: string | null, now: number): CaptureOutcome {
  const existing = readAttribution();

  if (existing === null) {
    safeSetItem(REF_ADDRESS_KEY, address);
    writeMeta({ v: 1, address, capturedAt: now, path, ignored: [] });
    return {
      kind: 'captured',
      attribution: { address, capturedAt: now, path, source: 'link', ignored: [] },
    };
  }

  if (sameAddress(existing.address, address)) {
    return { kind: 'unchanged', attribution: existing };
  }

  // FIRST-TOUCH. The stored address is deliberately not written here — this is
  // the whole rule — but the attempt is recorded so the surface can name it.
  const ignored: IgnoredLink[] = [...existing.ignored, { address, at: now, path }].slice(
    -MAX_IGNORED_RETAINED,
  );

  // `capturedAt` is carried through as-is, INCLUDING null for a legacy record.
  // Stamping `now` on a legacy record would claim the original link arrived at
  // the moment a different link was rejected.
  writeMeta({
    v: 1,
    address: existing.address,
    capturedAt: existing.capturedAt,
    path: existing.path,
    ignored,
  });
  return { kind: 'ignored', attribution: { ...existing, ignored }, ignoredAddress: address };
}

/**
 * Forget attribution entirely.
 *
 * Exposed as an explicit user action — the surface offers it next to the record
 * of who they are attributed to — because the alternative to a user-clearable
 * first-touch lock is a user permanently prefilled with a stranger's address
 * with no way out. Clearing the sidecar alongside the address is mandatory: a
 * surviving sidecar would re-attach its `ignored` list to the next capture and
 * present another link's history as this one's.
 */
export function clearAttribution(): void {
  try {
    localStorage.removeItem(REF_ADDRESS_KEY);
    localStorage.removeItem(REF_META_KEY);
  } catch {
    // Storage unavailable (private mode, SSR). Nothing was stored either.
  }
}

/**
 * True when `candidate` must not be offered as this wallet's referrer.
 *
 * Mirrors ReferralSplitter.setReferrer's own `SelfReferral` revert. Checked here
 * so a self-referral link is refused before it is stored, rather than becoming a
 * prefill that reverts on submit.
 */
export function isSelfReferral(candidate: string, wallet: string | null | undefined): boolean {
  if (!wallet) return false;
  return sameAddress(candidate, wallet);
}
