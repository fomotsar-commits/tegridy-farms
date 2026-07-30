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
  "api/auth/me.js",
  "api/auth/siwe.js",
  "api/etherscan.js",
  "api/opensea.js",
  "api/orderbook.js",
  "api/solrpc.js",
  "api/supabase-proxy.js",
  "api/v1/index.js",
  "api/_lib/aggregator-proxy.js",
  "api/_lib/launch-radar.js",
  "api/_lib/launcher-outcomes.js",
];

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
