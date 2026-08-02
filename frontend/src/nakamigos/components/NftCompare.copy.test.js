import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// NftCompare needs CollectionProvider + WalletContext + a mocked fetchWalletNfts
// to render, and a render test would be flakier without proving more — these are
// copy invariants, so read the source. cwd = frontend/, and import.meta.url is
// not a file: URL under jsdom (same anchor as navRouting.test.jsx).
const SRC = readFileSync(
  join(process.cwd(), "src", "nakamigos", "components", "NftCompare.jsx"),
  "utf8",
);
const blurb = () =>
  SRC.split("\n").find((l) => /^\s*Review, accept, counter, or cancel/.test(l)) || "";

describe("NftCompare P2P copy is honest about what is on-chain", () => {
  // The book is a Supabase trade_offers table (api/orderbook.js:1915 insert, :385 read).
  it("never calls the trade book on-chain", () => {
    expect(SRC).not.toMatch(/on-chain order book/i);
  });

  // Guards the OPPOSITE error: the orders really are EIP-712 Seaport signatures
  // (lib/trades.js:341, verified api/orderbook.js:1803) that settle via
  // fulfillOrder (lib/trades.js:629). Deleting that credit must also fail.
  it("still credits the signature and the on-chain settlement", () => {
    const b = blurb();
    expect(b).toMatch(/Seaport/);
    expect(b).toMatch(/off-chain/);
    expect(b).toMatch(/settles atomically on-chain/);
  });

  // JSX text children are not string literals — \uXXXX renders as six literal chars.
  it("uses an HTML entity, not a backslash escape, for the em dash", () => {
    expect(blurb()).toBeTruthy();
    expect(blurb()).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  // theirResults filters only the paginated prefix (NftCompare.jsx:230-236 over
  // useNfts allTokens; autoload gated to supply<1000 at hooks/useNfts.js:101 while
  // every shipped collection is 5555-20000).
  it("does not promise a full-collection search it cannot serve", () => {
    expect(SRC).not.toMatch(/Search any \$\{collection\.name\}/);
    expect(SRC).toMatch(/loaded \$\{collection\.name\}/);
  });
});
