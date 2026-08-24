// The referrals service-role query stays shape-pinned.
//
// _lib/referrals.js:60 has cited this file by name since the resolve surface
// shipped — but the file did not exist until 2026-08-24, so the "shape-pinned
// by" claim was read-laundering: a safety property asserted in prose with no
// enforcement behind it. This is the enforcement.
//
// WHY THE PIN MATTERS: `resolve` is the table's public face and runs under the
// SERVICE ROLE, which bypasses RLS entirely. The query filter is therefore the
// whole access control: `select=wallet` + `code=eq.<one code>` + `limit=1`
// answers "who owns THIS code" and nothing else. A second service-role query,
// a `select=*`, or a missing eq-filter turns it into an enumeration of every
// referrer's wallet, readable by anyone — the exact shape airdrop.js refuses
// to expose a recipient list for.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "_lib", "referrals.js"), "utf8");

/** Lines of actual code — comments stripped so prose can discuss the ban. */
const CODE = SRC.split("\n")
  .map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
  .join("\n");

describe("referrals service-role surface parity", () => {
  it("exactly one query passes the service key, and it is the pinned resolve shape", () => {
    // The service key appears once in configuration and once at the resolve
    // call site. Any additional `key: cfg.serviceKey` is a new RLS-bypassing
    // query this test exists to refuse.
    const serviceUses = CODE.match(/key:\s*cfg\.serviceKey/g) ?? [];
    expect(serviceUses).toHaveLength(1);
  });

  it("the resolve query selects only the wallet column, filtered to one code, limit 1", () => {
    const pinned = CODE.match(
      /\?select=wallet&code=eq\.\$\{encodeURIComponent\(raw\)\}&limit=1/g,
    ) ?? [];
    expect(pinned, "the pinned resolve query shape changed or disappeared").toHaveLength(1);
  });

  it("no query on the table ever selects *", () => {
    expect(CODE.includes("select=*"), "select=* on referral_codes enumerates every referrer's wallet").toBe(false);
  });

  it("the JWT-scoped queries use the anon key, never the service key", () => {
    // `mine` and `claim` must ride the caller's own SIWE JWT through RLS.
    const anonUses = CODE.match(/key:\s*cfg\.anonKey/g) ?? [];
    expect(anonUses.length).toBeGreaterThanOrEqual(2);
  });
});
