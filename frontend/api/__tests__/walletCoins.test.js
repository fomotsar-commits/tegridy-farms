// ?resource=wallet-coins: which ERC-20s a wallet holds on Ethereum or Base, and at what price,
// for the dashboard. The rules under test are the ones a visitor relies on: the list comes from
// Alchemy with our key, and from Blockscout only when there is no key or Alchemy fails; every page
// is read (up to four, and a longer list says so); DefiLlama gives the price and decimals, and a
// price it is unsure of drops the coin; a coin worth under a dollar, holding nothing or with no
// price is left out; a failed read is a 502 and never an empty list; and an answer is cached a minute.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const { handleWalletCoins, readWalletCoins, __resetWalletCoins, MAX_PAGES } = await import("../_lib/walletCoins.js");

const NOW = Date.parse("2026-11-01T12:00:00Z");
const KEY = "test-alchemy-key-0123456789abcdef";
const WALLET = "0x00000000000000000000000000000000000000AA";
const wallet = WALLET.toLowerCase();
// A coin address, checksummed-looking (mixed case) as Blockscout and Alchemy write it.
const coin = (n) => "0x" + n.toString(16).padStart(4, "0") + "AbCdEf".padEnd(36, "0");
const low = (n) => coin(n).toLowerCase();
const E18 = 10n ** 18n;
const ALCHEMY_HOSTS = { "eth-mainnet.g.alchemy.com": "ethereum", "base-mainnet.g.alchemy.com": "base" };

/** One Blockscout item, as its v2 tokens list writes it: decimals and rate are strings. */
function item(address, { whole = 1n, decimals = 18, rate = null, field = "address_hash" } = {}) {
  return { token: { [field]: address, decimals: String(decimals), exchange_rate: rate === null ? null : String(rate), type: "ERC-20" }, value: String(whole * 10n ** BigInt(decimals)), token_id: null, token_instance: null };
}
/** One Alchemy balance, as alchemy_getTokenBalances writes it: a 32-byte hex string. */
const bal = (address, raw) => ({ contractAddress: address, tokenBalance: "0x" + BigInt(raw).toString(16).padStart(64, "0"), error: null });

/**
 * A fake world: each chain's pages from Alchemy and Blockscout, DefiLlama's answers, and what is
 * down. It answers both the injected fetchImpl and the global fetch, which alchemy-failover.js uses.
 */
function world() {
  const w = { alchemy: { ethereum: [[]], base: [[]] }, pages: { ethereum: [[]], base: [[]] }, llama: {}, down: new Set(), alchemyFails: null, calls: [], alchemyCalls: [] };
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  w.fetchImpl = vi.fn(async (url, init = {}) => {
    const u = new URL(String(url));
    w.calls.push(u);
    if (u.host in ALCHEMY_HOSTS) {
      const body = JSON.parse(init.body);
      w.alchemyCalls.push({ url: String(url), headers: init.headers, body });
      if (w.alchemyFails === "throw") throw new TypeError("fetch failed");
      if (w.alchemyFails === "status") return new Response("busy", { status: 503 });
      if (w.alchemyFails === "rpc-error") return json({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "BASE_MAINNET is not enabled for this app" } });
      // A list sent as a string: walked as characters, it would read as "holds nothing".
      if (w.alchemyFails === "bad-shape") return json({ jsonrpc: "2.0", id: 1, result: { address: body.params[0], tokenBalances: "[]" } });
      expect(init.method).toBe("POST");
      expect(body.method).toBe("alchemy_getTokenBalances");
      const pages = w.alchemy[ALCHEMY_HOSTS[u.host]];
      const n = body.params[2] ? Number(body.params[2].pageKey.slice(2)) : 0;
      const pageKey = n + 1 < pages.length ? `pk${n + 1}` : undefined;
      return json({ jsonrpc: "2.0", id: 1, result: { address: body.params[0], tokenBalances: pages[n], pageKey } });
    }
    if (w.down.has(u.host)) return new Response("busy", { status: 503 });
    if (u.host === "coins.llama.fi") {
      const asked = decodeURIComponent(u.pathname.slice("/prices/current/".length)).split(",");
      return json({ coins: Object.fromEntries(asked.filter((k) => k in w.llama).map((k) => [k, w.llama[k]])) });
    }
    const chain = u.host === "eth.blockscout.com" ? "ethereum" : "base";
    expect(u.pathname).toBe(`/api/v2/addresses/${wallet}/tokens`);
    expect(u.searchParams.get("type")).toBe("ERC-20");
    // Page n is asked for with the cursor page n-1 handed back.
    const n = Number(u.searchParams.get("page") ?? 0);
    const pages = w.pages[chain];
    const next = n + 1 < pages.length ? { page: n + 1, fiat_value: null, items_count: 50 * (n + 1) } : null;
    return json({ items: pages[n], next_page_params: next });
  });
  vi.stubGlobal("fetch", w.fetchImpl);
  w.hits = (host) => w.calls.filter((u) => u.host === host).length;
  return w;
}

