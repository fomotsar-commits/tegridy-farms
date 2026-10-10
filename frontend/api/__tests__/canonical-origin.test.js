import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// CANONICAL-ORIGIN GUARD.
//
// memetic.fun was the production domain on 2026-07-30 (see reference_vercel_deploy_procedure),
// but every origin-gated surface under api/ hardcoded a 3-entry allowlist that listed only
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
// The canonical host has since become memetics.finance (#478, 2026-09-12), and on
// 2026-09-20 memetic.fun stopped being this venue at all — see the FOREIGN-HOST GUARD below.
// The lesson above is unchanged; only the name it applies to moved.
//
// api/auth/siwe.js derives its SIWE `domain` allowlist from this SAME set
// (`[...allowedOriginsSet].map(u => new URL(u).host)`), so the two stay coherent.

const CANONICAL = "https://memetics.finance";

const ORIGIN_GATED = [
  "api/alchemy.js",
  "api/analytics.js",
  "api/errors.js",
  "api/auth/me.js",
  "api/auth/siwe.js",
  "api/etherscan.js",
  "api/opensea.js",
  "api/orderbook.js",
  "api/solrpc.js",
  "api/supabase-proxy.js",
  "api/v1/index.js",
  "api/_lib/aggregator-proxy.js",
  "api/_lib/births.js",
  "api/_lib/evm-birth.js",
  "api/_lib/gecko-read.js",
  "api/_lib/heat.js",
  "api/_lib/launch-cohort.js",
  "api/_lib/launch-radar.js",
  "api/_lib/launcher-outcomes.js",
  "api/_lib/pool-market.js",
];

// Comments are stripped before any "does the code mention X" check: the removal notes name
// these domains deliberately, and a guard that a comment can trip would be reverted the
// first time it fired spuriously.
function executableCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

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

// FOREIGN-HOST GUARD (2026-09-23).
//
// The same finding a third time, with a twist: this domain IS ours to register, but not
// ours to serve. Since 2026-09-20 memetic.fun and www.memetic.fun are bound to the
// `memetic-fun-lab-proxy` Vercel project and serve the Island Lab from a Cloudflare Worker.
// The venue must not answer there (the canonical-host law, #478, inverted in
// src/lib/__tests__/canonicalHost.test.ts and synthetic-monitor.yml). But every allowlist
// below still named both hosts — eighteen files, five of them feeding Allow-Credentials — so a page the
// venue does not control could call the Supabase proxy, auth/me, v1 key management and
// the five `?resource=` handlers with Allow-Credentials, and because the SIWE domain list
// is derived from the same set, a message signed FOR memetic.fun was a venue login.
// Verified live before the fix: `OPTIONS /api/auth/me` with `Origin: https://memetic.fun`
// answered `Access-Control-Allow-Origin: https://memetic.fun` + `Allow-Credentials: true`.
//
// Owning a registration is not the test. Serving the page is. The bare host covers `www.`.
const FOREIGN_HOSTS = ["memetic.fun"];

// Origins this deployment actually serves. The fallback below is handed to origins that
// are NOT allowlisted, so it must be one of these — otherwise a lapsed registration, or a
// host re-pointed at someone else's project, turns into a standing cross-origin grant.
// These are deliberately NOT interchangeable with the allowlist: an origin can be removed
// from the allowlist and still be a safe fallback, and vice versa.
//
// memetic.fun was on this list until 2026-09-23 and is exactly the failure it guards
// against: as the ALLOWED_ORIGIN default on four surfaces, an UNMATCHED request from
// memetic.fun was handed its own name back, the allowlist entry by another road.
const VENUE_ORIGINS = [
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
];

function walkJs(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkJs(full, acc);
    else if (entry.endsWith(".js")) acc.push(full);
  }
  return acc;
}

describe("canonical origin is allowlisted on every origin-gated api surface", () => {
  for (const rel of ORIGIN_GATED) {
    it(`${rel} allows ${CANONICAL}`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src).toContain(`"${CANONICAL}"`);
    });
  }

  it("every file that gates on tegridyfarms.vercel.app also lists the canonical origin", () => {
    // Catches a NEW origin-gated surface added without the canonical domain — the
    // failure mode that produced the live 403, rather than just the known files.
    for (const rel of ORIGIN_GATED) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const gates = /"https:\/\/tegridyfarms\.vercel\.app",/.test(src);
      if (gates) expect(src, `${rel} gates on the vercel origin but omits ${CANONICAL}`).toContain(`"${CANONICAL}"`);
    }
  });
});

