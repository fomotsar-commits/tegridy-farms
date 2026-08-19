import { describe, it, expect } from "vitest";
import {
  loadConfig,
  parseWatchSet,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_SIGNATURE_PAGE,
} from "./config.js";

const POOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BASE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE = "So11111111111111111111111111111111111111112";
const VAULT = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

const watchJson = (over = {}) =>
  JSON.stringify([{ pool: POOL, baseMint: BASE, quoteMint: QUOTE, ...over }]);

const fullEnv = (over = {}) => ({
  SOLANA_RPC_URL: "https://rpc.example.com/?api-key=x",
  DATABASE_URL: "postgresql://u:p@h:5432/d",
  SOLANA_WATCH: watchJson(),
  ...over,
});

describe("parseWatchSet", () => {
  it("accepts a well-formed entry", () => {
    const { watches, errors } = parseWatchSet(watchJson({ label: "first", feeReceiver: VAULT }));
    expect(errors).toEqual([]);
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ pool: POOL, baseMint: BASE, quoteMint: QUOTE, feeReceiver: VAULT });
  });

  it("treats an unset variable as zero watches, not an error", () => {
    expect(parseWatchSet(undefined)).toEqual({ watches: [], errors: [] });
    expect(parseWatchSet("  ")).toEqual({ watches: [], errors: [] });
  });

  // A partially accepted watch set is the dangerous shape: the pools that
  // parsed get indexed, the pools that did not get nothing, and nothing on the
  // read side can tell "this pool had no trades" from "this pool was dropped
  // during config parsing".
  it("rejects the WHOLE set when any entry is malformed", () => {
    const raw = JSON.stringify([
      { pool: POOL, baseMint: BASE, quoteMint: QUOTE },
      { pool: "not-a-pool", baseMint: BASE, quoteMint: QUOTE },
    ]);
    const { watches, errors } = parseWatchSet(raw);
    expect(watches).toEqual([]);
    expect(errors.join(" ")).toContain("SOLANA_WATCH[1].pool");
  });

  it("never invents a missing mint", () => {
    const { watches, errors } = parseWatchSet(JSON.stringify([{ pool: POOL, baseMint: BASE }]));
    expect(watches).toEqual([]);
    expect(errors.join(" ")).toContain("quoteMint is missing");
  });

  it("rejects an address of the wrong byte length even though it looks like base58", () => {
    const { errors } = parseWatchSet(watchJson({ pool: "1" + POOL }));
    expect(errors.join(" ")).toContain("not a 32-byte base58 address");
  });

  it("rejects a pair whose two mints are the same", () => {
    const { errors } = parseWatchSet(watchJson({ quoteMint: BASE }));
    expect(errors.join(" ")).toContain("the same mint");
  });

  it("rejects duplicate pools rather than indexing one twice", () => {
    const raw = JSON.stringify([
      { pool: POOL, baseMint: BASE, quoteMint: QUOTE },
      { pool: POOL, baseMint: BASE, quoteMint: QUOTE },
    ]);
    expect(parseWatchSet(raw).errors.join(" ")).toContain("duplicate");
  });

  it("rejects a startSignature that is not a 64-byte signature", () => {
    expect(parseWatchSet(watchJson({ startSignature: POOL })).errors.join(" ")).toContain(
      "not a 64-byte base58 signature",
    );
  });

  it("rejects non-JSON and non-array values by name", () => {
    expect(parseWatchSet("{").errors).toEqual(["SOLANA_WATCH is not valid JSON"]);
    expect(parseWatchSet('{"pool":"x"}').errors).toEqual(["SOLANA_WATCH must be a JSON array"]);
  });
});

describe("loadConfig", () => {
  it("is ready with no problems when everything is present", () => {
    const c = loadConfig(fullEnv());
    expect(c.problems).toEqual([]);
    expect(c.ready).toBe(true);
    expect(c.watches).toHaveLength(1);
  });

  // HONESTY GUARD. Missing configuration must be reported as configuration,
  // and every missing piece must be named — an operator reading /ready should
  // not have to guess which of four variables is absent.
  it("reports every missing input by name instead of throwing", () => {
    const c = loadConfig({});
    expect(c.ready).toBe(false);
    const joined = c.problems.join(" | ");
    expect(joined).toContain("SOLANA_RPC_URL");
    expect(joined).toContain("DATABASE_URL");
    expect(joined).toContain("SOLANA_WATCH");
  });

  it("calls out an empty watch set as making an absence of trades meaningless", () => {
    const c = loadConfig(fullEnv({ SOLANA_WATCH: "" }));
    expect(c.ready).toBe(false);
    expect(c.problems.join(" ")).toMatch(/no pool is being followed/);
  });

  it("prefers DATABASE_PRIVATE_URL, matching the Ponder app's precedence", () => {
    const c = loadConfig(
      fullEnv({ DATABASE_PRIVATE_URL: "postgresql://private", DATABASE_URL: "postgresql://public" }),
    );
    expect(c.databaseUrl).toBe("postgresql://private");
  });

  it("collects up to four RPC endpoints in order", () => {
    const c = loadConfig(
      fullEnv({ SOLANA_RPC_URL_2: "https://b", SOLANA_RPC_URL_4: "https://d" }),
    );
    expect(c.rpcUrls).toEqual(["https://rpc.example.com/?api-key=x", "https://b", "https://d"]);
  });

  it("flags a non-http RPC URL without echoing the whole value", () => {
    const c = loadConfig(fullEnv({ SOLANA_RPC_URL: "wss://rpc.example.com/?api-key=supersecret" }));
    expect(c.ready).toBe(false);
    const joined = c.problems.join(" ");
    expect(joined).toContain("not http(s)");
    expect(joined).not.toContain("supersecret");
  });

  it("clamps tuning knobs instead of trusting them", () => {
    const c = loadConfig(
      fullEnv({
        SOLANA_POLL_INTERVAL_MS: "1",
        SOLANA_SIGNATURE_PAGE_LIMIT: "999999",
        SOLANA_MAX_PAGES_PER_TICK: "0",
      }),
    );
    expect(c.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
    expect(c.signaturePageLimit).toBe(MAX_SIGNATURE_PAGE);
    expect(c.maxPagesPerTick).toBe(1);
  });

  it("falls back to the default poll interval on garbage", () => {
    expect(loadConfig(fullEnv({ SOLANA_POLL_INTERVAL_MS: "soon" })).pollIntervalMs).toBe(
      DEFAULT_POLL_INTERVAL_MS,
    );
  });

  it("opens no status socket unless a port was asked for", () => {
    expect(loadConfig(fullEnv()).statusPort).toBeNull();
    expect(loadConfig(fullEnv({ SOLANA_STATUS_PORT: "8080" })).statusPort).toBe(8080);
  });
});