beforeEach(() => {
  __resetWalletCoins();
  // No Alchemy key unless a test sets one, whatever the machine running the tests has.
  vi.stubEnv("ALCHEMY_API_KEY", "");
  vi.stubEnv("ALCHEMY_API_KEY_FALLBACK", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("readWalletCoins, from Alchemy", () => {
  it("reads every page by pageKey with the key in a Bearer header, and asks Blockscout nothing", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", KEY);
    const w = world();
    const [a, b, unpriced, zero, broken] = [coin(1), coin(2), coin(3), coin(4), coin(5)];
    w.alchemy.base = [
      [bal(a, 10n * E18), bal(zero, 0), { ...bal(broken, 1_000n * E18), error: "execution reverted" }, { contractAddress: "0xnope", tokenBalance: "0x01", error: null }],
      [bal(b, 3_000_000n), bal(unpriced, 1_000_000n * E18)],
    ];
    w.llama[`base:${low(1)}`] = { price: 2, decimals: 18, confidence: 0.99 }; // $20
    w.llama[`base:${low(2)}`] = { price: 5, decimals: 6, confidence: 0.99 }; // $15
    w.llama[`base:${low(5)}`] = { price: 1, decimals: 18, confidence: 0.99 }; // would be $1,000 if its error were ignored
    const body = await readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body).toEqual({
      chain: "base",
      address: wallet,
      coins: [
        { address: low(1), priceUsd: 2 },
        { address: low(2), priceUsd: 5 },
      ],
      truncated: false,
      readAt: new Date(NOW).toISOString(),
    });
    expect(w.alchemyCalls.map((c) => c.body.params)).toEqual([
      [wallet, "erc20"],
      [wallet, "erc20", { pageKey: "pk1" }],
    ]);
    for (const c of w.alchemyCalls) {
      expect(c.url).toBe("https://base-mainnet.g.alchemy.com/v2");
      expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
    expect(w.hits("base.blockscout.com")).toBe(0);
    // The zero balance and the unreadable entry are never priced.
    const asked = w.calls.filter((u) => u.host === "coins.llama.fi").map((u) => decodeURIComponent(u.pathname)).join();
    expect(asked).not.toContain(low(4));
    expect(asked).not.toContain(low(5));
  });

  it("says truncated after four pages, and reads no fifth", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", KEY);
    const w = world();
    w.alchemy.ethereum = Array.from({ length: MAX_PAGES + 2 }, (_, i) => [bal(coin(i + 1), BigInt(i + 1) * E18)]);
    for (let i = 1; i <= MAX_PAGES + 2; i++) w.llama[`ethereum:${low(i)}`] = { price: 1, decimals: 18, confidence: 0.99 };
    const body = await readWalletCoins("ethereum", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body.truncated).toBe(true);
    expect(body.coins.map((c) => c.address)).toEqual([4, 3, 2, 1].map(low));
    expect(w.alchemyCalls).toHaveLength(MAX_PAGES);
  });

  it("falls back to Blockscout when Alchemy answers an error, a JSON-RPC error, a bad shape, or nothing", async () => {
    for (const fails of ["status", "rpc-error", "bad-shape", "throw"]) {
      vi.stubEnv("ALCHEMY_API_KEY", KEY);
      const w = world();
      w.alchemyFails = fails;
      w.pages.base = [[item(coin(1), { whole: 2n, rate: 3 })]];
      const body = await readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
      expect(body.coins).toEqual([{ address: low(1), priceUsd: 3 }]);
      expect(w.alchemyCalls.length).toBeGreaterThan(0);
      expect(w.hits("base.blockscout.com")).toBe(1);
    }
  });

  it("goes straight to Blockscout, never calling Alchemy, with no key or only the 'demo' word", async () => {
    for (const key of ["", "demo"]) {
      vi.stubEnv("ALCHEMY_API_KEY", key);
      const w = world();
      w.pages.ethereum = [[item(coin(1), { whole: 2n, rate: 3 })]];
      const body = await readWalletCoins("ethereum", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
      expect(body.coins).toHaveLength(1);
      expect(w.alchemyCalls).toHaveLength(0);
    }
  });

  it("throws, never answers empty, when Alchemy and Blockscout both fail", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", KEY);
    const w = world();
    w.alchemyFails = "status";
    w.down.add("base.blockscout.com");
    await expect(readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl })).rejects.toThrow(/HTTP 503 from base.blockscout.com/);
  });
});

