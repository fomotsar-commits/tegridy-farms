// THE GARDEN LANE'S READ — Wave 3, phase 06(a).
//
// Two things the wave asked for, and one rail the module already keeps.
//
// 1. PIN THE READ TO A PER-TOKEN PATH FORM, NOT A QUERY PARAMETER. It was
//    `${endpoint}?community=${...}`. A query string is the wrong shape for a fact about
//    one subject: it is trivially droppable by a proxy or a redirect, it caches badly,
//    and a request that loses its parameter does not fail — it asks a DIFFERENT
//    question ("certify what?") and can come back with a body that decodes. The venue's
//    own record route already learned this and serves `/record/:chain/:ca.json`.
//
// 2. The module must never self-declare. Only an explicit island `certified: true`
//    counts; every other outcome — no endpoint, a bad read, a malformed body, a truthy
//    string — is not a yes. That asymmetry is the spec's hard clause and is pinned here
//    so a future "helpful" default cannot soften it.

import { describe, it, expect, vi } from 'vitest';
import { isCertified, isCertifiedState, certificationPath } from './certification';

const COMMUNITY = 'nakamigos';

function okJson(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe('the certification read is a per-token path, not a query parameter', () => {
  it('builds a path-form URL', () => {
    const url = certificationPath('https://island.example/certification', COMMUNITY);
    expect(url).toBe('https://island.example/certification/nakamigos.json');
    expect(url, 'a query parameter is the shape this phase removed').not.toContain('?');
  });

  it('encodes the community into the path segment', () => {
    // A slash in the subject must not silently become a new path segment and ask about
    // something else.
    const url = certificationPath('https://island.example/certification', 'a/b');
    expect(url).toBe('https://island.example/certification/a%2Fb.json');
  });

  it('tolerates a trailing slash on the configured endpoint', () => {
    expect(certificationPath('https://island.example/certification/', COMMUNITY)).toBe(
      'https://island.example/certification/nakamigos.json',
    );
  });

  it('fetches that exact path, with no query string', async () => {
    vi.stubEnv('VITE_ISLAND_CERTIFICATION_URL', 'https://island.example/certification');
    const f = okJson({ certified: true });
    await isCertified(COMMUNITY, { fetchImpl: f as unknown as typeof fetch });
    const called = String((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]);
    expect(called).toBe('https://island.example/certification/nakamigos.json');
    expect(called).not.toContain('?community=');
    vi.unstubAllEnvs();
  });
});

describe('the venue never self-declares certification', () => {
  it('is not certified when the island publishes nothing', async () => {
    vi.unstubAllEnvs();
    const s = await isCertified(COMMUNITY);
    expect(s.status).toBe('not-published');
    expect(isCertifiedState(s)).toBe(false);
  });

  it.each([
    ['a truthy string instead of true', { certified: 'yes' }],
    ['a missing field', { somethingElse: 1 }],
    ['a differently-shaped body', [1, 2, 3]],
  ])('does not accept %s as a yes', async (_label, body) => {
    vi.stubEnv('VITE_ISLAND_CERTIFICATION_URL', 'https://island.example/certification');
    const s = await isCertified(COMMUNITY, { fetchImpl: okJson(body) as unknown as typeof fetch });
    expect(isCertifiedState(s)).toBe(false);
    vi.unstubAllEnvs();
  });

  it('accepts ONLY an explicit certified:true', async () => {
    vi.stubEnv('VITE_ISLAND_CERTIFICATION_URL', 'https://island.example/certification');
    const s = await isCertified(COMMUNITY, { fetchImpl: okJson({ certified: true }) as unknown as typeof fetch });
    expect(s.status).toBe('certified');
    expect(isCertifiedState(s)).toBe(true);
    vi.unstubAllEnvs();
  });

  it('fails closed when the read throws', async () => {
    vi.stubEnv('VITE_ISLAND_CERTIFICATION_URL', 'https://island.example/certification');
    const f = vi.fn(async () => {
      throw new Error('offline');
    });
    const s = await isCertified(COMMUNITY, { fetchImpl: f as unknown as typeof fetch });
    expect(s.status).toBe('unreadable');
    expect(isCertifiedState(s)).toBe(false);
    vi.unstubAllEnvs();
  });
});
