// The NFT loan request book (api/_lib/loanRequests.js). A request moves no money, so what
// these pin is what the book may SHOW: only requests the venue's rules allow, signed by the
// borrower, on an NFT the borrower holds now; one open request per NFT; closed for good once
// cancelled, replaced, or the NFT has left the wallet.
import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { handleLoanRequestAction } from "../_lib/loanRequests.js";
import { checkDigestSignature } from "../_lib/loanOffers.js";
import { gondiDomain } from "../../src/lib/gondi/loanOffer.js";
import {
  CANCEL_REQUEST_TYPES,
  LOAN_REQUEST_TYPES,
  requestDomain,
  requestToMessage,
} from "../../src/lib/gondi/loanRequest.js";

const LOAN = "0x2222222222222222222222222222222222222222";
const NAKA = "0xd774557b647330C91Bf44cfEAB205095f7E6c367";
const NOW = 1_800_000_000;
const borrowerAccount = privateKeyToAccount(`0x${"cd".repeat(32)}`);
const strangerAccount = privateKeyToAccount(`0x${"ef".repeat(32)}`);
const BORROWER = borrowerAccount.address;
const ONE = 10n ** 18n;

function request(overrides = {}) {
  return {
    borrower: BORROWER,
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: "1234",
    principalAmount: ONE.toString(),
    maxAprBps: "4000",
    duration: String(30 * 86400),
    expirationTime: String(NOW + 3 * 86400),
    nonce: "1",
    ...overrides,
  };
}

function sign(r, account = borrowerAccount, domain = requestDomain()) {
  return account.signTypedData({ domain, types: LOAN_REQUEST_TYPES, primaryType: "LoanRequest", message: requestToMessage(r) });
}

function signCancel(borrower, nonce, account = borrowerAccount) {
  return account.signTypedData({
    domain: requestDomain(),
    types: CANCEL_REQUEST_TYPES,
    primaryType: "CancelLoanRequest",
    message: { borrower, nonce: BigInt(nonce) },
  });
}

// ── an in-memory stand-in for the table, enough of supabase-js's builder ──
function fakeSupabase({ missing = false } = {}) {
  const rows = [];
  const gone = { code: "PGRST205", message: "Could not find the table" };
  function builder() {
    let cap = null;
    let op = "select";
    let patch = null;
    const filters = [];
    const b = {
      select() { return b; },
      insert(row) {
        if (missing) return Promise.resolve({ error: gone });
        const dupKey = rows.some((r) => r.borrower === row.borrower && String(r.nonce) === String(row.nonce));
        const dupOpen = rows.some((r) => r.status === "active" && r.collection === row.collection && String(r.token_id) === String(row.token_id));
        if (dupKey || dupOpen) return Promise.resolve({ error: { code: "23505", message: "duplicate" } });
        rows.push({ status: "active", created_at: new Date(1e12 + rows.length).toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
      update(p) { op = "update"; patch = p; return b; },
      eq(col, val) { filters.push((r) => String(r[col]) === String(val)); return b; },
      gt(col, val) { filters.push((r) => r[col] > val); return b; },
      order() { return b; },
      limit(n) { cap = n; return b; },
      then(resolve) {
        if (missing) return resolve({ data: null, error: gone });
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return resolve({ error: null });
        }
        return resolve({ data: cap ? hit.slice(0, cap) : hit, error: null });
      },
    };
    return b;
  }
  return { rows, from: () => builder() };
}

/** A chain where `owners` says who holds each token; signatures are checked for real. */
function fakeChain(owners = { 1234: BORROWER }) {
  return {
    owners,
    verifyDigest: ({ signer, digest, signature }) =>
      checkDigestSignature(signer, digest, signature, { getCode: async () => "0x", isValidSignature: async () => "0x00000000" }),
    ownerOf: vi.fn(async ({ tokenId }) => owners[tokenId] ?? null),
  };
}

function call(method, payload, deps) {
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = method === "GET" ? { method, query: payload } : { method, body: payload };
  return handleLoanRequestAction(req, res, { now: () => NOW, loanAddress: LOAN, ...deps }).then((handled) => ({ handled, res }));
}

async function post(deps, r = request(), account = borrowerAccount) {
  return call("POST", { action: "loan-request-create", request: r, signature: await sign(r, account) }, deps);
}

describe("loan request book: create", () => {
  it("stores a request the holder signed, and serves it back", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    const { res } = await post(deps);
    expect(res.statusCode).toBe(201);
    const list = await call("GET", { action: "loan-requests", collection: NAKA }, deps);
    expect(list.res.body.count).toBe(1);
    expect(list.res.body.requests[0].request).toEqual(request());
  });

  it("refuses a request signed by someone else", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    const { res } = await post(deps, request(), strangerAccount);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/signature/);
    expect(deps.supabase.rows).toHaveLength(0);
  });

  it("refuses a signature made under Gondi's own domain", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    const r = request();
    const signature = await sign(r, borrowerAccount, gondiDomain(LOAN));
    const { res } = await call("POST", { action: "loan-request-create", request: r, signature }, deps);
    expect(res.statusCode).toBe(400);
  });

  it("refuses a request on an NFT the borrower does not hold", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain({ 1234: strangerAccount.address }) };
    const { res } = await post(deps);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not in the borrower's wallet/);
    expect(deps.supabase.rows).toHaveLength(0);
  });

  it("refuses a token the collection says does not exist", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain({}) };
    expect((await post(deps)).res.statusCode).toBe(400);
  });

  it("refuses terms outside the venue's rules, before reading the chain", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    for (const bad of [
      { maxAprBps: "100001" },
      { principalAmount: "0" },
      { nftCollateralTokenId: "0" },
      { nftCollateralAddress: "0x1111111111111111111111111111111111111111" },
      { expirationTime: String(NOW + 31 * 86400) },
      { duration: "60" },
    ]) {
      const { res } = await post(deps, request(bad));
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(deps.chain.ownerOf).not.toHaveBeenCalled();
  });

  it("a newer request replaces the open one on the same NFT", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    await post(deps);
    const second = await post(deps, request({ nonce: "2", maxAprBps: "5000" }));
    expect(second.res.statusCode).toBe(201);
    const list = await call("GET", { action: "loan-requests" }, deps);
    expect(list.res.body.requests.map((x) => x.request.nonce)).toEqual(["2"]);
  });

  it("a replaced request cannot be posted again, and does not close the live one", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    await post(deps);
    await post(deps, request({ nonce: "2" }));
    const replay = await post(deps);
    expect(replay.res.statusCode).toBe(409);
    const list = await call("GET", { action: "loan-requests" }, deps);
    expect(list.res.body.requests.map((x) => x.request.nonce)).toEqual(["2"]);
  });
});