describe("readWalletCoins, DefiLlama's decimals and confidence", () => {
  it("makes the $1 cut with DefiLlama's decimals, and drops an Alchemy coin it gives none for", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", KEY);
    const w = world();
    w.alchemy.base = [[bal(coin(1), 5_000_000n), bal(coin(2), 5_000_000n), bal(coin(3), 5_000_000n)]];
    w.llama[`base:${low(1)}`] = { price: 1, decimals: 6 }; // $5: kept
    w.llama[`base:${low(2)}`] = { price: 1, decimals: 18 }; // $0.000000000005: dropped
    w.llama[`base:${low(3)}`] = { price: 1 }; // no decimals, and Alchemy gives none: dropped
    const body = await readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body.coins).toEqual([{ address: low(1), priceUsd: 1 }]);
  });

  it("prefers DefiLlama's decimals to Blockscout's, and uses Blockscout's only when DefiLlama has none", async () => {
    const w = world();
    // Blockscout says 18 decimals for both (5 whole coins); the chain really says 6 for the first.
    w.pages.base = [[item(coin(1), { whole: 5n }), item(coin(2), { whole: 5n })]];
    w.llama[`base:${low(1)}`] = { price: 1, decimals: 6 }; // 5e18 at 6 decimals: $5,000,000,000,000
    w.llama[`base:${low(2)}`] = { price: 1 }; // Blockscout's 18: $5
    const body = await readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body.coins.map((c) => c.address)).toEqual([low(1), low(2)]);
    w.llama[`base:${low(1)}`] = { price: 1, decimals: 30 }; // the other way: $0.000000000005, dropped
    __resetWalletCoins();
    const again = await readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(again.coins.map((c) => c.address)).toEqual([low(2)]);
  });

  it("drops a coin DefiLlama prices with confidence under 0.9, on either path, and keeps one with none given", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", KEY);
    const w = world();
    w.alchemy.ethereum = [[bal(coin(1), 1_000_000n * E18), bal(coin(2), E18), bal(coin(3), E18)]];
    w.llama[`ethereum:${low(1)}`] = { price: 10, decimals: 18, confidence: 0.5 }; // "$10,000,000" of spam
    w.llama[`ethereum:${low(2)}`] = { price: 2, decimals: 18, confidence: 0.9 };
    w.llama[`ethereum:${low(3)}`] = { price: 3, decimals: 18 };
    const body = await readWalletCoins("ethereum", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body.coins.map((c) => c.address)).toEqual([low(3), low(2)]);
    // On Blockscout's path, the unsure coin is not priced at Blockscout's rate instead.
    vi.stubEnv("ALCHEMY_API_KEY", "");
    w.pages.ethereum = [[item(coin(1), { whole: 1_000_000n, rate: 10 })]];
    const fallback = await readWalletCoins("ethereum", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(fallback.coins).toEqual([]);
  });
});

