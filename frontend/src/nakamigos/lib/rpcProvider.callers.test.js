import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The nakamigos surfaces that read chain state with ethers (rather than wagmi)
// must go through lib/rpcProvider's shared FallbackProvider. WhaleIntelligence
// and OnChainProfile each used to construct their own JsonRpcProvider against
// eth.llamarpc.com — a single third-party endpoint nobody here monitors, which
// answered 521 in prod on 2026-06-11 and took both surfaces down with it. The
// shared provider is the only thing that carries the vetted roster, the stall
// timeout and the failover, so a source-level guard is what keeps a future
// component from quietly re-forking its own.
const SOURCES = ["../components/WhaleIntelligence.jsx", "../components/OnChainProfile.jsx", "../hooks/useEns.jsx"];

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ethers read paths route through the shared RPC provider", () => {
  it.each(SOURCES)("%s imports getReadProvider", (rel) => {
    expect(read(rel)).toMatch(/import\s*\{[^}]*getReadProvider[^}]*\}\s*from\s*["'][^"']*rpcProvider["']/);
  });

  it.each(SOURCES)("%s constructs no provider of its own", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/new\s+ethers\.JsonRpcProvider/);
    expect(src).not.toMatch(/llamarpc/);
    // A bare https RPC URL in a component is the shape of a re-fork.
    expect(src).not.toMatch(/https:\/\/[a-z0-9.-]*rpc[a-z0-9.-]*\.(com|org|io)/i);
  });
});

describe("the shared roster stays free of the endpoints it was built to drop", () => {
  it("names no excluded endpoint as a live entry", async () => {
    const src = read("./rpcProvider.js");
    const endpoints = [...src.matchAll(/^\s*"(https:\/\/[^"]+)",$/gm)].map((m) => m[1]);
    expect(endpoints.length).toBeGreaterThan(1); // failover needs more than one
    for (const url of endpoints) {
      expect(url).not.toMatch(/llamarpc|cloudflare-eth|rpc\.ankr\.com/);
    }
  });
});
