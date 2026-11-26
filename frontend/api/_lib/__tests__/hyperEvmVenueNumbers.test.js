// @vitest-environment node
// HyperEVM in the venue's numbers: no volume source and no TVL row until our V3 venue is
// deployed, then both, read off our own pools only. The server's copy of the record is held
// to the site's, so the two sides never disagree on whether HyperEVM is counted.
import { describe, it, expect } from "vitest";
import { encodeAbiParameters } from "viem";
import { EVM_CHAINS, HYPEREVM_V3, V3_SWAP_TOPIC, evmRpcsFor, hyperEvmCounted, listV3Pools, readHyperEvm, v3SwapLeg } from "../../../scripts/lib/venue-volume-chain.mjs";
import { legUsd } from "../../../scripts/venue-volume.mjs";
import { VOLUME_SOURCES, summarize, volumeSources } from "../venueVolumePolicy.js";
import { readHyperEvmTvl, tvlChainNames } from "../venueTvl.js";
import { HYPEREVM_DEPLOYMENT } from "../../../src/lib/chains/hyperEvmDeployment.ts";
import { HYPEREVM_TOKENS } from "../../../src/lib/chains/hyperEvm.ts";
import { parseVenueTvl, tvlChains } from "../../../src/lib/venueTvl.ts";

const FACTORY = "0x1000000000000000000000000000000000000001";
const DEPLOYED = { ...HYPEREVM_V3, factory: FACTORY, startBlock: 100 };
const WHYPE = HYPEREVM_V3.coins[0];
const USDT0 = HYPEREVM_V3.coins[1];
const POOL = "0x2000000000000000000000000000000000000002";

describe("the server's HyperEVM record", () => {
  it("is the site's: the same factory and the same pool coins", () => {
    expect(HYPEREVM_V3.factory).toBe(HYPEREVM_DEPLOYMENT.factory);
    expect(HYPEREVM_V3.coins.map((c) => [c.address, c.decimals])).toEqual(HYPEREVM_TOKENS.filter((t) => !t.isNative).map((t) => [t.address, t.decimals]));
  });

  it("is not counted until the factory and its first block are set", () => {
    expect(hyperEvmCounted({ ...HYPEREVM_V3, factory: null, startBlock: null })).toBe(false);
    expect(hyperEvmCounted({ ...HYPEREVM_V3, factory: FACTORY, startBlock: null })).toBe(false);
    expect(hyperEvmCounted({ ...HYPEREVM_V3, factory: null, startBlock: 1 })).toBe(false);
    expect(hyperEvmCounted({ ...HYPEREVM_V3, factory: "0x" + "0".repeat(40), startBlock: 1 })).toBe(false);
    expect(hyperEvmCounted(DEPLOYED)).toBe(true);
  });

  it("is counted as committed: deployed 2026-11-25, from the factory's own block", () => {
    expect(HYPEREVM_V3.factory).toBe("0xcaDc93E96De58EA554c71ca609974625615E046D");
    expect(HYPEREVM_V3.startBlock).toBe(52183228);
    expect(hyperEvmCounted()).toBe(true);
  });
});

describe("the volume total", () => {
  const row = (source) => ({ source, usd: 1, swaps: 1, unpriced: 0, counted_to: "2026-11-20T00:00:00Z", last_ok_at: "2026-11-20T00:00:00Z" });

  it("has no HyperEVM source while it is not deployed, so the total still reads", () => {
    expect(volumeSources(false)).toBe(VOLUME_SOURCES);
    expect(VOLUME_SOURCES).not.toContain("hyperevm");
    expect(summarize(VOLUME_SOURCES.map(row), Date.parse("2026-11-20T01:00:00Z")).state).toBe("current");
  });

  it("names HyperEVM once deployed, and a total without its row is unread, never short", () => {
    const sources = volumeSources(true);
    expect(sources).toEqual([...VOLUME_SOURCES, "hyperevm"]);
    const now = Date.parse("2026-11-20T01:00:00Z");
    expect(summarize(VOLUME_SOURCES.map(row), now, sources)).toEqual({ state: "unread" });
    expect(summarize(sources.map(row), now, sources)).toMatchObject({ state: "current", usd: 8, swaps: 8 });
  });

  it("values a dollar leg at a dollar and a WHYPE leg at HYPE's price", () => {
    expect(legUsd({ mint: "USD6", raw: 2_500_000n }, {})).toBe(2.5);
    expect(legUsd({ mint: "HYPE", raw: 2n * 10n ** 18n }, { HYPE: 62 })).toBe(124);
  });

  it("a V3 swap's leg is the dollar side's size, whichever way it went", () => {
    const pool = { address: POOL, coin0: WHYPE, coin1: USDT0 };
    const data = encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }], [10n ** 18n, -62_000_000n, 1n, 1n, 0]);
    expect(v3SwapLeg({ data }, pool)).toEqual({ mint: "USD6", raw: 62_000_000n });
    const back = encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }], [-(10n ** 18n), 62_000_000n, 1n, 1n, 0]);
    expect(v3SwapLeg({ data: back }, pool)).toEqual({ mint: "USD6", raw: 62_000_000n });
  });
});

