// THE GARDEN LANE — the flagship lane, interface now, dark until the island's first
// certifications close.
//
// "Certified communities launch the certified-soil way once the island's first
// certifications close. Until then the lane shows its promise and stays dark. Build
// isCertified(community) as a stub reading island-published state; THE VENUE NEVER
// SELF-DECLARES CERTIFICATION." — launch-gate spec §1.
//
// That last clause is the whole design constraint, and it is why this file is so small.
// There is no local allowlist, no config flag that can mark a community certified, and
// no admin action that grants it. Certification is a fact about the island's published
// state or it is not a fact at all. Today the island publishes no such endpoint, so the
// honest answer is "not certified, and here is why we cannot say otherwise".

import { certificationEndpoint } from './heatGateConfig';

/** Why the Garden lane is dark, or that it is open. */
export type CertificationState =
  /** The island publishes no certification state yet. The lane shows its promise. */
  | { status: 'not-published'; detail: string }
  /** The island publishes state, and this community is not in it. */
  | { status: 'not-certified'; detail: string }
  /** The island publishes state, and this community is in it. */
  | { status: 'certified'; detail: string }
  /** The endpoint exists but could not be read. Fail-closed, exactly like the gate. */
  | { status: 'unreadable'; detail: string };

/** Hard timeout, matching the oracle client's ceiling. */
const TIMEOUT_MS = 6000;

/**
 * The per-token read path for one community's certification.
 *
 * PATH FORM, NOT A QUERY PARAMETER — Wave 3, phase 06(a). This was
 * `${endpoint}?community=${encodeURIComponent(community)}`, and a query string is the
 * wrong shape for a fact about one subject. It is droppable by a proxy or a redirect,
 * it caches badly, and a request that loses its parameter does not fail cleanly: it
 * asks a DIFFERENT question ("certify what?") and can come back with a body that
 * decodes. The venue's own record route already settled on `/record/:chain/:ca.json`
 * for the same reason.
 *
 * The community is encoded into the SEGMENT, so a slash in the subject cannot silently
 * become a new path segment and ask about something else.
 */
export function certificationPath(endpoint: string, community: string): string {
  return `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(community)}.json`;
}

/**
 * Is this community certified by the island?
 *
 * FAIL-CLOSED in every branch that is not an explicit island YES. An unreachable
 * endpoint, a malformed body, an absent endpoint — none of them certify anybody. The
 * asymmetry is deliberate: a false "certified" is a claim we would be making on the
 * island's behalf, which is exactly what the spec forbids.
 */
export async function isCertified(
  community: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CertificationState> {
  const endpoint = certificationEndpoint();
  if (!endpoint) {
    return {
      status: 'not-published',
      detail:
        'The island has not published certification state yet, so nothing is certified — including this venue’s own communities. The Garden lane opens when the island’s first certifications close.',
    };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);

  try {
    const res = await doFetch(certificationPath(endpoint, community), {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) {
      return { status: 'unreadable', detail: 'The island’s certification list could not be read. Nothing is certified on a failed read.' };
    }
    const body: unknown = await res.json();
    // Only an explicit `certified: true` from the island counts. Anything else — a
    // missing field, a truthy string, a differently-shaped body — is not a yes.
    const certified = !!body && typeof body === 'object' && (body as { certified?: unknown }).certified === true;
    return certified
      ? { status: 'certified', detail: 'The island lists this community as certified.' }
      : { status: 'not-certified', detail: 'The island does not list this community as certified.' };
  } catch {
    return { status: 'unreadable', detail: 'The island’s certification list could not be read. Nothing is certified on a failed read.' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** True only for an explicit island YES. The one boolean a caller may branch on. */
export function isCertifiedState(s: CertificationState): boolean {
  return s.status === 'certified';
}
