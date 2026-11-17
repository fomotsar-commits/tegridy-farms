// The house wallet registry (BUILD-SPEC 2.1): the one list of wallets the venue itself
// trades from. The site labels their bids "House", the lending desk leaves them out, the
// volume counter tags their sales and the signer refuses to go live for a wallet not in it.
// This file is also the strict half of the registry: the runtime skips a malformed entry,
// CI refuses one here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import REGISTRY from "./houseRegistry.json";
import { HOUSE_LABEL, createHouseRegistry, houseBidLabel, houseLabel, houseWallets, isHouseWallet } from "./houseRegistry.js";

const HOUSE = "0x8ba1f109551bD432803012645Ac136ddd64DBA72"; // checksummed
const OTHER = "0x" + "b".repeat(40);
const COLLECTIONS = new Set(["junglebay", "gnssart"]);

/** Every way an entry can break the shape the signer, the bot and the site expect. */
function registryProblems(json) {
  const problems = [];
  if (json?.version !== 1) problems.push("version must be 1");
  if (typeof json?.note !== "string" || json.note.trim() === "") problems.push("note must say what the list is");
  if (!Array.isArray(json?.wallets)) return [...problems, "wallets must be a list"];
  const seen = new Set();
  json.wallets.forEach((w, i) => {
    const at = `wallets[${i}]`;
    if (!w || typeof w !== "object") return problems.push(`${at} is not an entry`);
    let checksummed = null;
    try {
      checksummed = getAddress(w.address);
    } catch {
      problems.push(`${at}.address is not an address`);
    }
    if (checksummed && checksummed !== w.address) problems.push(`${at}.address must be checksummed (${checksummed})`);
    if (typeof w.address === "string" && seen.has(w.address.toLowerCase())) problems.push(`${at}.address is listed twice`);
    if (typeof w.address === "string") seen.add(w.address.toLowerCase());
    if (w.label !== "House bidder") problems.push(`${at}.label must be "House bidder"`);
    if (!Array.isArray(w.collections) || w.collections.length === 0 || !w.collections.every((c) => COLLECTIONS.has(c))) {
      problems.push(`${at}.collections must name junglebay and/or gnssart`);
    }
    const day = typeof w.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.since) ? new Date(`${w.since}T00:00:00Z`) : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== w.since) problems.push(`${at}.since must be a real YYYY-MM-DD day`);
    const extra = Object.keys(w).filter((k) => !["address", "label", "collections", "since"].includes(k));
    if (extra.length) problems.push(`${at} has unknown fields: ${extra.join(", ")}`);
  });
  return problems;
}

const entry = (address, over = {}) => ({ address, label: "House bidder", collections: ["junglebay", "gnssart"], since: "2026-11-16", ...over });

describe("houseRegistry.json, as committed", () => {
  it("is the exact shape the signer and the bot read, every entry well formed", () => {
    expect(registryProblems(REGISTRY)).toEqual([]);
    expect(Object.keys(REGISTRY).sort()).toEqual(["note", "version", "wallets"]);
  });

  it("is plain JSON on disk (the signer reads it from git, not through a bundler)", () => {
    const text = readFileSync(join(process.cwd(), "src", "lib", "house", "houseRegistry.json"), "utf8");
    expect(JSON.parse(text)).toEqual(REGISTRY);
  });

  it("the site's helpers read exactly the committed list", () => {
    expect(houseWallets()).toEqual(REGISTRY.wallets.map((w) => w.address.toLowerCase()));
  });

  it("the strict check catches each way an entry can be wrong", () => {
    expect(registryProblems({ version: 1, note: "x", wallets: [entry(HOUSE)] })).toEqual([]);
    expect(registryProblems({ version: 2, note: "x", wallets: [] })).toContain("version must be 1");
    expect(registryProblems({ version: 1, note: "x", wallets: [entry(HOUSE.toLowerCase())] })[0]).toMatch(/checksummed/);
    expect(registryProblems({ version: 1, note: "x", wallets: [entry("0x1234")] })[0]).toMatch(/not an address/);
    expect(registryProblems({ version: 1, note: "x", wallets: [entry(HOUSE), entry(HOUSE)] })[0]).toMatch(/listed twice/);
    expect(registryProblems({ version: 1, note: "x", wallets: [entry(HOUSE, { label: "house" })] })[0]).toMatch(/label/);
    expect(registryProblems({ version: 1, note: "x", wallets: [entry(HOUSE, { collections: ["nakamigos"] })] })[0]).toMatch(/collections/);
    expect(registryProblems({ version: 1, note: "x", wallets: [entry(HOUSE, { since: "2026-02-30" })] })[0]).toMatch(/since/);
    expect(registryProblems({ version: 1, note: "x", wallets: [entry(HOUSE, { key: "0x01" })] })[0]).toMatch(/unknown fields/);
  });
});