describe("readWalletCoins, from Blockscout", () => {
  it("merges every page, prices from DefiLlama first and Blockscout's rate second, largest first", async () => {
    const w = world();
    const [a, b] = [coin(1), coin(2)];
    w.pages.base = [
      [item(a, { whole: 10n, rate: 99 })], // DefiLlama's $2 wins over the rate: $20
      [item(b, { whole: 3n, decimals: 6, rate: 5, field: "address" }), item(a, { whole: 10n, rate: 99 })], // rate only: $15; `a` again counts once
    ];
    w.llama[`base:${low(1)}`] = { price: 2 };
    w.llama[`base:${low(3)}`] = { price: 1000 }; // priced but not held: never listed
    const body = await readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body).toEqual({
      chain: "base",
      address: wallet,
      coins: [
        { address: a.toLowerCase(), priceUsd: 2 },
        { address: b.toLowerCase(), priceUsd: 5 },
      ],
      truncated: false,
      readAt: new Date(NOW).toISOString(),
    });
    expect(w.hits("base.blockscout.com")).toBe(2);
  });

  it("leaves out a coin worth under a dollar, one holding nothing, and one with no price", async () => {
    const w = world();
    const [cheap, empty, unpriced, kept] = [coin(1), coin(2), coin(3), coin(4)];
    w.pages.ethereum = [
      [
        item(cheap, { whole: 1n, rate: 0.99 }),
        { ...item(empty, { rate: 50 }), value: "0" },
        item(unpriced, { whole: 1_000_000n }),
        item(kept, { whole: 1n, rate: 1 }), // exactly a dollar is kept
        { token: { address_hash: "0xnot-an-address", decimals: "18", exchange_rate: "9" }, value: String(E18) },
      ],
    ];
    const body = await readWalletCoins("ethereum", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body.coins).toEqual([{ address: kept.toLowerCase(), priceUsd: 1 }]);
    // A coin holding nothing is not even priced.
    const asked = w.calls.filter((u) => u.host === "coins.llama.fi").map((u) => decodeURIComponent(u.pathname));
    expect(asked.join()).toContain(kept.toLowerCase());
    expect(asked.join()).not.toContain(empty.toLowerCase());
  });

  it("says truncated after four pages, and reads no fifth", async () => {
    const w = world();
    w.pages.base = Array.from({ length: MAX_PAGES + 2 }, (_, i) => [item(coin(i + 1), { whole: BigInt(i + 1), rate: 1 })]);
    const body = await readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body.truncated).toBe(true);
    expect(body.coins.map((c) => c.address)).toEqual([4, 3, 2, 1].map(low));
    expect(w.hits("base.blockscout.com")).toBe(MAX_PAGES);
  });

  it("returns at most 60 coins, the largest", async () => {
    const w = world();
    w.pages.ethereum = [Array.from({ length: 50 }, (_, i) => item(coin(i + 1), { whole: BigInt(i + 1), rate: 1 })), Array.from({ length: 50 }, (_, i) => item(coin(i + 51), { whole: BigInt(i + 51), rate: 1 }))];
    const body = await readWalletCoins("ethereum", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body.coins).toHaveLength(60);
    expect(body.coins[0].address).toBe(low(100));
    expect(body.coins[59].address).toBe(low(41));
    // 100 coins are priced in two DefiLlama asks of 50.
    expect(w.hits("coins.llama.fi")).toBe(2);
  });

  it("throws, never answers empty, when Blockscout, its shape or DefiLlama fails", async () => {
    const w = world();
    w.pages.base = [[item(coin(1), { rate: 5 })]];
    w.down.add("base.blockscout.com");
    await expect(readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl })).rejects.toThrow(/HTTP 503/);
    w.down.clear();
    w.down.add("coins.llama.fi");
    await expect(readWalletCoins("base", WALLET, { fetchImpl: w.fetchImpl })).rejects.toThrow(/HTTP 503/);
    const odd = vi.fn(async () => new Response(JSON.stringify({ message: "Not found" }), { status: 200 }));
    await expect(readWalletCoins("base", WALLET, { fetchImpl: odd })).rejects.toThrow(/no list/);
    // Cloudflare's challenge page, served as HTML.
    const html = vi.fn(async () => new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 200 }));
    await expect(readWalletCoins("base", WALLET, { fetchImpl: html })).rejects.toThrow();
  });

  it("answers a wallet that holds nothing with an empty list, and asks DefiLlama nothing", async () => {
    const w = world();
    const body = await readWalletCoins("ethereum", WALLET, { fetchImpl: w.fetchImpl, now: NOW });
    expect(body).toMatchObject({ coins: [], truncated: false });
    expect(w.hits("coins.llama.fi")).toBe(0);
  });
});

function makeReq(query = { chain: "base", address: WALLET }, { method = "GET", origin = "https://tegridyfarms.vercel.app" } = {}) {
  return { method, query: { resource: "wallet-coins", ...query }, headers: { origin } };
}
function makeRes() {
  const headers = {};
  const out = { status: 0, body: undefined, headers };
  const res = {
    setHeader: (k, v) => ((headers[k] = v), res),
    status: (c) => ((out.status = c), res),
    json: (b) => ((out.body = b), res),
    end: () => res,
  };
  return { res, out };
}

