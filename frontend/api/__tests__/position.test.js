// @vitest-environment node
// The range position link, `/position/:id.json`.
//
// Every position NFT keeps this link forever, so the tests that matter most are about the
// ways it ships broken: swallowed by the SPA fallback (200 HTML forever), a link format that
// drifts from what the program writes, a layout that drifts from the program's, and a 404
// for a read that merely failed (a wallet keeps a 404).

import { describe, it, expect, vi, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

import { checkGlobalLimit, checkRateLimit } from "../_lib/ratelimit.js";
import { PLATFORM_TREASURY_VAULT } from "../../src/lib/launcher/solana/curve/program";
import { WORKSHOP_WALLET } from "../../src/lib/launcher/solana/write/plant";
import {
  AMM_CONFIG,
  PERSONAL_POSITION,
  PLACEHOLDER_PROGRAM_ID,
  POOL_STATE,
  MAX_FEE_RATE,
  perMillion,
  POSITION_IMAGE,
  POSITION_NAME,
  POSITION_SYMBOL,
  RANGE_PROGRAM_ID,
  base58,
  buildPositionMetadata,
  decodePool,
  decodeFeeTier,
  decodePosition,
  ISLAND_WORKSHOP,
  TEAM_VAULT,
  feePercent,
  handlePosition,
  isAddress,
  priceAtTick,
  resolveId,
} from "../_lib/position.js";
import { feeCeiling, shareOfSwap, swapShareText } from "../_lib/shareOfSwap.js";

const FE = process.cwd();
const CLMM = resolve(FE, "..", "solana", "tegridy-clmm", "programs", "amm", "src");
const rust = (rel) => readFileSync(join(CLMM, rel), "utf8");

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    removeHeader(k) {
      delete this.headers[k];
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
}
const req = (query, method = "GET") => ({ method, headers: {}, query });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the routing contract: the SPA fallback would otherwise eat this route", () => {
  const vercel = JSON.parse(readFileSync(join(FE, "vercel.json"), "utf8"));
  function sourceToRegex(source) {
    if (/^\/\(\(\?!/.test(source)) return new RegExp("^" + source + "$");
    const body = source
      .split(/(:[A-Za-z_]+\*?)/)
      .map((part) => {
        if (/^:[A-Za-z_]+\*$/.test(part)) return "(.*)";
        if (/^:[A-Za-z_]+$/.test(part)) return "([^/]+?)";
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return new RegExp("^" + body + "$");
  }
  const first = (url) => vercel.rewrites.findIndex((r) => sourceToRegex(r.source).test(url));
  const spa = () => vercel.rewrites.findIndex((r) => r.destination === "/index.html");

  it("a position link, and any malformed /position/ path, reaches the function before the SPA fallback", () => {
    for (const url of ["/position/HmP3ZyJdbJmeYdCQEDdMr8eAeVw3hYm4KNCRtPgwhQ1g.json", "/position/", "/position/abc", "/position/a/b.json"]) {
      const idx = first(url);
      expect(idx, url).toBeGreaterThanOrEqual(0);
      expect(idx, `${url} fell through to the SPA shell`).toBeLessThan(spa());
      expect(vercel.rewrites[idx].destination).toContain("resource=position");
    }
    expect(vercel.rewrites.find((r) => r.source === "/position/:id.json").destination).toContain("id=:id");
  });

  it("is cross-origin readable, with CORS from code only, and its picture is too", () => {
    const block = vercel.headers.find((h) => h.source === "/position/(.*)");
    expect(block.headers).toContainEqual({ key: "Cross-Origin-Resource-Policy", value: "cross-origin" });
    expect(block.headers.some((h) => h.key === "Access-Control-Allow-Origin")).toBe(false);
    const art = vercel.headers.find((h) => h.source === new URL(POSITION_IMAGE).pathname);
    expect(art.headers).toContainEqual({ key: "Cross-Origin-Resource-Policy", value: "cross-origin" });
    // The picture is a real file the site ships.
    expect(readFileSync(join(FE, "public", new URL(POSITION_IMAGE).pathname)).length).toBeGreaterThan(1000);
  });

  it("is not in middleware's matcher, and its branch sits above `const provider` in the catchall", () => {
    expect(readFileSync(join(FE, "middleware.js"), "utf8")).not.toContain("/position");
    const src = readFileSync(join(FE, "api", "aggregator.js"), "utf8");
    const branch = src.indexOf('req.query.resource === "position"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(src.indexOf("const provider = req.query.provider"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("held to the program source", () => {
  it("the program id is the program's declare_id!", () => {
    const lib = rust("lib.rs");
    const declared = /#\[cfg\(not\(feature = "devnet"\)\)\]\s*declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(lib);
    expect(declared?.[1]).toBe(RANGE_PROGRAM_ID);
    // The program deployed 2026-10-21, held by the vault (read on chain: its upgrade authority).
    expect(RANGE_PROGRAM_ID).toBe("7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso");
    expect(RANGE_PROGRAM_ID).not.toBe(PLACEHOLDER_PROGRAM_ID);
  });

  it("the NFT's name, symbol and link are what the program writes, keyed by the position's record", () => {
    const src = rust("instructions/open_position.rs");
    const fn = /fn get_metadata_data\(personal_position_id: Pubkey\)[\s\S]*?\n\}/.exec(src)[0];
    expect(fn).toContain(`String::from("${POSITION_NAME}")`);
    expect(fn).toContain(`String::from("${POSITION_SYMBOL}")`);
    expect(fn).toMatch(/"https:\/\/memetics\.finance\/position\/\{\}\.json",\s*personal_position_id\.to_string\(\)/);
    expect(src).toContain("get_metadata_data(personal_position.key())");
  });

  /** Offsets of the fields read here, recomputed from the Rust struct. */
  function offsets(file, struct, start) {
    const body = new RegExp(`pub struct ${struct}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(rust(file))[1].replace(/\/\/[^\n]*/g, "");
    const width = (t) => {
      const prim = { u8: 1, bool: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, Pubkey: 32 };
      if (prim[t] !== undefined) return prim[t];
      const arr = /^\[(.+);\s*([A-Z_0-9]+)\s*\]$/.exec(t);
      const n = { REWARD_NUM: 3 }[arr?.[2]] ?? Number(arr?.[2]);
      if (arr && Number.isInteger(n)) return width(arr[1].trim()) * n;
      if (t === "RewardInfo") return 169;
      if (t === "PositionRewardInfo") return 24;
      if (t === "DynamicFeeInfo") return 80;
      throw new Error(`unhandled type ${t}`);
    };
    const out = {};
    let o = start;
    for (const f of body.matchAll(/pub\s+([a-z_0-9]+)\s*:\s*([^,]+),/g)) {
      out[f[1]] = o;
      o += width(f[2].trim());
    }
    return { ...out, total: o };
  }
  const disc = (name) => [...createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)];

  it("PersonalPositionState, PoolState and AmmConfig layouts", () => {
    const pos = offsets("states/personal_position.rs", "PersonalPositionState", 8);
    expect([pos.nft_mint, pos.pool_id, pos.tick_lower_index, pos.tick_upper_index, pos.liquidity, pos.total]).toEqual([
      PERSONAL_POSITION.nftMint, PERSONAL_POSITION.poolId, PERSONAL_POSITION.tickLower, PERSONAL_POSITION.tickUpper, PERSONAL_POSITION.liquidity, PERSONAL_POSITION.len,
    ]);
    const pool = offsets("states/pool.rs", "PoolState", 8);
    expect([pool.amm_config, pool.token_mint_0, pool.token_mint_1, pool.mint_decimals_0, pool.mint_decimals_1, pool.tick_spacing, pool.dynamic_fee_info, pool.total]).toEqual([
      POOL_STATE.ammConfig, POOL_STATE.mint0, POOL_STATE.mint1, POOL_STATE.decimals0, POOL_STATE.decimals1, POOL_STATE.tickSpacing, POOL_STATE.dynamicFeeInfo, POOL_STATE.len,
    ]);
    expect(POOL_STATE.dynamicFeeInfoLen).toBe(offsets("states/pool_fee.rs", "DynamicFeeInfo", 0).total);
    // The fee ceiling the page says for a dynamic fee is the program's own.
    expect(rust("states/pool_fee.rs")).toContain(`pub const MAX_FEE_RATE_NUMERATOR: u32 = ${MAX_FEE_RATE.toLocaleString("en-US").replace(/,/g, "_")};`);
    const cfg = offsets("states/config.rs", "AmmConfig", 8);
    expect([cfg.owner, cfg.protocol_fee_rate, cfg.trade_fee_rate, cfg.fund_fee_rate, cfg.fund_owner, cfg.total]).toEqual([
      AMM_CONFIG.owner, AMM_CONFIG.protocolFeeRate, AMM_CONFIG.tradeFeeRate, AMM_CONFIG.fundFeeRate, AMM_CONFIG.fundOwner, AMM_CONFIG.len,
    ]);
    expect(PERSONAL_POSITION.disc).toEqual(disc("PersonalPositionState"));
    expect(POOL_STATE.disc).toEqual(disc("PoolState"));
    expect(AMM_CONFIG.disc).toEqual(disc("AmmConfig"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
const FIX = JSON.parse(readFileSync(join(FE, "api", "__tests__", "__fixtures__", "range-position-mainnet.json"), "utf8"));
const bytes = (gz) => Uint8Array.from(gunzipSync(Buffer.from(gz, "base64")));

describe("real accounts of the live range program whose layout the venue's copy shares", () => {
  const position = decodePosition(bytes(FIX.position.gz));
  const pool = decodePool(bytes(FIX.pool.gz));
  const tier = decodeFeeTier(bytes(FIX.config.gz));
  const fee = tier.tradeFeeRate;
  const nftMintOf = (buf) => new PublicKey(buf.subarray(9, 41)).toBase58();
  /** The fixture's tier with its rates and wallets set: by default, to the island's agreed split. */
  const tierWith = ({ owner = PLATFORM_TREASURY_VAULT, fundOwner = WORKSHOP_WALLET, protocol = 104_000, fund = 56_000 } = {}) => {
    const b = Uint8Array.from(bytes(FIX.config.gz));
    const v = new DataView(b.buffer);
    b.set(owner.toBytes(), 11);
    v.setUint32(43, protocol, true);
    v.setUint32(53, fund, true);
    b.set(fundOwner.toBytes(), 61);
    return decodeFeeTier(b);
  };
  const agreed = () => tierWith();
  /** The fixture pool with a dynamic fee: DynamicFeeInfo's dynamic_fee_control and max_volatility_accumulator. */
  const dynamicPoolBytes = ({ control = 100_000, maxVolatility = 100_000 } = {}) => {
    const b = Uint8Array.from(bytes(FIX.pool.gz));
    const v = new DataView(b.buffer);
    v.setUint32(POOL_STATE.dynamicFeeInfo + 6, control, true);
    v.setUint32(POOL_STATE.dynamicFeeInfo + 10, maxVolatility, true);
    return b;
  };
  const STRANGER = new PublicKey("Stranger11111111111111111111111111111111111");
  const docFor = (t) => buildPositionMetadata({ id: FIX.position.address, position, pool, tier: t });
  const attrsOf = (doc) => Object.fromEntries(doc.attributes.map((a) => [a.trait_type, a.value]));

  it("decode, and agree with each other", () => {
    expect(position.poolId).toBe(FIX.pool.address);
    expect(pool.ammConfig).toBe(FIX.config.address);
    expect(position.tickLower).toBeLessThan(position.tickUpper);
    expect(Math.abs(position.tickLower % pool.tickSpacing)).toBe(0);
    expect(Math.abs(position.tickUpper % pool.tickSpacing)).toBe(0);
    expect(position.liquidity > 0n).toBe(true);
    expect(pool.mint0).toBe("So11111111111111111111111111111111111111112");
    expect([pool.decimals0, pool.decimals1, pool.tickSpacing, fee]).toEqual([9, 6, 120, 10000]);
  });

  it("make a document with the pool, the coins, the range in prices and the fee", () => {
    const doc = buildPositionMetadata({ id: FIX.position.address, position, pool, tier: agreed() });
    expect(doc.name).toBe(POSITION_NAME);
    expect(doc.symbol).toBe(POSITION_SYMBOL);
    expect(doc.image).toBe(POSITION_IMAGE);
    expect(doc.description).toContain("pool of SOL and 98kf…pump, from ");
    expect(doc.description).toContain("pays a 1% fee");
    expect(doc.description).toContain("outside it, it earns nothing");
    expect(doc.description).not.toMatch(/—/);
    const attr = Object.fromEntries(doc.attributes.map((a) => [a.trait_type, a.value]));
    expect(attr.Pool).toBe(FIX.pool.address);
    expect(attr["Lower tick"]).toBe(position.tickLower);
    expect(attr.Liquidity).toBe(position.liquidity.toString());
    expect(attr["Lowest price"]).toMatch(/^[0-9.e+-]+ 98kf…pump per SOL$/);
    expect(Number(attr["Lowest price"].split(" ")[0])).toBeLessThan(Number(attr["Highest price"].split(" ")[0]));
  });

  it("names the one NFT that controls the position, so a copy pointing here cannot pass for it", () => {
    const mint = nftMintOf(bytes(FIX.position.gz));
    expect(position.nftMint).toBe(mint);
    const doc = buildPositionMetadata({ id: FIX.position.address, position, pool, tier: agreed() });
    const attr = Object.fromEntries(doc.attributes.map((a) => [a.trait_type, a.value]));
    expect(attr["NFT mint"]).toBe(mint);
    expect(doc.description).toContain(`Only the NFT with mint ${mint} controls this position; any other NFT showing this page is a copy.`);
    expect(doc.description).not.toContain("Whoever holds this NFT");
  });

  it("says how positions earn and how the venue earns, with the basis, from the tier's own rates and wallets", () => {
    const doc = docFor(agreed());
    expect(doc.description).toContain(
      "Each swap through its range pays a 1% fee: positions in range share 84% of it (0.84% of the swap), split by their liquidity there, and the venue keeps 16% (0.16% of the swap): 10.4% of the fee (0.104% of the swap) to the team’s shared wallet, 5.6% of the fee (0.056% of the swap) to the island’s Workshop.",
    );
    expect(doc.description).not.toMatch(/WARNING/);
    const attr = attrsOf(doc);
    expect([attr["Positions’ share of the fee"], attr["Venue’s share of the fee"], attr["Venue’s cut follows the agreed split"]]).toEqual(["84%", "16%", "Yes"]);
    expect([attr["To the team’s shared wallet"], attr["To the island’s Workshop"]]).toEqual(["10.4% of the fee (0.104% of the swap)", "5.6% of the fee (0.056% of the swap)"]);
    expect([attr["Fee tier owner"], attr["Fund owner"]]).toEqual([TEAM_VAULT, ISLAND_WORKSHOP]);
  });

  it("each share follows the wallet that actually collects it: a stranger as the tier's owner leaves the team nothing", () => {
    const doc = docFor(tierWith({ owner: STRANGER }));
    expect(doc.description.startsWith("WARNING: the venue’s cut of each swap does not follow the agreed split")).toBe(true);
    expect(doc.description).toContain(
      "As this fee tier stands: 0% of the fee (0% of the swap) to the team’s shared wallet, 5.6% of the fee (0.056% of the swap) to the island’s Workshop, 10.4% of the fee (0.104% of the swap) to " + STRANGER.toBase58() + ".",
    );
    const attr = attrsOf(doc);
    expect(attr["To the team’s shared wallet"]).toBe("0% of the fee (0% of the swap)");
    expect(attr[`To another wallet, ${STRANGER.toBase58()}`]).toBe("10.4% of the fee (0.104% of the swap)");
    expect(attr["Venue’s cut follows the agreed split"]).toBe("NO: see the warning");
  });

  it("the vault as fund owner (the program's default) takes the island's share: said first, never as the agreed split", () => {
    const doc = docFor(tierWith({ fundOwner: PLATFORM_TREASURY_VAULT }));
    expect(doc.description.startsWith("WARNING: the venue’s cut of each swap does not follow the agreed split")).toBe(true);
    expect(doc.description).toContain("As this fee tier stands: 16% of the fee (0.16% of the swap) to the team’s shared wallet, 0% of the fee (0% of the swap) to the island’s Workshop.");
    expect(doc.description).not.toContain("all to the team");
    const attr = attrsOf(doc);
    expect([attr["To the team’s shared wallet"], attr["To the island’s Workshop"]]).toEqual(["16% of the fee (0.16% of the swap)", "0% of the fee (0% of the swap)"]);
  });

  it("a pool with a dynamic fee pays the tier's rate and more: every share of the swap is said as a floor, with the program's ceiling", () => {
    const b = dynamicPoolBytes();
    const dynamicPool = decodePool(b);
    expect([pool.dynamicFee, dynamicPool.dynamicFee]).toEqual([false, true]);
    const doc = buildPositionMetadata({ id: FIX.position.address, position, pool: dynamicPool, tier: agreed() });
    expect(doc.description).toContain(
      "Each swap through its range pays a fee of at least 1% (more while the price moves fast, at most 4%): positions in range share 84% of it (at least 0.84% of the swap), split by their liquidity there, and the venue keeps 16% (at least 0.16% of the swap): 10.4% of the fee (at least 0.104% of the swap) to the team’s shared wallet,",
    );
    const attr = attrsOf(doc);
    expect([attr["Swap fee"], attr["To the island’s Workshop"]]).toEqual(["at least 1%, at most 4%", "5.6% of the fee (at least 0.056% of the swap)"]);
    expect(attrsOf(docFor(agreed()))["Swap fee"]).toBe("1%");
  });

  it("a real share too small for four decimals of a percent is said as under that, never as 0%", () => {
    expect([perMillion(0), perMillion(1), perMillion(0.01), perMillion(8_400)]).toEqual(["0%", "0.0001%", "<0.0001%", "0.84%"]);
    const doc = docFor(tierWith({ protocol: 1 }));
    expect(doc.description).toContain("0.0001% of the fee (<0.0001% of the swap) to the team’s shared wallet");
  });

  it("a share of the swap: what positions get rounds DOWN, what is taken from them rounds UP", () => {
    expect([shareOfSwap(0, 840_000, "positions"), shareOfSwap(1, 1, "deduction"), shareOfSwap(3_333, 840_000, "positions"), shareOfSwap(3_333, 160_000, "deduction"), shareOfSwap(10_000, 840_000, "positions")]).toEqual([
      "0%", "<0.0001%", "0.2799%", "0.0534%", "0.84%",
    ]);
    // An agreed tier at 0.3333%: positions 0.279972% of each swap (said 0.2799%), the venue
    // 0.053328% (0.0534%), the team 0.0346632% (0.0347%), the Workshop 0.0186648% (0.0187%).
    const doc = docFor({ ...agreed(), tradeFeeRate: 3_333 });
    const shown = [...doc.description.matchAll(/\(([0-9.]+)% of the swap\)/g)].map((m) => Number(m[1]));
    expect(shown).toHaveLength(4);
    const [positions, venue, team, workshop] = shown;
    const exact = (share) => (3_333 * share) / 1_000_000 / 10_000;
    expect(positions).toBe(0.2799);
    expect(positions <= exact(840_000) && positions > exact(840_000) - 0.0001).toBe(true);
    for (const [got, share] of [[venue, 160_000], [team, 104_000], [workshop, 56_000]]) {
      expect(got >= exact(share) && got < exact(share) + 0.0001, String(share)).toBe(true);
    }
    const attr = attrsOf(doc);
    expect([attr["To the team’s shared wallet"], attr["To the island’s Workshop"]]).toEqual(["10.4% of the fee (0.0347% of the swap)", "5.6% of the fee (0.0187% of the swap)"]);
  });

  it("a dynamic pool on a 0% tier pays the dynamic part alone: each share reads from 0% up to the ceiling, never a flat 0%", () => {
    const b = dynamicPoolBytes();
    const doc = buildPositionMetadata({ id: FIX.position.address, position, pool: decodePool(b), tier: { ...agreed(), tradeFeeRate: 0 } });
    expect(doc.description).toContain("pays a fee of 0% to 4%, rising while the price moves fast: positions in range share 84% of it (0% to 3.36% of the swap)");
    expect(doc.description).toContain("the venue keeps 16% (0% to 0.64% of the swap): 10.4% of the fee (0% to 0.416% of the swap) to the team’s shared wallet");
    expect(doc.description).not.toMatch(/\(0% of the swap\)/);
    expect(attrsOf(doc)["Swap fee"]).toBe("0% to 4%");
  });

  it("on a dynamic pool, a wallet that gets nothing is said to get 0%, and a sliver as more than 0%, never 'at least 0%'", () => {
    const b = dynamicPoolBytes();
    const dynamicPool = decodePool(b);
    const stranger = buildPositionMetadata({ id: FIX.position.address, position, pool: dynamicPool, tier: tierWith({ owner: STRANGER }) });
    expect(stranger.description).toContain("0% of the fee (0% of the swap) to the team’s shared wallet");
    expect(stranger.description).not.toMatch(/at least 0%|at least <0\.0001%/);
    const sliver = buildPositionMetadata({ id: FIX.position.address, position, pool: dynamicPool, tier: tierWith({ protocol: 1 }) });
    expect(sliver.description).toContain("0.0001% of the fee (more than 0% of the swap) to the team’s shared wallet");
  });

  it("a 4% tier on a dynamic pool is already at the program's ceiling: said as a plain 4%, never 'at least 4% … at most 4%'", () => {
    const b = dynamicPoolBytes();
    const doc = buildPositionMetadata({ id: FIX.position.address, position, pool: decodePool(b), tier: { ...agreed(), tradeFeeRate: MAX_FEE_RATE } });
    expect(doc.description).toContain("pays a 4% fee:");
    expect(doc.description).not.toContain("at least 4%");
    expect(attrsOf(doc)["Swap fee"]).toBe("4%");
  });

  it("the top of a dynamic fee is the pool's OWN ceiling, from its DynamicFeeInfo, not always the program's 4%", () => {
    // control 10,000 and max volatility 1,000 at spacing 120: ceil(1e4 x (1e3 x 120)^2 / 1e13) = 15 per million.
    const low = decodePool(dynamicPoolBytes({ control: 10_000, maxVolatility: 1_000 }));
    expect([low.dynamicFeeControl, low.maxVolatilityAccumulator, low.tickSpacing]).toEqual([10_000, 1_000, 120]);
    expect(feeCeiling(10_000, low, low.tickSpacing)).toBe(10_015);
    const one = buildPositionMetadata({ id: FIX.position.address, position, pool: low, tier: agreed() });
    expect(one.description).toContain("pays a fee of at least 1% (more while the price moves fast, at most 1.0015%)");
    expect(attrsOf(one)["Swap fee"]).toBe("at least 1%, at most 1.0015%");
    const zero = buildPositionMetadata({ id: FIX.position.address, position, pool: low, tier: { ...agreed(), tradeFeeRate: 0 } });
    expect(zero.description).toContain("pays a fee of 0% to 0.0015%, rising while the price moves fast: positions in range share 84% of it (0% to 0.0012% of the swap)");
    expect(zero.description).not.toContain("to 4%");
    // A ceiling so low that a share of it is a sliver: "0% to under 0.0001%", never "0% to <0.0001%".
    const sliver = decodePool(dynamicPoolBytes({ control: 1, maxVolatility: 100 }));
    expect(feeCeiling(0, sliver, sliver.tickSpacing)).toBe(1);
    expect(buildPositionMetadata({ id: FIX.position.address, position, pool: sliver, tier: { ...agreed(), tradeFeeRate: 0 } }).description).toContain("(0% to under 0.0001% of the swap)");
  });

  it("the ceiling is the program's own sum: swap.rs compute_dynamic_fee_rate and get_total_fee_rate, with pool_fee.rs's constants", () => {
    const swap = rust("instructions/swap.rs");
    const fee = rust("states/pool_fee.rs");
    expect(fee).toContain("pub const VOLATILITY_ACCUMULATOR_SCALE: u16 = 10_000;");
    expect(fee).toContain("pub const DYNAMIC_FEE_CONTROL_DENOMINATOR: u32 = 100_000;");
    const dyn = /fn compute_dynamic_fee_rate\([\s\S]*?\n {4}\}/.exec(swap)[0];
    expect(dyn).toContain("dynamic_fee_info.volatility_accumulator * tick_spacing as u32");
    expect(dyn).toContain("u64::from(crossed) * u64::from(crossed)");
    expect(dyn).toMatch(/U128::from\(DYNAMIC_FEE_CONTROL_DENOMINATOR\)\s*\*\s*U128::from\(VOLATILITY_ACCUMULATOR_SCALE\)\s*\*\s*U128::from\(VOLATILITY_ACCUMULATOR_SCALE\)/);
    expect(dyn).toContain(".mul_div_ceil(U128::from(squared), denominator)");
    expect(dyn).toMatch(/if fee_rate > MAX_FEE_RATE_NUMERATOR as u128 \{\s*Ok\(MAX_FEE_RATE_NUMERATOR\)/);
    const total = /fn get_total_fee_rate\([\s\S]*?\n {4}\}/.exec(swap)[0];
    expect(total).toContain("let total_fee_rate = self.base_fee_rate + dynamic_fee_rate;");
    expect(total).toContain("total_fee_rate.min(MAX_FEE_RATE_NUMERATOR)");
    // The volatility accumulator is capped at max_volatility_accumulator, so that is its top.
    expect(fee).toMatch(/max_volatility_accumulator/);
    // Worked by hand: control 100,000, (100,000 x 120)^2 = 1.44e14 -> 1.44e6, capped at 40,000; the total capped too.
    expect([feeCeiling(10_000, { dynamicFeeControl: 100_000, maxVolatilityAccumulator: 100_000 }, 120), feeCeiling(10_000, null, 120)]).toEqual([40_000, null]);
  });

  it("an input that is not a real rate is refused, never read as 0%", () => {
    for (const bad of [NaN, -1, undefined, Infinity, "1"]) expect(() => shareOfSwap(bad, 840_000, "positions"), String(bad)).toThrow(RangeError);
    expect(() => shareOfSwap(10_000, NaN, "deduction")).toThrow(RangeError);
    expect(() => shareOfSwap(10_000, 840_000, "position")).toThrow(RangeError);
    expect(() => feeCeiling(10_000, { dynamicFeeControl: NaN, maxVolatilityAccumulator: 1 }, 120)).toThrow(RangeError);
    expect(() => swapShareText(10_000, 840_000, "positions", -5)).toThrow(RangeError);
  });

  it("the WARNING list at 0.3333%: each wallet's cut of the swap rounded UP", () => {
    const doc = docFor({ ...tierWith({ owner: STRANGER }), tradeFeeRate: 3_333 });
    expect(doc.description.startsWith("WARNING:")).toBe(true);
    expect(doc.description).toContain("0% of the fee (0% of the swap) to the team’s shared wallet, 5.6% of the fee (0.0187% of the swap) to the island’s Workshop, 10.4% of the fee (0.0347% of the swap) to " + STRANGER.toBase58());
  });

  it("the agreed wallets at other rates are not the agreed split either", () => {
    for (const rates of [{ protocol: 160_000, fund: 0 }, { protocol: 104_000, fund: 96_000 }, { protocol: 0, fund: 56_000 }]) {
      const doc = docFor(tierWith(rates));
      expect(doc.description.startsWith("WARNING: the venue’s cut of each swap does not follow the agreed split"), JSON.stringify(rates)).toBe(true);
    }
  });

  it("a tier that pays any other wallet is said first, as a warning naming it", () => {
    // The live fixture is Raydium's own tier: both its wallets are Raydium's.
    const doc = docFor(tier);
    expect(doc.description.startsWith("WARNING: the venue’s cut of each swap does not follow the agreed split")).toBe(true);
    expect(doc.description).toContain(tier.owner);
    expect(doc.description).toContain(tier.fundOwner);
  });

  it("the agreed wallets are the site's own", () => {
    expect(TEAM_VAULT).toBe(PLATFORM_TREASURY_VAULT.toBase58());
    expect(ISLAND_WORKSHOP).toBe(WORKSHOP_WALLET.toBase58());
  });
});

describe("numbers are never written as zero", () => {
  it("a tiny price keeps its digits", () => {
    expect(priceAtTick(-400000, 9, 6)).toMatch(/e-/);
    expect(priceAtTick(-400000, 9, 6)).not.toBe("0");
    expect(priceAtTick(0, 6, 6)).toBe("1");
  });
  it("fees as exact percents", () => {
    expect([feePercent(10000), feePercent(2500), feePercent(100), feePercent(400000)]).toEqual(["1%", "0.25%", "0.01%", "40%"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("which link is asked for", () => {
  const id = FIX.position.address;
  it("takes the id from either rewrite, with or without .json", () => {
    expect(resolveId({ id })).toBe(id);
    expect(resolveId({ id: `${id}.json` })).toBe(id);
    expect(resolveId({ path: `${id}.json` })).toBe(id);
  });
  it("refuses arrays, extra segments and strings that are not 32-byte addresses", () => {
    expect(resolveId({ id: [id, id] })).toBeNull();
    expect(resolveId({ path: `a/${id}.json` })).toBeNull();
    expect(resolveId({ id: "0xabc" })).toBeNull();
    expect(resolveId({ id: "1111" })).toBeNull();
    expect(isAddress("11111111111111111111111111111111")).toBe(true);
    expect(base58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
});

describe("the handler", () => {
  const OURS = base58(randomBytes(32)); // a stand-in id for "our program, deployed"
  const id = FIX.position.address;
  /** An RPC that answers getMultipleAccounts from a table, as if `OURS` owned the recording. */
  function stubAccounts(table, { fail = false } = {}) {
    const fetch = vi.fn(async (_url, init) => {
      if (fail) return { ok: false, status: 502, json: async () => ({}) };
      const body = JSON.parse(init.body);
      expect(body.method).toBe("getMultipleAccounts");
      const value = body.params[0].map((a) => (table[a] ? { owner: table[a].owner, lamports: 1, data: [Buffer.from(table[a].data).toString("base64"), "base64"] } : null));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }) };
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  const table = (owner = OURS) => ({
    [FIX.position.address]: { owner, data: bytes(FIX.position.gz) },
    [FIX.pool.address]: { owner, data: bytes(FIX.pool.gz) },
    [FIX.config.address]: { owner, data: bytes(FIX.config.gz) },
  });

  it("while the program id is the placeholder, every link is a 404, and the chain is not asked", async () => {
    const fetch = stubAccounts(table());
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: PLACEHOLDER_PROGRAM_ID });
    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toContain("application/json");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(fetch).not.toHaveBeenCalled();
    // It names the program it serves: a check against the deployed id sees the placeholder.
    expect(res.body.program).toBe(PLACEHOLDER_PROGRAM_ID);
  });

  it("as served, a random address answers the deploy page's 404 for the deployed program, asking the chain", async () => {
    const fetch = stubAccounts({});
    const res = mockRes();
    await handlePosition(req({ id: `${id}.json` }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "No range position at this address.", program: "7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso" });
    expect(fetch).toHaveBeenCalled();
  });

  it("a deployed program's position answers 200 JSON, publicly, with a short edge cache", async () => {
    stubAccounts(table());
    const res = mockRes();
    await handlePosition(req({ id: `${id}.json` }), res, { programId: OURS });
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe(POSITION_NAME);
    expect(res.body.position).toBe(id);
    expect(res.headers["Cache-Control"]).toBe("s-maxage=60, stale-while-revalidate=600");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("an address with no account is a 404 cached for seconds only: a position may be a moment old", async () => {
    stubAccounts({});
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(404);
    expect(res.headers["Cache-Control"]).toBe("s-maxage=15");
    // Exactly this body: the deploy pack's page asks a random address and checks both fields
    // before every fee-tier approval, so a link serving any other program is refused there.
    expect(res.body).toEqual({ error: "No range position at this address.", program: OURS });
  });

  it("an account another program owns is not a position here", async () => {
    stubAccounts(table("11111111111111111111111111111111"));
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(404);
    expect(res.body.program).toBe(OURS);
  });

  it("a failed read is a 503 that is never cached, and never a document with gaps", async () => {
    stubAccounts(table(), { fail: true });
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const missingPool = table();
    delete missingPool[FIX.pool.address];
    stubAccounts(missingPool);
    const res2 = mockRes();
    await handlePosition(req({ id }), res2, { programId: OURS });
    expect(res2.statusCode).toBe(503);
  });

  it("a malformed link is a 400 before any limiter is charged", async () => {
    const res = mockRes();
    await handlePosition(req({ id: "not-an-address" }), res, { programId: OURS });
    expect(res.statusCode).toBe(400);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(checkGlobalLimit).not.toHaveBeenCalled();
  });

  it("each caller has its own bucket ahead of the shared breaker: one caller spent out cannot drain it", async () => {
    const fetch = stubAccounts({});
    vi.mocked(checkRateLimit).mockImplementationOnce(async (_req, r) => {
      r.status(429).json({ error: "Too many requests" });
      return false;
    });
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(429);
    expect(vi.mocked(checkRateLimit).mock.calls[0][2]).toMatchObject({ identifier: "position-ip", windowSec: 60 });
    expect(checkGlobalLimit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("a caller's rate headers never ride on a document the edge keeps for others", async () => {
    stubAccounts(table());
    vi.mocked(checkRateLimit).mockImplementationOnce(async (_req, r) => {
      r.setHeader("X-RateLimit-Limit", "60");
      r.setHeader("X-RateLimit-Remaining", "59");
      r.setHeader("X-RateLimit-Reset", "1");
      return true;
    });
    const res = mockRes();
    await handlePosition(req({ id }), res, { programId: OURS });
    expect(res.statusCode).toBe(200);
    // The caller's limiter ran and set its counts: the document still carries none of them.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(Object.keys(res.headers).filter((h) => h.startsWith("X-RateLimit"))).toEqual([]);
    expect(res.headers["Cache-Control"]).toBe("s-maxage=60, stale-while-revalidate=600");
  });

  it("refuses a malformed link, other methods, and answers a preflight", async () => {
    const bad = mockRes();
    await handlePosition(req({ id: "not-an-address" }), bad, { programId: OURS });
    expect(bad.statusCode).toBe(400);
    const post = mockRes();
    await handlePosition(req({ id }, "POST"), post, { programId: OURS });
    expect(post.statusCode).toBe(405);
    const pre = mockRes();
    await handlePosition(req({ id }, "OPTIONS"), pre, { programId: OURS });
    expect(pre.statusCode).toBe(200);
  });
});
