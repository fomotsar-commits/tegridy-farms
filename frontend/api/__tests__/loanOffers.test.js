// The NFT loan offer book (api/_lib/loanOffers.js). Money never passes through it, so what
// these pin is what it may SHOW: only offers the venue's rules allow, signed by their
// lender (checked as Gondi's contract checks it), backed by WETH the lender holds and has
// approved, and closed once the chain says so. Loans are recorded only from a successful
// transaction's own events on the venue's loan contract.
import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkOfferSignature, handleLoanAction } from "../_lib/loanOffers.js";
import { GONDI_LOAN_ABI } from "../../src/lib/gondi/abi.js";
import {
  LOAN_OFFER_TYPES,
  WETH_ADDRESS,
  ZERO_ADDRESS,
  gondiDomain,
  offerToMessage,
  wholeCollectionValidators,
} from "../../src/lib/gondi/loanOffer.js";

const LOAN = "0x2222222222222222222222222222222222222222";
const NAKA = "0xd774557b647330C91Bf44cfEAB205095f7E6c367";
const NOW = 1_800_000_000;
const lenderAccount = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const LENDER = lenderAccount.address;
const BORROWER = "0x3333333333333333333333333333333333333333";
const ONE = 10n ** 18n;

function offer(overrides = {}) {
  return {
    offerId: "7",
    lender: LENDER,
    fee: "0",
    capacity: "0",
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: "0",
    principalAddress: WETH_ADDRESS,
    principalAmount: ONE.toString(),
    aprBps: "1000",
    expirationTime: String(NOW + 86400),
    duration: String(30 * 86400),
    maxSeniorRepayment: "0",
    validators: wholeCollectionValidators(),
    lenderRefinanceDisabled: false,
    borrower: ZERO_ADDRESS,
    ...overrides,
  };
}

async function sign(o, account = lenderAccount) {
  return account.signTypedData({ domain: gondiDomain(LOAN), types: LOAN_OFFER_TYPES, primaryType: "LoanOffer", message: offerToMessage(o) });
}

