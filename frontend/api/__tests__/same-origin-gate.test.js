// The same-origin GET gate — regression pin for AUDIT FIX 2026-08-24.
//
// WHY THIS EXISTS: same-origin browser GET/HEAD requests carry NO Origin header
// (browsers send Origin only for cross-origin requests and non-GET methods).
// runProxy learned this on 2026-07-10 — but every `?resource=` branch dispatches
// BEFORE runProxy and re-implemented the gate as a bare
// `isOriginAllowed(req.headers?.origin || "")`, which 403'd every same-origin
// GET in production: heat (the launch gate), launch-radar, launcher-outcomes,
// alerts, referrals, commerce and airdrop reads were all dead for real users.
//
// WHY NOTHING CAUGHT IT: dev and CI skip the gate entirely (isProdLikeEnv() is
// false there), and every live probe was `curl -H "Origin: https://memetic.fun"`
// — which passes. A hand-set Origin header is precisely the request shape a real
// same-origin browser GET never has. Probe like the browser, or drive the
// browser.
//
// Two layers here:
//   1. Behavior of isRequestOriginAllowed under forced prod-like env.
//   2. A source-scan tripwire: no api/ file may gate on the bare
//      `isOriginAllowed(req.headers…)` shape again — every request-level gate
//      goes through isRequestOriginAllowed so the allowance cannot drift.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isRequestOriginAllowed } from "../_lib/aggregator-proxy.js";

const req = (method, headers = {}) => ({ method, headers });

describe("isRequestOriginAllowed under prod-like env", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows a same-origin browser GET: no Origin, Sec-Fetch-Site same-origin (THE bug)", () => {
    expect(
      isRequestOriginAllowed(req("GET", { "sec-fetch-site": "same-origin" })),
    ).toBe(true);
  });

  it("allows a typed/bookmarked GET: no Origin, Sec-Fetch-Site none", () => {
    expect(isRequestOriginAllowed(req("GET", { "sec-fetch-site": "none" }))).toBe(true);
  });

  it("allows a headerless GET (curl-shape) — rate limits own that lane, Origin never stopped it", () => {
    expect(isRequestOriginAllowed(req("GET", {}))).toBe(true);
  });

  it("rejects a hostile page's no-cors GET: no Origin, Sec-Fetch-Site cross-site", () => {
    expect(
      isRequestOriginAllowed(req("GET", { "sec-fetch-site": "cross-site" })),
    ).toBe(false);
    expect(
      isRequestOriginAllowed(req("GET", { "sec-fetch-site": "same-site" })),
    ).toBe(false);
  });

  it("rejects a GET with a non-allowlisted Origin", () => {
    expect(
      isRequestOriginAllowed(req("GET", { origin: "https://evil.example" })),
    ).toBe(false);
  });

  it("allows a GET with the canonical prod Origin", () => {
    expect(
      isRequestOriginAllowed(req("GET", { origin: "https://memetic.fun" })),
    ).toBe(true);
  });

  it("keeps POST exactly as strict as before: absent Origin is rejected even with Sec-Fetch-Site", () => {
    expect(isRequestOriginAllowed(req("POST", {}))).toBe(false);
    expect(
      isRequestOriginAllowed(req("POST", { "sec-fetch-site": "same-origin" })),
    ).toBe(false);
    expect(
      isRequestOriginAllowed(req("POST", { origin: "https://evil.example" })),
    ).toBe(false);
    expect(
      isRequestOriginAllowed(req("POST", { origin: "https://memetic.fun" })),
    ).toBe(true);
  });
});

// ── Tripwire: the bare gate shape must not return ───────────────────────────
//
// Scans every api/ source file (tests excluded) for `isOriginAllowed(req.headers`
// used as a REQUEST gate. Setting a CORS response header from
// `origin && isOriginAllowed(origin)` is fine and out of scope — the scan targets
// the exact rejected-request shape that caused the outage.

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(HERE, "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

describe("no api/ file gates requests on the bare Origin-header shape", () => {
  it("every request-level origin gate goes through isRequestOriginAllowed", () => {
    const offenders = [];
    for (const file of walk(API_ROOT)) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        const code = line.split("//")[0];
        if (code.includes("isOriginAllowed(req.headers")) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the known resource branches all call the request-level gate", () => {
    const MUST_USE = [
      "_lib/heat.js",
      "_lib/launch-radar.js",
      "_lib/launcher-outcomes.js",
      "_lib/launch-cohort.js",
      "_lib/alerts.js",
      "_lib/referrals.js",
      "_lib/commerce.js",
      "_lib/airdrop.js",
      "_lib/botLink.js",
    ];
    for (const rel of MUST_USE) {
      const src = readFileSync(join(API_ROOT, rel), "utf8");
      expect(src, `${rel} must gate via isRequestOriginAllowed`).toContain(
        "isRequestOriginAllowed(req)",
      );
    }
  });
});