describe("loan request book: cancel and sync", () => {
  it("the borrower's signed cancel closes it for good", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    await post(deps);
    const { res } = await call("POST", { action: "loan-request-cancel", borrower: BORROWER, nonce: "1", signature: await signCancel(BORROWER, "1") }, deps);
    expect(res.statusCode).toBe(200);
    expect((await call("GET", { action: "loan-requests" }, deps)).res.body.count).toBe(0);
    expect((await post(deps)).res.statusCode).toBe(409);
  });

  it("nobody else can cancel it", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    await post(deps);
    const signature = await signCancel(BORROWER, "1", strangerAccount);
    const { res } = await call("POST", { action: "loan-request-cancel", borrower: BORROWER, nonce: "1", signature }, deps);
    expect(res.statusCode).toBe(400);
    expect((await call("GET", { action: "loan-requests" }, deps)).res.body.count).toBe(1);
  });

  it("sync closes a request once the NFT has left the borrower's wallet, and not before", async () => {
    const chain = fakeChain();
    const deps = { supabase: fakeSupabase(), chain };
    await post(deps);
    const still = await call("POST", { action: "loan-request-sync", collection: NAKA, tokenId: "1234" }, deps);
    expect(still.res.body.status).toBe("active");
    chain.owners[1234] = LOAN; // locked in a loan
    const gone = await call("POST", { action: "loan-request-sync", collection: NAKA, tokenId: "1234" }, deps);
    expect(gone.res.body.status).toBe("closed");
    expect((await call("GET", { action: "loan-requests" }, deps)).res.body.count).toBe(0);
  });
});

describe("loan request book: reads and outages", () => {
  it("does not serve an expired request", async () => {
    const deps = { supabase: fakeSupabase(), chain: fakeChain() };
    await post(deps);
    const later = await call("GET", { action: "loan-requests" }, { ...deps, now: () => NOW + 4 * 86400 });
    expect(later.res.body.count).toBe(0);
  });

  it("before the table exists: reads are empty, writes say nothing was saved", async () => {
    const deps = { supabase: fakeSupabase({ missing: true }), chain: fakeChain() };
    const list = await call("GET", { action: "loan-requests" }, deps);
    expect(list.res.statusCode).toBe(200);
    expect(list.res.body).toEqual({ requests: [], count: 0, live: true });
    const { res } = await post(deps);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/not open yet/);
  });

  it("a chain outage is a 503, never a stored request", async () => {
    const chain = fakeChain();
    chain.ownerOf = vi.fn(async () => { throw new Error("rpc down"); });
    const deps = { supabase: fakeSupabase(), chain };
    const { res } = await post(deps);
    expect(res.statusCode).toBe(503);
    expect(deps.supabase.rows).toHaveLength(0);
  });

  it("leaves other actions alone", async () => {
    const { handled } = await call("GET", { action: "loan-offers" }, { supabase: fakeSupabase(), chain: fakeChain() });
    expect(handled).toBe(false);
  });
});
