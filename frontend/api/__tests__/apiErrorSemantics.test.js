// The published refusal contract and the refusals the server can actually send
// must be the same set, in both directions.
//
// Documentation drift is not cosmetic here. An integrator writes their error
// handling once, off the table on the developer page; a refusal code that ships
// undocumented falls into their `default:` branch, and the default branch of a
// security integration is usually "treat as pass". A documented code that no
// longer exists teaches them to handle a case that will never arrive and hides
// the one that replaced it.
//
// This test is the reason the table lives in apiTiers.js rather than in JSX.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { API_ERROR_SEMANTICS } from '../_lib/apiTiers.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = ['../_lib/apiAuth.js', '../_lib/scannerApi.js', '../v1/index.js'].map((p) =>
  readFileSync(join(here, p), 'utf8'),
);
const ALL_SOURCE = SOURCES.join('\n');

/**
 * Key-MANAGEMENT codes. These answer the wallet-authed dashboard panel, not an
 * integrator's HTTP client, and they are deliberately outside the published
 * contract: an integrator never calls route=keys, and padding their error table
 * with codes they cannot receive makes the ones they can receive harder to find.
 */
const MANAGEMENT_CODES = new Set([
  'origin_not_allowed',
  'not_authenticated',
  'method_not_allowed',
  'missing_id',
  'unknown_action',
  'tier_not_self_serve',
  'key_limit_reached',
  'key_not_found',
]);

/** Every string code the server can put on the wire. */
function emittedCodes() {
  const found = new Set();
  // Object-literal form: `code: "x"` / `code: 'x'`.
  for (const m of ALL_SOURCE.matchAll(/\bcode:\s*['"]([a-z0-9_]+)['"]/g)) found.add(m[1]);
  // Positional form used by apiAuth's `refuse(res, status, code, message)`.
  for (const m of ALL_SOURCE.matchAll(/\brefuse\(\s*res,\s*\d+,\s*['"]([a-z0-9_]+)['"]/g)) found.add(m[1]);
  return found;
}

describe('published refusal contract', () => {
  it('documents every code the server can emit', () => {
    const undocumented = [...emittedCodes()].filter(
      (code) => !MANAGEMENT_CODES.has(code) && !API_ERROR_SEMANTICS.some((row) => row.code === code),
    );
    expect(undocumented, 'refusal codes reachable by an integrator but absent from API_ERROR_SEMANTICS').toEqual([]);
  });

  it('documents no code the server cannot emit', () => {
    const emitted = emittedCodes();
    const phantom = API_ERROR_SEMANTICS.filter((row) => !emitted.has(row.code)).map((r) => r.code);
    expect(phantom, 'documented refusal codes no longer sent by any handler').toEqual([]);
  });

  it('keeps 401 for the caller and 5xx for us, with nothing straddling', () => {
    // The distinction the whole auth layer exists to preserve. A code that meant
    // both would put an integrator and an operator on the same wrong trail.
    const byCode = new Map();
    for (const row of API_ERROR_SEMANTICS) {
      expect(byCode.has(row.code), `duplicate code ${row.code}`).toBe(false);
      byCode.set(row.code, row.status);
    }
    for (const row of API_ERROR_SEMANTICS) {
      if (row.status === 401) expect(row.code).toMatch(/^api_key_/);
      if (row.status >= 500) expect(row.code).not.toMatch(/^api_key_(required|invalid|revoked)$/);
    }
  });

  it('states that the 502 is not a clean scan, in the words a reader will see', () => {
    // This sentence IS the product. It is asserted rather than trusted because a
    // future copy-edit toward something calmer is exactly how it would be lost.
    const upstream = API_ERROR_SEMANTICS.find((r) => r.code === 'upstream_unavailable');
    expect(upstream?.status).toBe(502);
    expect(upstream?.meaning).toMatch(/NO SCAN WAS PERFORMED/);
    expect(upstream?.meaning).toMatch(/not a clean result/i);
  });

  it('marks 422 as the only refusal that is an answer about the address', () => {
    const notAToken = API_ERROR_SEMANTICS.find((r) => r.code === 'not_a_token');
    expect(notAToken?.status).toBe(422);
    expect(notAToken?.meaning).toMatch(/scanned: true/);
    for (const row of API_ERROR_SEMANTICS) {
      if (row.code !== 'not_a_token') expect(row.meaning).not.toMatch(/scanned: true/);
    }
  });
});
