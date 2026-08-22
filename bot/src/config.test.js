import { describe, it, expect } from "vitest";
import { loadConfig, fatalConfigProblems, describeCapabilities } from "./config.js";

const base = { TELEGRAM_BOT_TOKEN: "t", BOT_LINK_SECRET: "s" };

describe("the two variables without which there is no bot", () => {
  it("refuses to boot with no token", () => {
    expect(fatalConfigProblems(loadConfig({ BOT_LINK_SECRET: "s" }))).toHaveLength(1);
  });

  it("refuses to boot with no link secret, naming the reason", () => {
    // Not cosmetic: with no secret every chat derives the same chat_ref, which
    // would bind unrelated users onto one wallet.
    const [problem] = fatalConfigProblems(loadConfig({ TELEGRAM_BOT_TOKEN: "t" }));
    expect(problem).toMatch(/same chat_ref/);
  });

  it("boots with both", () => {
    expect(fatalConfigProblems(loadConfig(base))).toEqual([]);
  });
});

describe("origins are parsed, not trusted", () => {
  it("strips a trailing path and slash", () => {
    expect(loadConfig({ ...base, APP_ORIGIN: "https://memetic.fun/app/" }).appOrigin).toBe("https://memetic.fun/app");
  });

  it("rejects a non-http scheme rather than letting it reach a fetch", () => {
    expect(loadConfig({ ...base, INDEXER_URL: "javascript:alert(1)" }).indexerUrl).toBeNull();
  });

  it("rejects an unparseable value", () => {
    expect(loadConfig({ ...base, INDEXER_URL: "not a url" }).indexerUrl).toBeNull();
  });

  it("defaults the venue and app origins rather than producing an undefined URL", () => {
    const cfg = loadConfig(base);
    expect(cfg.venueOrigin).toBe("https://memetic.fun");
    expect(cfg.appOrigin).toBe("https://memetic.fun");
  });
});

const capsOf = (env) => Object.fromEntries(describeCapabilities(loadConfig(env)).map((c) => [c.id, c]));

describe("capabilities are a tri-state, and the off states say which one they are", () => {
  it("indexed reads are OFF and say the venue hosts no indexer", () => {
    const cap = capsOf(base).indexed;
    expect(cap.available).toBe(false);
    expect(cap.detail).toMatch(/no indexer is hosted/i);
    // The distinction that matters: not "you have no history".
    expect(cap.detail).toMatch(/not.*answered as zero/i);
  });

  it("a MISCONFIGURED indexer URL reads differently from an absent one", () => {
    // One needs an operator to fix a typo, the other needs nobody to do anything.
    // Collapsing them sends an operator hunting an outage that is not happening.
    const cap = capsOf({ ...base, INDEXER_URL: "wat" }).indexed;
    expect(cap.available).toBe(false);
    expect(cap.detail).toMatch(/misconfiguration/i);
  });

  it("indexed reads turn ON when a real URL is set, with the ready-gate stated", () => {
    const cap = capsOf({ ...base, INDEXER_URL: "https://idx.example.com" }).indexed;
    expect(cap.available).toBe(true);
    expect(cap.detail).toMatch(/backfill complete/i);
  });

  it("in-chat execution is off and is NOT reachable by setting a variable", () => {
    // The one capability that must never become configurable. An operator who can
    // switch this on with an env var is an operator who will.
    const withEverything = capsOf({
      ...base,
      INDEXER_URL: "https://idx.example.com",
      ENABLE_TRADING: "1",
      KEEPER_URL: "https://keeper.example.com",
      EXECUTION_ENABLED: "true",
    });
    expect(withEverything.execution.available).toBe(false);
    expect(withEverything.execution.detail).toMatch(/holds no key/i);
  });
});
