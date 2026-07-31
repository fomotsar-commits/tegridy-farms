import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toEventSelector } from "viem";
import { airlockAbi } from "@whetstone-research/doppler-sdk/evm";
import { assetFromCreateLog, assetsFromLogs } from "../launch-cohort.js";

const word = (addr) => "0".repeat(24) + addr.slice(2);
const log = (addr) => ({ data: "0x" + word(addr) + "0".repeat(64) + "0".repeat(64) });
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";

describe("launch-cohort — Create topic0 must match the deployed Airlock", () => {
  it("the hardcoded topic0 is the one the SDK's own airlockAbi derives", () => {
    // The topic was hand-typed once and was WRONG. Derive it from the SDK ABI so a
    // silently-wrong constant can never ship: a bad topic0 matches no logs, and the
    // cohort would render a confident, permanent "nothing has launched".
    const ev = airlockAbi.find((x) => x.type === "event" && x.name === "Create");
    expect(ev, "airlockAbi must expose a Create event").toBeTruthy();
    const src = readFileSync(join(process.cwd(), "api/_lib/launch-cohort.js"), "utf8");
    const hardcoded = src.match(/CREATE_TOPIC0 = "(0x[0-9a-f]{64})"/)?.[1];
    expect(hardcoded).toBe(toEventSelector(ev));
  });

  it("`asset` really is non-indexed data word 0 — which is what we decode", () => {
    const ev = airlockAbi.find((x) => x.type === "event" && x.name === "Create");
    const nonIndexed = ev.inputs.filter((i) => !i.indexed);
    expect(nonIndexed.findIndex((i) => i.name === "asset")).toBe(0);
    // And the integrator is genuinely absent, which is why provenance needs getAssetData.
    expect(ev.inputs.some((i) => i.name === "integrator")).toBe(false);
  });
});

describe("assetFromCreateLog", () => {
  it("reads the address out of data word 0", () => {
    expect(assetFromCreateLog(log(A))).toBe(A);
  });

  it("rejects a word that is not a clean address (dirty upper bytes)", () => {
    const dirty = { data: "0x" + "1".repeat(24) + A.slice(2) + "0".repeat(128) };
    expect(assetFromCreateLog(dirty)).toBeNull();
  });

  it("rejects truncated, non-hex, and absent data rather than inventing an address", () => {
    expect(assetFromCreateLog({ data: "0x1234" })).toBeNull();
    expect(assetFromCreateLog({ data: "not-hex" })).toBeNull();
    expect(assetFromCreateLog({})).toBeNull();
    expect(assetFromCreateLog(null)).toBeNull();
  });
});

describe("assetsFromLogs", () => {
  it("dedupes case-insensitively and preserves order", () => {
    expect(assetsFromLogs([log(A), log(B), log(A.toUpperCase())])).toEqual([A, B]);
  });

  it("drops malformed entries without dropping the good ones", () => {
    expect(assetsFromLogs([log(A), { data: "0x00" }, log(B)])).toEqual([A, B]);
  });

  it("a non-array is an empty list, never a throw", () => {
    expect(assetsFromLogs(null)).toEqual([]);
    expect(assetsFromLogs("nope")).toEqual([]);
  });
});
