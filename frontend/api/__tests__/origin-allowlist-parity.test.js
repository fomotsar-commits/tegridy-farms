// Origin-allowlist parity across the api/ surface.
//
// WHY: the production origin set is duplicated inline in 13 handlers (each
// builds its own Set/array so there is no shared import to drift against).
// Adding a new prod domain means editing all 13 — and three of them reject
// SERVER-SIDE with a hard 403 rather than merely omitting CORS headers
// (auth/siwe.js, solrpc.js, _lib/aggregator-proxy.js). Miss one of those and
// login / Solana / swap POSTs die on the new domain while every static page
// still renders fine, so the breakage is invisible to a smoke test.
//
// This test exists because that count is a MOVING TARGET: it was 11 handlers
// when memetics.finance was wired on 2026-08-02, and _lib/launch-cohort.js +
// _lib/launch-radar.js had already pushed it to 13. Hand-counting is exactly
// the step that fails silently.
//
// It pins the INVARIANT ("every handler admits the same prod origins"), not a
// literal list: the canonical set is PARSED from launcher-outcomes.js, so
// adding a domain there and nowhere else turns this red, and adding it
// everywhere keeps it green without touching this file.
//
// ⚠ A NEW api/ HANDLER WITH ITS OWN ALLOWLIST MUST BE ADDED TO `MIRRORS`.
// The discovery guard below fails if it spots a hardcoded prod origin in an
// api/ file that this list does not cover, so a new handler cannot silently
// escape the check.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// The file the canonical set is read FROM (a clean top-level array literal).
const CANONICAL_SOURCE = join(API_DIR, "_lib", "launcher-outcomes.js");

// Every other handler that carries its own copy of the prod origin set.
const MIRRORS = [
  "alchemy.js",
  "analytics.js",
  "etherscan.js",
  "opensea.js",
  "orderbook.js",
  "solrpc.js",
  "supabase-proxy.js",
  join("auth", "me.js"),
  join("auth", "siwe.js"),
  join("v1", "index.js"),
  join("_lib", "aggregator-proxy.js"),
  join("_lib", "launch-cohort.js"),
  join("_lib", "launch-radar.js"),
];

function canonicalOrigins() {
  const src = readFileSync(CANONICAL_SOURCE, "utf8");
  const block = src.match(/const ALLOWED_ORIGINS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("could not locate ALLOWED_ORIGINS in launcher-outcomes.js");
  return [...block[1].matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
}

function walkJs(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkJs(full, acc);
    else if (entry.endsWith(".js")) acc.push(full);
  }
  return acc;
}

describe("api origin-allowlist parity", () => {
  const origins = canonicalOrigins();

  it("parses a non-trivial canonical origin set", () => {
    // Guard the guard: a regex that silently matched nothing would make every
    // assertion below vacuously pass.
    expect(origins.length).toBeGreaterThanOrEqual(5);
    expect(origins).toContain("https://memetic.fun");
    expect(origins).toContain("https://memetics.finance");
  });

  for (const rel of MIRRORS) {
    it(`${rel} admits every canonical prod origin`, () => {
      const src = readFileSync(join(API_DIR, rel), "utf8");
      const missing = origins.filter((o) => !src.includes(`"${o}"`));
      expect(missing).toEqual([]);
    });
  }

  it("no api/ file carries an allowlist this test does not cover", () => {
    const covered = new Set([CANONICAL_SOURCE, ...MIRRORS.map((m) => join(API_DIR, m))]);
    // A file "has an allowlist" if it hardcodes the canonical apex origin.
    const uncovered = walkJs(API_DIR)
      .filter((f) => !covered.has(f))
      .filter((f) => readFileSync(f, "utf8").includes('"https://memetic.fun"'))
      .map((f) => relative(API_DIR, f).split(sep).join("/"));
    expect(uncovered).toEqual([]);
  });
});
