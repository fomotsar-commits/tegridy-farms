// @vitest-environment node
// rangeEvents.js restates the program's layouts by hand, so this re-derives each from the
// Rust source, re-hashes each discriminator, and holds the program id and the pool offsets to
// the site's own decoder (src/lib/solana/clmm/program.ts), which program.test.ts holds to Rust.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../rangeEvents.js";
import { RANGE_PROGRAM_ID as POSITION_PROGRAM_ID } from "../position.js";
import { AMM_CONFIG_OFFSETS, POOL_STATE_LEN, POOL_STATE_OFFSETS, decodePoolState } from "../../../src/lib/solana/clmm/program";
import { RANGE_PROGRAM_ADDRESS } from "../../../src/lib/solana/clmm/programId";
import { encodePool, key } from "../../../scripts/lib/range-stats-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const SRC = join(REPO, "solana", "tegridy-clmm", "programs", "amm", "src");
const rust = (rel) => readFileSync(join(SRC, rel), "utf8");

/** The fields of a Rust struct, in order, with their types. */
function rustFields(file, name) {
  const body = new RegExp(`pub struct ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(rust(file))?.[1];
  if (!body) throw new Error(`struct ${name} not found in ${file}`);
  return [...body.replace(/\/\/[^\n]*/g, "").matchAll(/pub\s+([a-z_0-9]+)\s*:\s*([^,]+),/g)].map((m) => [m[1], m[2].trim()]);
}
const RUST_TYPE = { Pubkey: "key", u64: "u64", u128: "u128", i32: "i32", u16: "u16", bool: "bool" };
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

describe("the events are the program's", () => {
  // PoolCreatedEvent's Rust names are token_mint_0 and token_vault_0; the decoder says mint0, vault0.
  const RENAME = { tokenMint0: "mint0", tokenMint1: "mint1", tokenVault0: "vault0", tokenVault1: "vault1", poolState: "pool", recipientTokenAccount0: "recipient0", recipientTokenAccount1: "recipient1" };
  it.each(Object.keys(E.EVENTS))("%s: same fields, same order, same widths", (name) => {
    const fields = rustFields("states/pool.rs", name).map(([f, t]) => [RENAME[camel(f)] ?? camel(f), RUST_TYPE[t]]);
    expect(E.EVENTS[name].fields).toEqual(fields);
  });

  it.each(Object.keys(E.EVENTS))("%s: its discriminator is sha256(\"event:%s\"), re-hashed", (name) => {
    expect(E.EVENTS[name].disc).toBe(createHash("sha256").update(`event:${name}`).digest().subarray(0, 8).toString("hex"));
  });

  it("SwapEvent is 221 bytes, as every recorded mainnet swap of the same program is", () => {
    expect(E.eventLength("SwapEvent")).toBe(221);
    const swaps = JSON.parse(readFileSync(join(REPO, "frontend", "src", "lib", "solana", "clmm", "__fixtures__", "mainnet-swaps.json"), "utf8")).swaps;
    expect(swaps.length).toBeGreaterThan(10);
    for (const s of swaps) {
      const ev = E.decodeEvent(E.fromBase64(s.tx.event));
      expect(ev.pool).toBe(s.pool);
      expect(ev.zeroForOne).toBe(s.tx.zeroForOne);
      expect(ev.tradeFee0 + ev.tradeFee1).toBeGreaterThan(0n);
    }
  });

  it("both collections emit the one event, so the instruction's name says whose it was", () => {
    expect(rust("instructions/admin/collect_protocol_fee.rs")).toContain("emit!(CollectProtocolFeeEvent");
    expect(rust("instructions/admin/collect_fund_fee.rs")).toContain("emit!(CollectProtocolFeeEvent");
    const lib = rust("lib.rs");
    expect(lib).toMatch(/pub fn collect_protocol_fee\(/);
    expect(lib).toMatch(/pub fn collect_fund_fee\(/);
    expect(E.COLLECT_BY).toEqual({ CollectProtocolFee: "vault", CollectFundFee: "workshop" });
    // Anchor logs "Instruction: <Name>" unless built with no-log-ix-name, which is not a default.
    expect(rust("../Cargo.toml")).toMatch(/default = \[\]/);
  });

  it("events are logged with emit!, so they live in the log and a cut log can hide one", () => {
    const all = ["instructions/swap.rs", "instructions/swap_v2.rs", "instructions/admin/collect_protocol_fee.rs", "instructions/create_pool.rs"].map(rust).join("\n");
    expect(all).toContain("emit!(SwapEvent");
    expect(all).not.toContain("emit_cpi!");
  });
});

describe("one program id, one pool layout", () => {
  it("is the program's declare_id!, the registry's range-clmm-program, the site's and the position link's", () => {
    const declared = /#\[cfg\(not\(feature = "devnet"\)\)\]\s*declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(rust("lib.rs"))?.[1];
    const registry = JSON.parse(readFileSync(join(REPO, "frontend", "scripts", "addresses.json"), "utf8")).solana.find((r) => r.id === "range-clmm-program").address;
    expect(new Set([E.RANGE_PROGRAM_ID, declared, registry, RANGE_PROGRAM_ADDRESS, POSITION_PROGRAM_ID])).toEqual(new Set(["7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso"]));
  });

  it("reads the pool at the site's offsets, which program.test.ts derives from PoolState", () => {
    const o = POOL_STATE_OFFSETS;
    expect(E.POOL_STATE).toEqual({
      len: POOL_STATE_LEN, disc: E.POOL_STATE.disc, ammConfig: o.ammConfig, mint0: o.tokenMint0, mint1: o.tokenMint1, vault0: o.tokenVault0, vault1: o.tokenVault1,
      decimals0: o.mintDecimals0, decimals1: o.mintDecimals1, tickSpacing: o.tickSpacing, sqrtPriceX64: o.sqrtPriceX64,
      protocolFeesToken0: o.protocolFeesToken0, protocolFeesToken1: o.protocolFeesToken1, fundFeesToken0: o.fundFeesToken0, fundFeesToken1: o.fundFeesToken1,
    });
    expect(E.AMM_CONFIG).toMatchObject({ protocolFeeRate: AMM_CONFIG_OFFSETS.protocolFeeRate, tradeFeeRate: AMM_CONFIG_OFFSETS.tradeFeeRate, fundFeeRate: AMM_CONFIG_OFFSETS.fundFeeRate });
    const fields = { ammConfig: key(2), mint0: key(3), mint1: key(4), vault0: key(5), vault1: key(6), price: 123456789012345678901234n, protocolFees0: 11n, protocolFees1: 2n ** 63n, fundFees0: 7n, fundFees1: 8n, tickSpacing: 60 };
    const bytes = E.fromBase64(encodePool(fields));
    const ours = E.decodePool(bytes);
    const site = decodePoolState(key(1), bytes);
    expect(site).not.toBeNull();
    expect([ours.sqrtPriceX64, ours.protocolFees0, ours.protocolFees1, ours.fundFees0, ours.fundFees1]).toEqual([site.sqrtPriceX64, site.protocolFeesToken0, site.protocolFeesToken1, site.fundFeesToken0, site.fundFeesToken1]);
    expect([ours.ammConfig, ours.mint0, ours.mint1, ours.vault0, ours.vault1, ours.tickSpacing]).toEqual([site.ammConfig, site.tokenMint0, site.tokenMint1, site.tokenVault0, site.tokenVault1, site.tickSpacing]);
    expect(ours.vault1).toBe(fields.vault1);
    expect(() => E.decodePool(bytes.subarray(0, 100))).toThrow(/not a range pool/);
  });

  it("is browser-safe: no import, no Buffer, no process", () => {
    const src = readFileSync(join(HERE, "..", "rangeEvents.js"), "utf8");
    expect(src).not.toMatch(/^\s*import /m);
    expect(src).not.toMatch(/\bBuffer\b|\bprocess\./);
  });
});

describe("frames", () => {
  const P = E.RANGE_PROGRAM_ID;
  it("a data line belongs to the frame the runtime opened last, never to a log line that names us", () => {
    const lines = [
      `Program ${P} invoke [1]`,
      "Program log: Instruction: SwapV2",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
      "Program data: AAAA",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      "Program data: BBBB",
      `Program log: Program ${P} invoke [1]`,
      `Program ${P} success`,
    ];
    expect(E.programFrames(lines, P)).toEqual({ truncated: false, malformed: false, opened: 1, closed: 1, events: [{ ix: "SwapV2", data: "BBBB" }] });
  });

  it("stops at the runtime's cut, even when a line follows it", () => {
    const f = E.programFrames([`Program ${P} invoke [1]`, "Program data: AAAA", "Log truncated", "Program data: BBBB"], P);
    expect([f.truncated, f.opened, f.closed]).toEqual([true, 1, 0]);
  });
});