describe("with the registry empty (today)", () => {
  it("names no wallet the house, so no page changes", () => {
    expect(houseWallets()).toEqual([]);
    for (const a of [HOUSE, OTHER, HOUSE.toLowerCase(), null, undefined, ""]) {
      expect(isHouseWallet(a)).toBe(false);
      expect(houseLabel(a)).toBeNull();
      expect(houseBidLabel(a, { remaining: 2, chip: "JBAC" })).toBeNull();
    }
  });
});

describe("createHouseRegistry", () => {
  const house = createHouseRegistry({ version: 1, note: "x", wallets: [entry(HOUSE)] });

  it("matches a house wallet in any letter case", () => {
    expect(house.isHouseWallet(HOUSE)).toBe(true);
    expect(house.isHouseWallet(HOUSE.toLowerCase())).toBe(true);
    expect(house.isHouseWallet("0x" + HOUSE.slice(2).toUpperCase())).toBe(true);
    expect(house.houseWallets()).toEqual([HOUSE.toLowerCase()]);
  });

  it("is false for anything that is not a 0x + 40-hex address, even one that contains the house's", () => {
    const junk = [null, undefined, 0, 1n, {}, [], true, "", "0x", HOUSE.slice(0, 41), `${HOUSE}0`, `${HOUSE}`.replace("0x", "0X"), ` ${HOUSE}`, `${HOUSE} `, HOUSE.slice(2), `0x${"g".repeat(40)}`, { address: HOUSE }, [HOUSE]];
    for (const j of junk) expect(house.isHouseWallet(j), String(j)).toBe(false);
    expect(house.isHouseWallet(OTHER)).toBe(false);
  });

  it("an empty or broken registry names no one and never throws", () => {
    for (const json of [undefined, null, 7, "x", {}, { wallets: "x" }, { wallets: [null, 5, "0x1", { address: "junk" }, { address: 12 }] }]) {
      const r = createHouseRegistry(json);
      expect(r.houseWallets()).toEqual([]);
      expect(r.isHouseWallet(HOUSE)).toBe(false);
      expect(r.houseLabel(HOUSE)).toBeNull();
    }
  });

  it("lists a wallet once however often and in whatever case it appears", () => {
    const r = createHouseRegistry({ wallets: [entry(HOUSE), entry(HOUSE.toLowerCase()), entry(OTHER)] });
    expect(r.houseWallets()).toEqual([HOUSE.toLowerCase(), OTHER]);
  });

  it("hands out a copy: a caller cannot add a wallet to the list", () => {
    const list = house.houseWallets();
    list.push(OTHER);
    expect(house.houseWallets()).toEqual([HOUSE.toLowerCase()]);
    expect(house.isHouseWallet(OTHER)).toBe(false);
  });

  it('labels the house "House" and everyone else nothing', () => {
    expect(HOUSE_LABEL).toBe("House");
    expect(house.houseLabel(HOUSE)).toBe("House");
    expect(house.houseLabel(OTHER)).toBeNull();
    expect(house.houseLabel(null)).toBeNull();
  });

  it("names a house collection bid by what it still buys, and never invents the count", () => {
    expect(house.houseBidLabel(HOUSE, { remaining: 2, chip: "JBAC" })).toBe("House · buys 2 (any JBAC)");
    expect(house.houseBidLabel(HOUSE.toLowerCase(), { remaining: "1", chip: "GNSS" })).toBe("House · buys 1 (any GNSS)");
    for (const remaining of [0, -1, 1.5, Number.NaN, null, undefined, "", "two", {}]) {
      expect(house.houseBidLabel(HOUSE, { remaining, chip: "JBAC" }), String(remaining)).toBe("House");
    }
    expect(house.houseBidLabel(HOUSE, { remaining: 2, chip: "" })).toBe("House");
    expect(house.houseBidLabel(HOUSE, { remaining: 2 })).toBe("House");
    expect(house.houseBidLabel(HOUSE)).toBe("House");
    expect(house.houseBidLabel(OTHER, { remaining: 2, chip: "JBAC" })).toBeNull();
  });
});
