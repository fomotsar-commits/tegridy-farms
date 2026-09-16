// Every rate-limit call in api/ passes a window.
//
// ratelimit.js builds Upstash's sliding window as `${windowSec} s`. A call with
// no windowSec builds "undefined s", which Upstash rejects at request time, so
// the handler answers 500 on every request IN PRODUCTION ONLY: off Vercel the
// in-memory limiter accepts an undefined window without complaint, and nearly
// every handler suite mocks ratelimit.js anyway; the one that does not
// (api/__tests__/launch-radar-outage.test.js) runs the in-memory path, which
// takes it just as silently. That is exactly how
// /api/aggregator?resource=tape shipped broken in wave seven: the unit suite was
// green and every production read failed with "Unable to parse window size:
// undefined s".
//
// No runtime test can see this class, so this one reads the source. Every
// checkRateLimit / checkGlobalLimit call must carry windowSec, inline or through
// a same-file object constant that does (solrpc.js's SOL_RATE_LIMIT is the one
// caller that does it that way). ratelimit.js itself defines and wraps the two
// functions, so it is not a caller.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const API = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "__tests__") return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith(".js") && !name.endsWith(".test.js") ? [full] : [];
  });
}

/** Each call site's full argument text, found by balancing parentheses. */
function callsIn(src) {
  const out = [];
  const re = /\b(checkRateLimit|checkGlobalLimit)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 16), m.index))) continue;
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    out.push({ fn: m[1], text: src.slice(m.index, j + 1), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Inline `windowSec`, or an UPPER_CASE same-file constant whose literal carries it. */
function carriesWindow(call, src) {
  if (/\bwindowSec\b/.test(call)) return true;
  for (const [, name] of call.matchAll(/(?:\.\.\.|,\s*)([A-Z][A-Z0-9_]+)\b/g)) {
    if (new RegExp(`const\\s+${name}\\s*=\\s*\\{[^}]*\\bwindowSec\\b`).test(src)) return true;
  }
  return false;
}

const CALLS = walk(API)
  .filter((file) => !file.endsWith(`${sep}ratelimit.js`))
  .flatMap((file) => {
    const src = readFileSync(file, "utf8");
    return callsIn(src).map((c) => ({ ...c, file: relative(API, file).split(sep).join("/"), ok: carriesWindow(c.text, src) }));
  });

describe("every rate-limit call in api/ passes a window", () => {
  it("finds the calls at all (guards the guard)", () => {
    // 45 call sites at the time of writing. A scanner that silently matched
    // nothing would pass the next test vacuously.
    expect(CALLS.length).toBeGreaterThanOrEqual(40);
    expect(CALLS.some((c) => c.fn === "checkGlobalLimit")).toBe(true);
    expect(CALLS.some((c) => c.fn === "checkRateLimit")).toBe(true);
  });

  it("gives every one of them a windowSec", () => {
    const missing = CALLS.filter((c) => !c.ok).map((c) => `${c.file}:${c.line} ${c.fn}`);
    expect(missing, `rate-limit calls with no window (production would 500):\n${missing.join("\n")}`).toEqual([]);
  });
});