// ── an in-memory stand-in for the two tables, enough of supabase-js's builder ──
function fakeSupabase() {
  const tables = { nft_loan_offers: [], nft_loans: [] };
  function builder(table) {
    let rows = null;
    let op = "select";
    let patch = null;
    const filters = [];
    const b = {
      select() { return b; },
      insert(row) {
        const pk = table === "nft_loan_offers" ? (r) => `${r.lender}:${r.offer_id}` : (r) => r.loan_id;
        if (tables[table].some((r) => pk(r) === pk(row))) return Promise.resolve({ error: { code: "23505", message: "duplicate" } });
        tables[table].push({ status: table === "nft_loans" ? "open" : "active", created_at: new Date().toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
      upsert(row) {
        if (!tables[table].some((r) => r.loan_id === row.loan_id)) tables[table].push({ status: "open", created_at: new Date().toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
      update(p) { op = "update"; patch = p; return b; },
      eq(col, val) { filters.push((r) => String(r[col]) === String(val)); return b; },
      gt(col, val) { filters.push((r) => r[col] > val); return b; },
      or(expr) {
        const ors = expr.split(",").map((p) => p.split(".eq."));
        filters.push((r) => ors.some(([c, v]) => r[c] === v));
        return b;
      },
      order() { return b; },
      limit(n) { rows = n; return b; },
      then(resolve) {
        const hit = tables[table].filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return resolve({ error: null });
        }
        return resolve({ data: rows ? hit.slice(0, rows) : hit, error: null });
      },
    };
    return b;
  }
  return { tables, from: (t) => builder(t) };
}

function okChain(overrides = {}) {
  return {
    verifyOffer: vi.fn(async ({ offer: o, signature }) =>
      checkOfferSignature(o, signature, LOAN, { getCode: async () => "0x", isValidSignature: async () => "0x" }),
    ),
    readOfferState: vi.fn(async () => ({ cancelled: false, used: 0n, balance: 5n * ONE, allowance: 5n * ONE })),
    getReceipt: vi.fn(async () => null),
    ...overrides,
  };
}

function res() {
  const r = { statusCode: 0, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

async function call(method, payload, deps) {
  const r = res();
  const req = method === "GET" ? { method, query: payload, body: {} } : { method, body: payload, query: {} };
  const handled = await handleLoanAction(req, r, { now: () => NOW, loanAddress: LOAN, ...deps });
  return { handled, status: r.statusCode, body: r.body };
}

describe("loan offer book: create", () => {
  it("stores a lender-signed whole-collection offer backed by approved WETH", async () => {
    const db = fakeSupabase();
    const o = offer();
    const out = await call("POST", { action: "loan-offer-create", offer: o, signature: await sign(o) }, { supabase: db, chain: okChain() });
    expect(out.status).toBe(201);
    expect(db.tables.nft_loan_offers).toHaveLength(1);
    expect(db.tables.nft_loan_offers[0]).toMatchObject({ lender: LENDER.toLowerCase(), offer_id: "7", token_id: "0", collection: NAKA.toLowerCase() });
  });

  it("refuses a signature from anyone but the lender", async () => {
    const db = fakeSupabase();
    const o = offer();
    const other = privateKeyToAccount(`0x${"cd".repeat(32)}`);
    const out = await call("POST", { action: "loan-offer-create", offer: o, signature: await sign(o, other) }, { supabase: db, chain: okChain() });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/not the lender's/);
    expect(db.tables.nft_loan_offers).toHaveLength(0);
  });

  it("refuses a signature over different terms (the APR edited after signing)", async () => {
    const db = fakeSupabase();
    const signature = await sign(offer());
    const out = await call("POST", { action: "loan-offer-create", offer: offer({ aprBps: "100" }), signature }, { supabase: db, chain: okChain() });
    expect(out.status).toBe(400);
    expect(db.tables.nft_loan_offers).toHaveLength(0);
  });

  it("refuses an offer outside the venue's rules before touching the chain", async () => {
    const chain = okChain();
    const o = offer({ fee: "1" });
    const out = await call("POST", { action: "loan-offer-create", offer: o, signature: await sign(o) }, { supabase: fakeSupabase(), chain });
    expect(out.status).toBe(400);
    expect(chain.verifyOffer).not.toHaveBeenCalled();
  });

  it.each([
    ["the offer id is already cancelled or used", { cancelled: true }, 409, /already cancelled or used/],
    ["the lender holds less WETH than the loan", { balance: ONE - 1n }, 400, /holds less WETH/],
    ["the lender has not approved enough WETH", { allowance: ONE - 1n }, 400, /not approved/],
  ])("refuses when %s", async (_l, state, code, msg) => {
    const db = fakeSupabase();
    const o = offer();
    const chain = okChain({ readOfferState: vi.fn(async () => ({ cancelled: false, used: 0n, balance: 5n * ONE, allowance: 5n * ONE, ...state })) });
    const out = await call("POST", { action: "loan-offer-create", offer: o, signature: await sign(o) }, { supabase: db, chain });
    expect(out.status).toBe(code);
    expect(out.body.error).toMatch(msg);
    expect(db.tables.nft_loan_offers).toHaveLength(0);
  });

  it("refuses a second offer with the same id from the same lender (Gondi tracks use per id)", async () => {
    const db = fakeSupabase();
    const o = offer();
    const sig = await sign(o);
    await call("POST", { action: "loan-offer-create", offer: o, signature: sig }, { supabase: db, chain: okChain() });
    const again = await call("POST", { action: "loan-offer-create", offer: o, signature: sig }, { supabase: db, chain: okChain() });
    expect(again.status).toBe(409);
    expect(db.tables.nft_loan_offers).toHaveLength(1);
  });

  it("saves nothing when the chain cannot be read", async () => {
    const db = fakeSupabase();
    const o = offer();
    const chain = okChain({ readOfferState: vi.fn(async () => { throw new Error("rpc down"); }) });
    const out = await call("POST", { action: "loan-offer-create", offer: o, signature: await sign(o) }, { supabase: db, chain });
    expect(out.status).toBe(503);
    expect(db.tables.nft_loan_offers).toHaveLength(0);
  });
});

describe("loan offer book: smart-wallet lenders", () => {
  it("asks a lender with code for the 1271 magic value, as Gondi does", async () => {
    const o = offer();
    const sig = await sign(o);
    const yes = await checkOfferSignature(o, sig, LOAN, { getCode: async () => "0xef0100aa", isValidSignature: async () => "0x1626ba7e" });
    const no = await checkOfferSignature(o, sig, LOAN, { getCode: async () => "0xef0100aa", isValidSignature: async () => "0xffffffff" });
    const reverts = await checkOfferSignature(o, sig, LOAN, { getCode: async () => "0xef0100aa", isValidSignature: async () => { throw new Error("revert"); } });
    expect([yes, no, reverts]).toEqual([true, false, false]);
  });
});

describe("loan offer book: reads", () => {
  it("serves open offers for a collection and hides expired and closed ones", async () => {
    const db = fakeSupabase();
    const iso = (s) => new Date(s * 1000).toISOString();
    db.tables.nft_loan_offers.push(
      { lender: "0xa", offer_id: "1", collection: NAKA.toLowerCase(), status: "active", expires_at: iso(NOW + 10), offer: { id: 1 }, signature: "0x1" },
      { lender: "0xa", offer_id: "2", collection: NAKA.toLowerCase(), status: "closed", expires_at: iso(NOW + 10), offer: { id: 2 }, signature: "0x2" },
      { lender: "0xa", offer_id: "3", collection: NAKA.toLowerCase(), status: "active", expires_at: iso(NOW - 10), offer: { id: 3 }, signature: "0x3" },
    );
    const out = await call("GET", { action: "loan-offers", collection: NAKA }, { supabase: db });
    expect(out.status).toBe(200);
    expect(out.body.offers.map((r) => r.offer.id)).toEqual([1]);
    const bad = await call("GET", { action: "loan-offers", collection: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D" }, { supabase: db });
    expect(bad.status).toBe(400);
  });

  it("says plainly when lending is not live, and refuses writes", async () => {
    const read = await call("GET", { action: "loan-offers" }, { supabase: fakeSupabase(), loanAddress: ZERO_ADDRESS });
    expect(read.body).toEqual({ offers: [], count: 0, live: false });
    const write = await call("POST", { action: "loan-offer-create" }, { supabase: fakeSupabase(), loanAddress: ZERO_ADDRESS });
    expect(write.status).toBe(503);
  });

  it("leaves non-loan actions to the listing book", async () => {
    const out = await call("GET", { action: "query" }, { supabase: fakeSupabase() });
    expect(out.handled).toBe(false);
  });
});

describe("loan offer book: sync and loan records", () => {
  it("closes an offer once the chain says it was cancelled, and only then", async () => {
    const db = fakeSupabase();
    db.tables.nft_loan_offers.push({ lender: LENDER.toLowerCase(), offer_id: "7", capacity_wei: "0", status: "active" });
    const live = await call("POST", { action: "loan-offer-sync", lender: LENDER, offerId: "7" }, { supabase: db, chain: okChain() });
    expect(live.body.status).toBe("active");
    const chain = okChain({ readOfferState: vi.fn(async () => ({ cancelled: true, used: 0n, balance: 0n, allowance: 0n })) });
    const closed = await call("POST", { action: "loan-offer-sync", lender: LENDER, offerId: "7" }, { supabase: db, chain });
    expect(closed.body.status).toBe("closed");
    expect(db.tables.nft_loan_offers[0].status).toBe("closed");
  });

  const loanStruct = {
    borrower: BORROWER,
    nftCollateralTokenId: 4242n,
    nftCollateralAddress: NAKA,
    principalAddress: WETH_ADDRESS,
    principalAmount: ONE,
    startTime: BigInt(NOW),
    duration: 2_592_000n,
    tranche: [{ loanId: 1n, floor: 0n, principalAmount: ONE, lender: LENDER, accruedInterest: 0n, startTime: BigInt(NOW), aprBps: 1000n }],
    protocolFee: 500n,
    lenderRefinanceDisabled: false,
  };
  function eventLog(name, args, address = LOAN) {
    const ev = GONDI_LOAN_ABI.find((e) => e.type === "event" && e.name === name);
    return { address, topics: encodeEventTopics({ abi: [ev], eventName: name }), data: encodeAbiParameters(ev.inputs, args) };
  }
  const TX = `0x${"1".repeat(64)}`;

  it("records a loan from its own LoanEmitted event and closes the single-use offer it took", async () => {
    const db = fakeSupabase();
    db.tables.nft_loan_offers.push({ lender: LENDER.toLowerCase(), offer_id: "7", capacity_wei: "0", status: "active" });
    const chain = okChain({
      getReceipt: vi.fn(async () => ({ status: "success", logs: [eventLog("LoanEmitted", [1n, [7n], loanStruct, 0n])] })),
      readOfferState: vi.fn(async () => ({ cancelled: true, used: 0n, balance: 0n, allowance: 0n })),
    });
    const out = await call("POST", { action: "loan-record", txHash: TX }, { supabase: db, chain });
    expect(out.status).toBe(200);
    expect(db.tables.nft_loans[0]).toMatchObject({ loan_id: "1", borrower: BORROWER.toLowerCase(), lender: LENDER.toLowerCase(), token_id: "4242" });
    expect(db.tables.nft_loans[0].loan.tranche[0].aprBps).toBe("1000");
    expect(db.tables.nft_loan_offers[0].status).toBe("closed");

    const mine = await call("GET", { action: "loans", wallet: BORROWER }, { supabase: db });
    expect(mine.body.loans.map((l) => l.loanId)).toEqual(["1"]);
  });

  it("marks a loan repaid from LoanRepaid", async () => {
    const db = fakeSupabase();
    db.tables.nft_loans.push({ loan_id: "1", borrower: BORROWER.toLowerCase(), lender: LENDER.toLowerCase(), status: "open" });
    const chain = okChain({ getReceipt: vi.fn(async () => ({ status: "success", logs: [eventLog("LoanRepaid", [1n, ONE, 0n])] })) });
    await call("POST", { action: "loan-record", txHash: TX }, { supabase: db, chain });
    expect(db.tables.nft_loans[0].status).toBe("repaid");
  });

  it("ignores another contract's look-alike events and reverted transactions", async () => {
    const db = fakeSupabase();
    const spoof = okChain({
      getReceipt: vi.fn(async () => ({ status: "success", logs: [eventLog("LoanEmitted", [1n, [7n], loanStruct, 0n], "0x9999999999999999999999999999999999999999")] })),
    });
    expect((await call("POST", { action: "loan-record", txHash: TX }, { supabase: db, chain: spoof })).status).toBe(400);
    const reverted = okChain({ getReceipt: vi.fn(async () => ({ status: "reverted", logs: [eventLog("LoanEmitted", [1n, [7n], loanStruct, 0n])] })) });
    expect((await call("POST", { action: "loan-record", txHash: TX }, { supabase: db, chain: reverted })).status).toBe(400);
    expect(db.tables.nft_loans).toHaveLength(0);
  });
});