describe("no origin-gated surface admits a domain we do not own", () => {
  for (const rel of ORIGIN_GATED) {
    it(`${rel} does not reference an unowned origin`, () => {
      const code = executableCode(readFileSync(join(process.cwd(), rel), "utf8"));
      for (const dead of UNOWNED_ORIGINS) {
        expect(code, `${rel} still references ${dead} in executable code`).not.toContain(dead);
      }
    });
  }

  it("no surface falls back to an origin this venue does not serve, for an UNMATCHED origin", () => {
    // orderbook.js et al do `ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN`, so the
    // ALLOWED_ORIGIN default is echoed to every origin that is NOT on the allowlist.
    // NB this asserts the venue SERVES it, not canonicality: solrpc.js and
    // _lib/aggregator-proxy.js legitimately default to the vercel alias. Making all of them
    // canonical is a separate, behaviour-changing cleanup and does not belong in a security fix.
    let checked = 0;
    for (const rel of ORIGIN_GATED) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const m = src.match(/process\.env\.ALLOWED_ORIGIN\s*\|\|\s*"([^"]+)"/);
      if (m) {
        checked += 1;
        expect(VENUE_ORIGINS, `${rel} defaults unmatched origins to ${m[1]}, which this venue does not serve`)
          .toContain(m[1]);
      }
    }
    // Guard the guard: if the literal-default idiom is refactored away, this test would
    // silently pass having asserted nothing. Six surfaces use it today.
    expect(checked, "no ALLOWED_ORIGIN literal defaults found — has the idiom changed?")
      .toBeGreaterThanOrEqual(5);
  });
});

// Behavioural, not textual: a real preflight against every directly routed handler, as
// the browser on memetic.fun would send it. A source scan cannot see an origin arriving
// through a fallback, a derived set or an env default; the response headers can.
const HANDLER_PATHS = [
  "../alchemy.js",
  "../analytics.js",
  "../auth/me.js",
  "../auth/siwe.js",
  "../etherscan.js",
  "../opensea.js",
  "../orderbook.js",
  "../solrpc.js",
  "../supabase-proxy.js",
  "../v1/index.js",
];

// Production shape: no dev localhost widening, the same gate the live site runs. Set
// before the handlers load, because some of them read NODE_ENV at module scope.
vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("VERCEL_ENV", "production");
afterAll(() => {
  vi.unstubAllEnvs();
});

// Loaded here, at collection, where no timeout runs. Inside a test body the first load of
// a handler's graph is on the 5s clock, and it grows with machine load.
const HANDLERS = [];
for (const rel of HANDLER_PATHS) HANDLERS.push([rel, (await import(rel)).default]);

describe("no api surface admits a host that is not this venue (memetic.fun, 2026-09-20)", () => {
  const API_DIR = join(process.cwd(), "api");

  it("no api/ file names memetic.fun in executable code — allowlist, fallback or otherwise", () => {
    // Every api/ file, not just ORIGIN_GATED: a NEW handler with its own copy of an old
    // allowlist is precisely how a removed origin comes back.
    const files = walkJs(API_DIR);
    // Guard the guard: a walk that found nothing would pass vacuously.
    expect(files.length).toBeGreaterThan(ORIGIN_GATED.length);
    const offenders = [];
    for (const f of files) {
      const code = executableCode(readFileSync(f, "utf8"));
      for (const host of FOREIGN_HOSTS) {
        if (code.includes(host)) offenders.push(`${relative(API_DIR, f).split(sep).join("/")} → ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  function preflight(origin) {
    const headers = {};
    const res = {
      statusCode: 0,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json() { return this; },
      end() { return this; },
    };
    const req = {
      method: "OPTIONS",
      query: {},
      body: {},
      headers: { origin, "access-control-request-method": "POST" },
    };
    return { req, res, headers };
  }

  for (const [rel, handler] of HANDLERS) {
    it(`${rel.slice(3)} grants memetic.fun nothing on a preflight`, async () => {
      // Control first: the canonical origin IS granted, so this harness demonstrably
      // reaches the CORS code. Without it a handler that set no headers at all would pass.
      const ok = preflight(CANONICAL);
      await handler(ok.req, ok.res);
      expect(ok.headers["access-control-allow-origin"], `${rel} control`).toBe(CANONICAL);

      for (const origin of ["https://memetic.fun", "https://www.memetic.fun"]) {
        const { req, res, headers } = preflight(origin);
        await handler(req, res);
        expect(headers["access-control-allow-origin"], `${rel} echoed ${origin}`).not.toBe(origin);
        expect(headers["access-control-allow-credentials"], `${rel} credentialed ${origin}`).not.toBe("true");
      }
    });
  }
});
