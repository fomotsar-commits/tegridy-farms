// AUDIT API-H1 + M (R051): unit coverage for the IP / wallet identity layer
// of the rate limiter.
//
// These tests target the pure functions `extractIp` and `buildRateLimitKey`.
// The Redis path is not exercised here — it's mocked at the integration
// layer (supabase-proxy.test.js).
//
// THREAT MODEL — XFF[0] spoofing
//   Vercel APPENDS the trusted client IP to the end of `x-forwarded-for`.
//   The first entry is whatever the upstream caller sent, which is
//   ATTACKER-CONTROLLED. Trusting XFF[0] lets any client rotate their
//   rate-limit key by sending a different fake IP per request.
//
//   The fix: only ever read `request.ip`, then `x-real-ip`, then XFF[last].

import { describe, it, expect } from "vitest";
import { extractIp, buildRateLimitKey } from "../ratelimit.js";

function makeReq({ ip, headers = {} } = {}) {
  return { ip, headers };
}

describe("extractIp — XFF[0] spoof rejection", () => {
  it("returns request.ip when Vercel runtime provides it", () => {
    const req = makeReq({ ip: "9.9.9.9", headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" } });
    expect(extractIp(req)).toBe("9.9.9.9");
  });

  it("falls back to x-real-ip when request.ip is absent", () => {
    const req = makeReq({ headers: { "x-real-ip": "8.8.8.8", "x-forwarded-for": "1.1.1.1, 2.2.2.2" } });
    expect(extractIp(req)).toBe("8.8.8.8");
  });

  it("returns LAST entry of x-forwarded-for (Vercel appends real IP)", () => {
    // ATTACK: client sends `x-forwarded-for: 1.1.1.1, 2.2.2.2`; Vercel
    // appends real IP `3.3.3.3` → header is `1.1.1.1, 2.2.2.2, 3.3.3.3`.
    // We MUST return `3.3.3.3`, NEVER `1.1.1.1`.
    const req = makeReq({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" } });
    const ip = extractIp(req);
    expect(ip).toBe("3.3.3.3");
    expect(ip).not.toBe("1.1.1.1");
  });

  it("rejects single-entry attacker-only XFF if Vercel didn't append (defense)", () => {
    // If Vercel didn't append (e.g., direct call to a non-Vercel runtime)
    // we still take the last entry. In Vercel prod, the runtime always
    // appends, so XFF[last] is always Vercel-trusted.
    const req = makeReq({ headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(extractIp(req)).toBe("1.1.1.1");
  });

  it("trims whitespace around XFF entries", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "  1.1.1.1 , 2.2.2.2  ,   3.3.3.3 " } });
    expect(extractIp(req)).toBe("3.3.3.3");
  });

  it("ignores empty entries from a malformed XFF", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "1.1.1.1, , ,3.3.3.3" } });
    expect(extractIp(req)).toBe("3.3.3.3");
  });

  it("returns 'unknown' when no IP signal is present", () => {
    expect(extractIp(makeReq())).toBe("unknown");
  });

  it("does NOT take XFF[0] under any circumstances", () => {
    // Spoofing matrix: vary how many fake hops the attacker prepends.
    const cases = [
      { xff: "evil-1, real",                    expected: "real" },
      { xff: "evil-1, evil-2, real",            expected: "real" },
      { xff: "evil-1, evil-2, evil-3, real",    expected: "real" },
    ];
    for (const { xff, expected } of cases) {
      const req = makeReq({ headers: { "x-forwarded-for": xff } });
      expect(extractIp(req)).toBe(expected);
    }
  });
});

describe("buildRateLimitKey — per-wallet keying", () => {
  it("prefers wallet over IP when wallet provided", () => {
    const req = makeReq({ ip: "9.9.9.9" });
    const key = buildRateLimitKey(req, "0xABCDEF1234567890abcdef1234567890ABCDEF12");
    // Wallet should be lowercased so different casings map to one bucket.
    expect(key).toBe("wallet:0xabcdef1234567890abcdef1234567890abcdef12");
  });

  it("falls back to IP namespace when no wallet given", () => {
    const req = makeReq({ ip: "9.9.9.9" });
    expect(buildRateLimitKey(req)).toBe("ip:9.9.9.9");
  });

  it("uses 'ip:' / 'wallet:' prefixes — distinct namespaces", () => {
    // A wallet `9.9.9.9` (impossible, but proves the namespacing) must
    // not collide with an IP `9.9.9.9`.
    const req = makeReq({ ip: "9.9.9.9" });
    const ipKey = buildRateLimitKey(req);
    const walletKey = buildRateLimitKey(req, "9.9.9.9");
    expect(ipKey).not.toBe(walletKey);
    expect(ipKey.startsWith("ip:")).toBe(true);
    expect(walletKey.startsWith("wallet:")).toBe(true);
  });

  it("ignores empty/falsy wallet and falls through to IP", () => {
    const req = makeReq({ ip: "9.9.9.9" });
    expect(buildRateLimitKey(req, "")).toBe("ip:9.9.9.9");
    expect(buildRateLimitKey(req, undefined)).toBe("ip:9.9.9.9");
    expect(buildRateLimitKey(req, null)).toBe("ip:9.9.9.9");
  });

  it("uses the SAME XFF rules as extractIp when falling back", () => {
    // Even when wallet is absent, an attacker-controlled XFF[0] must not
    // be the rate-limit key.
    const req = makeReq({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" } });
    expect(buildRateLimitKey(req)).toBe("ip:3.3.3.3");
  });
});
