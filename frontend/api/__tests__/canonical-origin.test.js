import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CANONICAL-ORIGIN GUARD.
//
// memetic.fun is the production domain (see reference_vercel_deploy_procedure), but every
// origin-gated surface under api/ hardcodes a 3-entry allowlist that listed only
// nakamigos.gallery + tegridyfarms.vercel.app, relying on a `process.env.ALLOWED_ORIGIN`
// that is not set in prod. Verified live on 2026-07-30:
//
//   POST https://memetic.fun/api/solrpc   Origin: https://memetic.fun
//   -> HTTP 403 {"error":"Origin not allowed"}
//
// i.e. every browser-side Solana RPC call from the live site was dead, and the same class
// of failure was one env var away on eleven other surfaces. An allowlist that omits your
// own canonical domain is not a security control, it is an outage.
//
// api/auth/siwe.js derives its SIWE `domain` allowlist from this SAME set
// (`[...allowedOriginsSet].map(u => new URL(u).host)`), so the two stay coherent.

const ORIGIN_GATED = [
  "api/alchemy.js",
  "api/analytics.js",
  "api/auth/me.js",
  "api/auth/siwe.js",
  "api/etherscan.js",
  "api/opensea.js",
  "api/orderbook.js",
  "api/solrpc.js",
  "api/supabase-proxy.js",
  "api/v1/index.js",
  "api/_lib/aggregator-proxy.js",
  "api/_lib/launch-cohort.js",
  "api/_lib/launch-radar.js",
  "api/_lib/launcher-outcomes.js",
];

// UNOWNED-ORIGIN GUARD (2026-08-02).
//
// The inverse of the check above, and the more important direction. `nakamigos.gallery`
// sat in the default allowlist of all thirteen surfaces above, and was ALSO the
// `process.env.ALLOWED_ORIGIN` default on four of them — so an origin that did NOT match
// the allowlist was echoed that domain. The R050 audit removed it as a *fallback* and left
// it as an *allowlist entry*, and the comments in auth/siwe.js and auth/me.js then
// described it as absent.
//
// The project does not control that domain. etherscan.js:32-38 already documents this
// exact failure class for `www.tegridyfarms.com` and removed it on those grounds; this is
// the same finding, missed on the other twelve surfaces.
//
// An allowlist entry for a domain you do not own is not a convenience, it is a grant.
const UNOWNED_ORIGINS = ["nakamigos.gallery"];

describe("canonical origin is allowlisted on every origin-gated api surface", () => {
  for (const rel of ORIGIN_GATED) {
    it(`${rel} allows https://memetic.fun`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src).toContain('"https://memetic.fun"');
    });
  }

  it("every file that gates on tegridyfarms.vercel.app also lists memetic.fun", () => {
    // Catches a NEW origin-gated surface added without the canonical domain — the
    // failure mode that produced the live 403, rather than just the twelve known files.
    for (const rel of ORIGIN_GATED) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const gates = /"https:\/\/tegridyfarms\.vercel\.app",/.test(src);
      if (gates) expect(src, `${rel} gates on the vercel origin but omits memetic.fun`).toContain('"https://memetic.fun"');
    }
  });
});

describe("no origin-gated surface admits a domain we do not own", () => {
  for (const rel of ORIGIN_GATED) {
    it(`${rel} does not reference an unowned origin`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      // Strip comments first: the removal notes name the domain deliberately, and a guard
      // that a comment can trip would be reverted the first time it fired spuriously.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      for (const dead of UNOWNED_ORIGINS) {
        expect(code, `${rel} still references ${dead} in executable code`).not.toContain(dead);
      }
    });
  }

  // Origins the project demonstrably controls. The fallback below is handed to origins that
  // are NOT allowlisted, so it must be a domain we own — otherwise a lapsed registration
  // turns into a standing cross-origin grant, which is exactly what happened here.
  // These three are deliberately NOT interchangeable with the allowlist: an origin can be
  // removed from the allowlist and still be a safe fallback, and vice versa.
  const OWNED_ORIGINS = [
    "https://memetic.fun",
    "https://www.memetic.fun",
    "https://tegridyfarms.vercel.app",
  ];

  it("no surface falls back to an origin we do not own, for an UNMATCHED origin", () => {
    // orderbook.js et al do `ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN`, so the
    // ALLOWED_ORIGIN default is echoed to every origin that is NOT on the allowlist.
    // NB this asserts OWNERSHIP, not canonicality: solrpc.js and _lib/aggregator-proxy.js
    // legitimately default to the vercel alias. Making all of them canonical is a separate,
    // behaviour-changing cleanup and does not belong in a security fix.
    let checked = 0;
    for (const rel of ORIGIN_GATED) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const m = src.match(/process\.env\.ALLOWED_ORIGIN\s*\|\|\s*"([^"]+)"/);
      if (m) {
        checked += 1;
        expect(OWNED_ORIGINS, `${rel} defaults unmatched origins to ${m[1]}, which we do not own`)
          .toContain(m[1]);
      }
    }
    // Guard the guard: if the literal-default idiom is refactored away, this test would
    // silently pass having asserted nothing. Six surfaces use it today.
    expect(checked, "no ALLOWED_ORIGIN literal defaults found — has the idiom changed?")
      .toBeGreaterThanOrEqual(5);
  });
});