describe("handleWalletCoins", () => {
  it("refuses a bad chain or address with a 400, and reads nothing", async () => {
    const w = world();
    for (const query of [
      { chain: "base", address: "0x1234" },
      { chain: "base", address: WALLET + "0" },
      { chain: "base", address: [WALLET, WALLET] },
      { chain: "solana", address: WALLET },
      { chain: "__proto__", address: WALLET },
      { address: WALLET },
    ]) {
      const { res, out } = makeRes();
      await handleWalletCoins(makeReq(query), res, { fetchImpl: w.fetchImpl, nowMs: NOW });
      expect(out.status).toBe(400);
    }
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  it("answers OPTIONS, refuses a POST, and refuses another site's page in production", async () => {
    const w = world();
    const options = makeRes();
    await handleWalletCoins(makeReq(undefined, { method: "OPTIONS" }), options.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(options.out.status).toBe(200);
    const post = makeRes();
    await handleWalletCoins(makeReq(undefined, { method: "POST" }), post.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(post.out.status).toBe(405);
    vi.stubEnv("NODE_ENV", "production");
    const evil = makeRes();
    await handleWalletCoins(makeReq(undefined, { origin: "https://evil.example" }), evil.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(evil.out.status).toBe(403);
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  it("serves an answer with a minute's edge cache, and reads the upstreams once a minute per wallet", async () => {
    const w = world();
    w.pages.base = [[item(coin(1), { whole: 2n, rate: 3 })]];
    const first = makeRes();
    await handleWalletCoins(makeReq(), first.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(first.out.status).toBe(200);
    expect(first.out.body.coins).toEqual([{ address: low(1), priceUsd: 3 }]);
    expect(first.out.headers["Cache-Control"]).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=60");
    const reads = w.calls.length;
    // The same wallet in another case is the same wallet.
    const again = makeRes();
    await handleWalletCoins(makeReq({ chain: "base", address: wallet }), again.res, { fetchImpl: w.fetchImpl, nowMs: NOW + 59_000 });
    expect(again.out.body).toEqual(first.out.body);
    expect(w.calls.length).toBe(reads);
    // Another chain is another read.
    await handleWalletCoins(makeReq({ chain: "ethereum", address: WALLET }), makeRes().res, { fetchImpl: w.fetchImpl, nowMs: NOW + 59_000 });
    expect(w.calls.length).toBeGreaterThan(reads);
    const later = w.calls.length;
    await handleWalletCoins(makeReq(), makeRes().res, { fetchImpl: w.fetchImpl, nowMs: NOW + 61_000 });
    expect(w.calls.length).toBeGreaterThan(later);
  });

  it("shares one read between two visitors asking at once", async () => {
    const w = world();
    w.pages.base = [[item(coin(1), { rate: 3 })]];
    const [one, two] = [makeRes(), makeRes()];
    await Promise.all([handleWalletCoins(makeReq(), one.res, { fetchImpl: w.fetchImpl, nowMs: NOW }), handleWalletCoins(makeReq(), two.res, { fetchImpl: w.fetchImpl, nowMs: NOW })]);
    expect(one.out.body).toEqual(two.out.body);
    expect(w.hits("base.blockscout.com")).toBe(1);
  });

  it("is a 502 with no list when Alchemy and Blockscout are both down, and caches nothing", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", KEY);
    const w = world();
    w.pages.base = [[item(coin(1), { rate: 3 })]];
    w.alchemyFails = "status";
    w.down.add("base.blockscout.com");
    const down = makeRes();
    await handleWalletCoins(makeReq(), down.res, { fetchImpl: w.fetchImpl, nowMs: NOW });
    expect(down.out.status).toBe(502);
    expect(down.out.body).toEqual({ error: expect.any(String) });
    expect(down.out.headers["Cache-Control"]).toBe("s-maxage=10");
    // Blockscout back a second later: read again, not a remembered failure.
    w.down.clear();
    const up = makeRes();
    await handleWalletCoins(makeReq(), up.res, { fetchImpl: w.fetchImpl, nowMs: NOW + 1000 });
    expect(up.out.status).toBe(200);
    expect(up.out.body.coins).toHaveLength(1);
  });
});
