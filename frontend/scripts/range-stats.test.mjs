// @vitest-environment node
// The range count's decision cases (scripts/lib/range-stats-cases.mjs), the same ones CI runs
// bare with `node scripts/range-stats.mjs --self-test`, here under vitest with the rest.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CASES, runSelfTest } from "./lib/range-stats-cases.mjs";
import { LIMITS, PAIRING, registryPools } from "./range-stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

describe("range-stats cases", () => {
  for (const [name, fn] of CASES) it(name, fn, 20_000);

  it("the self-test runs every case and says how many passed", async () => {
    const said = [];
    expect(await runSelfTest({ log: (m) => said.push(m), error: (m) => said.push(m) })).toBe(0);
    expect(said.at(-1)).toBe(`${CASES.length} of ${CASES.length} range-stats cases passed`);
  }, 60_000);
});

describe("what the hourly job is held to", () => {
  const workflow = readFileSync(join(REPO, ".github", "workflows", "range-stats.yml"), "utf8");
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");

  it("runs hourly at a minute no other hourly job uses, with no npm install", () => {
    const minute = /cron: "(\d+) \* \* \* \*"/.exec(workflow)?.[1];
    expect(minute).toBeDefined();
    const others = ["venue-volume.yml", "revenue-watch.yml", "error-retention.yml"].map((f) => /cron: "(\d+) \* \* \* \*"/.exec(readFileSync(join(REPO, ".github", "workflows", f), "utf8"))?.[1]);
    expect(others).not.toContain(minute);
    expect(Number(minute) % 15).not.toBe(0);
    const runs = workflow.split("\n").filter((l) => /^\s*(- )?run:/.test(l));
    expect(runs).toEqual(["        run: node frontend/scripts/range-stats.mjs"]);
    expect(workflow).toContain("run: node frontend/scripts/range-stats.mjs");
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: range-stats\s*\n\s*cancel-in-progress: false/);
  });

  it("CI runs the self-test", () => {
    expect(ci).toContain("run: node scripts/range-stats.mjs --self-test");
  });

  it("the registry's range pools are its range-pool-* rows, and the pairing coins are the site's", () => {
    const addresses = JSON.parse(readFileSync(join(HERE, "addresses.json"), "utf8"));
    expect(registryPools({ solana: [{ id: "range-pool-bayla-sol-1", address: "A" }, { id: "range-clmm-program", address: "B" }] })).toEqual(["A"]);
    expect(registryPools(addresses).every((a) => addresses.solana.some((r) => r.address === a))).toBe(true);
    expect(PAIRING).toEqual(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump"]);
    expect(LIMITS).toMatchObject({ maxPools: 40, maxTransactions: 2000 });
  });
});