/** A HyperEVM RPC: one pool (WHYPE / USD₮0 at 0.3%), its Swap logs, and its holdings. */
function chain({ logs = [], held = {} } = {}) {
  const asked = [];
  const call = async (method, params) => {
    asked.push({ method, params });
    if (method === "eth_getBlockByNumber") return { number: "0x" + (2500).toString(16), timestamp: "0x" + (1_790_000_000).toString(16) };
    if (method === "eth_getLogs") return logs.filter((l) => Number(l.blockNumber) >= Number(params[0].fromBlock) && Number(l.blockNumber) <= Number(params[0].toBlock));
    if (method === "eth_call") {
      const { to, data } = params[0];
      if (data.startsWith("0x1698ee82")) {
        const fee = Number(BigInt("0x" + data.slice(-64)));
        const a = "0x" + data.slice(34, 74);
        const b = "0x" + data.slice(98, 138);
        const ours = a === WHYPE.address.toLowerCase() && b === USDT0.address.toLowerCase() && fee === 3000;
        return "0x" + (ours ? POOL.slice(2) : "0".repeat(40)).padStart(64, "0");
      }
      if (data.startsWith("0x70a08231")) return "0x" + (held[to.toLowerCase()] ?? 0n).toString(16).padStart(64, "0");
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, asked };
}

describe("reading HyperEVM", () => {
  it("finds our pools by the factory's getPool, for listed coins only", async () => {
    const { call, asked } = chain();
    const pools = await listV3Pools(call, DEPLOYED);
    expect(pools).toEqual([{ address: POOL, coin0: WHYPE, coin1: USDT0 }]);
    expect(asked.every((a) => a.params[0].to === FACTORY)).toBe(true);
    expect(asked).toHaveLength(12);
  });

  it("counts new Swap logs from the first block, in 1,000-block reads, up to the finalized block", async () => {
    const data = encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }], [10n ** 18n, -62_000_000n, 1n, 1n, 0]);
    const log = { address: POOL, blockNumber: "0x" + (1500).toString(16), topics: [V3_SWAP_TOPIC, "0x" + "0".repeat(24) + "aa".repeat(20)], data, transactionHash: "0xabc", logIndex: "0x1" };
    const { call, asked } = chain({ logs: [log] });
    const got = await readHyperEvm(call, null, { v3: DEPLOYED });
    expect(got.swaps).toEqual([{ leg: { mint: "USD6", raw: 62_000_000n }, payer: "0x" + "aa".repeat(20), id: "0xabc:0x1" }]);
    expect(got.cursor).toEqual({ block: 2500 });
    const reads = asked.filter((a) => a.method === "eth_getLogs").map((a) => [Number(a.params[0].fromBlock), Number(a.params[0].toBlock), a.params[0].topics[0]]);
    expect(reads).toEqual([[100, 1099, V3_SWAP_TOPIC], [1100, 2099, V3_SWAP_TOPIC], [2100, 2500, V3_SWAP_TOPIC]]);
  });

  it("is read through HyperEVM's own RPCs by both counters, and an EVM source with none is refused by name", () => {
    expect(evmRpcsFor("hyperevm")).toBe(HYPEREVM_V3.rpcs);
    for (const name of ["ethereum", "base", "robinhood"]) expect(evmRpcsFor(name)).toBe(EVM_CHAINS[name].rpcs);
    expect(() => evmRpcsFor("solana-pools")).toThrow(/no RPC list for the EVM source solana-pools/);
  });

  it("refuses to run while not deployed", async () => {
    await expect(readHyperEvm(chain().call, null, { v3: { ...HYPEREVM_V3, factory: null, startBlock: null } })).rejects.toThrow(/not deployed/);
  });
});

describe("HyperEVM in the TVL", () => {
  it("is a row only once deployed, on both sides of the answer", () => {
    expect(tvlChainNames(false)).toEqual(["solana", "ethereum", "base", "robinhood"]);
    expect(tvlChainNames(true)).toEqual(["solana", "ethereum", "base", "robinhood", "hyperevm"]);
    expect(Object.keys(tvlChains(false))).toEqual(tvlChainNames(false));
    expect(Object.keys(tvlChains(true))).toEqual(tvlChainNames(true));
    expect(tvlChainNames()).toEqual(Object.keys(tvlChains()));
  });

  it("an answer that disagrees with the site about HyperEVM is not trusted, so the two must move together", () => {
    const rows = (names) => names.map((chain) => ({ chain, read: true, usd: 1, pools: 1, unvalued: 0 }));
    // No staking or NFT rows: an older answer's shape, which still parses (as partial).
    const body = (names) => ({ state: "current", usd: 5, readAt: "2026-11-20T00:00:00Z", chains: rows(names) });
    // As committed (deployed 2026-11-25) the site shows HyperEVM: an answer without its row,
    // such as one cached from before the deploy, is unread; one with it is read.
    expect(parseVenueTvl(body(tvlChainNames(true))).state).toBe("partial");
    expect(parseVenueTvl(body(tvlChainNames(false))).state).toBe("unread");
  });

  it("values what our pools hold: dollars at a dollar, WHYPE at HYPE's price, neither side doubled", async () => {
    const { call } = chain({ held: {} });
    const held = { [WHYPE.address.toLowerCase()]: 3n * 10n ** 18n, [USDT0.address.toLowerCase()]: 100_000_000n };
    const fetchImpl = async (url, init) => {
      const { params, id } = JSON.parse(init.body);
      const [{ to, data }] = params;
      let result;
      if (data.startsWith("0x70a08231")) result = "0x" + (held[to.toLowerCase()] ?? 0n).toString(16).padStart(64, "0");
      else result = await call("eth_call", params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
    };
    const r = await readHyperEvmTvl({ fetchImpl, priceOf: async (s) => (s === "HYPE" ? 62 : NaN), v3: DEPLOYED });
    expect(r).toEqual({ usd: 3 * 62 + 100, pools: 1, unvalued: 0 });
  });
});
