// @vitest-environment node
//
// Airdrop manifest store (api/_lib/airdrop.js) — server-side suite.
//
// THE TWO ASSERTIONS THIS FILE EXISTS FOR:
//
//  1. NO FULL-LIST READ. An airdrop recipient list is a wallet-targeting database, so
//     the capability must not exist rather than be permission-checked. Migration 018
//     gives no client role any grant, which makes this file's query shapes the whole
//     enforcement: the query that reads every row selects no address column, and the
//     query that returns an address is filtered to one. `describe("query shapes")` pins
//     both and fails on any third shape that selects `account` unfiltered.
//
//  2. ABSENCE OF A MANIFEST IS NOT INELIGIBILITY. `listed: false` is reachable from
//     exactly one path — manifest read, list queried, zero rows for this account. Every
//     other non-answer (unconfigured, migration unapplied, unreachable, no manifest,
//     short read, unverifiable proof) must carry its own code, must NOT carry `listed`,
//     and must not carry an `entry`. A claim surface that renders "not eligible" from an
//     outage has told a recipient to walk away from their own money.
//
// A proof that does not verify against the stored root is the third one: it fails loudly
// and serves nothing, because a claimant handed a bad proof pays gas for a revert.
//
// Mock/req/res conventions mirror api/_lib/__tests__/alerts.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashLeaf, buildMerkleTree, merkleProof } from "../../../src/lib/merkle/core.js";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const CREATOR = "0x9999999999999999999999999999999999999999";
vi.mock("../apiAuth.js", () => ({
  readSiweSession: vi.fn(async () => ({ wallet: "0x9999999999999999999999999999999999999999" })),
}));

// ─── A real campaign, so a real proof can be verified ──────────────────────
const ACCOUNTS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];
const AMOUNTS = [1000n, 2500n, 7n];
const LEAVES = ACCOUNTS.map((account, index) => hashLeaf({ index, account, amount: AMOUNTS[index] }).toLowerCase());
const TREE = buildMerkleTree(LEAVES);
const ROOT = TREE.root.toLowerCase();
const TARGET_INDEX = 1;
const TARGET = ACCOUNTS[TARGET_INDEX];
const EXPECTED_PROOF = merkleProof(TREE, TARGET_INDEX).map((p) => p.toLowerCase());

const MANIFEST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function manifestRow(over = {}) {
  return {
    id: MANIFEST_ID,
    chain_id: 1,
    root: ROOT,
    distributor: null,
    token: "0x4444444444444444444444444444444444444444",
    creator: CREATOR,
    recipient_count: ACCOUNTS.length,
    total: (AMOUNTS[0] + AMOUNTS[1] + AMOUNTS[2]).toString(),
    criteria: "holders at block 25,900,000",
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function entryRow(index = TARGET_INDEX, over = {}) {
  return {
    leaf_index: index,
    account: ACCOUNTS[index],
    amount: AMOUNTS[index].toString(),
    leaf: LEAVES[index],
    ...over,
  };
}

function leafRows() {
  return LEAVES.map((leaf, leaf_index) => ({ leaf_index, leaf }));
}

function makeReq({ method = "GET", headers = {}, body = undefined, query = {} } = {}) {
  return { method, query, body, headers: { origin: "https://memetic.fun", ...headers } };
}

function makeRes() {
  const state = { status: null, json: null, headers: {}, ended: false };
  const res = {
    setHeader: (k, v) => {
      state.headers[k] = v;
      return res;
    },
    status: (c) => {
      state.status = c;
      return res;
    },
    json: (p) => {
      state.json = p;
      return res;
    },
    end: () => {
      state.ended = true;
      return res;
    },
  };
  return { res, state };
}

function upstream(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: null,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** PostgREST's answer when the table has never been created. */
const SCHEMA_MISSING_BODY = JSON.stringify({
  code: "PGRST205",
  message: "Could not find the table 'public.airdrop_manifests' in the schema cache",
});

/**
 * Route by URL so a test states what the store HOLDS rather than the order this file
 * happens to ask in. `calls` keeps every request for the query-shape assertions.
 */
function routedFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body });
    for (const [match, responder] of routes) {
      if (match(String(url), init)) {
        return typeof responder === "function" ? responder(String(url), init) : responder;
      }
    }
    return upstream(200, []);
  });
  fn.calls = calls;
  return fn;
}

const isManifestQuery = (url, init) => url.includes("/airdrop_manifests") && (init.method || "GET") === "GET";
const isEntryQuery = (url) => url.includes("/airdrop_manifest_entries") && url.includes("account=eq.");
const isLeafQuery = (url) => url.includes("/airdrop_manifest_entries") && url.includes("select=leaf_index,leaf");

/** The store, fully populated and consistent. The baseline every failure deviates from. */
function healthyRoutes() {
  return [
    [isManifestQuery, upstream(200, [manifestRow()])],
    [isLeafQuery, upstream(200, leafRows())],
    [isEntryQuery, upstream(200, [entryRow()])],
  ];
}

let handleAirdrop;
let fetchMock;
let consoleErrorSpy;

async function load(routes) {
  fetchMock = routedFetch(routes ?? healthyRoutes());
  vi.stubGlobal("fetch", fetchMock);
  ({ handleAirdrop } = await import("../airdrop.js"));
}

function proofReq(over = {}) {
  return makeReq({ query: { resource: "airdrop", chainId: "1", root: ROOT, account: TARGET, ...over } });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NODE_ENV = "test";
  delete process.env.VERCEL_ENV;
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  process.env.SUPABASE_JWT_SECRET = "jwt-secret";
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────────
describe("gates", () => {
  it("answers OPTIONS without touching the store", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(makeReq({ method: "OPTIONS" }), res);
    expect(state.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses methods other than GET and POST", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(makeReq({ method: "DELETE" }), res);
    expect(state.status).toBe(405);
  });

  it("refuses a disallowed origin on a prod-like deployment", async () => {
    process.env.VERCEL_ENV = "production";
    await load();
    const { res, state } = makeRes();
    const req = proofReq();
    req.headers.origin = "https://attacker.example";
    await handleAirdrop(req, res);
    expect(state.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a well-formed chainId", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(makeReq({ query: { resource: "airdrop", chainId: "0", root: ROOT } }), res);
    expect(state.status).toBe(400);
  });

  it("requires the campaign to be named by root or distributor", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(makeReq({ query: { resource: "airdrop", chainId: "1" } }), res);
    expect(state.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed account rather than searching for it", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(proofReq({ account: "0xnope" }), res);
    expect(state.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("query shapes — the full-list read must not be expressible", () => {
  it("reads every leaf without selecting a single address column", async () => {
    await load();
    const { res } = makeRes();
    await handleAirdrop(proofReq(), res);

    const leafCalls = fetchMock.calls.filter((c) => isLeafQuery(c.url));
    expect(leafCalls).toHaveLength(1);
    const decoded = decodeURIComponent(leafCalls[0].url);
    // The select list IS the security control. `account` and `amount` must not appear in
    // the query that touches every row in the campaign.
    expect(decoded).toContain("select=leaf_index,leaf");
    expect(decoded).not.toMatch(/select=[^&]*account/);
    expect(decoded).not.toMatch(/select=[^&]*amount/);
  });

  it("scopes the only address-bearing read to exactly one account, capped at one row", async () => {
    await load();
    const { res } = makeRes();
    await handleAirdrop(proofReq(), res);

    const entryCalls = fetchMock.calls.filter((c) => isEntryQuery(c.url));
    expect(entryCalls).toHaveLength(1);
    expect(entryCalls[0].url).toContain(`account=eq.${TARGET.toLowerCase()}`);
    expect(entryCalls[0].url).toContain("limit=1");
  });

  it("makes NO request that selects an address column without an account filter", async () => {
    await load();
    const { res } = makeRes();
    await handleAirdrop(proofReq(), res);

    // The invariant, not the two known shapes: any request whose select list mentions
    // `account` must also pin `account=eq.`. A future third query that dumps the list
    // fails here even if it is spelled differently from anything above.
    for (const call of fetchMock.calls) {
      const decoded = decodeURIComponent(call.url);
      const select = /select=([^&]*)/.exec(decoded)?.[1] ?? "";
      if (select.includes("account")) {
        expect(decoded, `unfiltered address read: ${decoded}`).toContain("account=eq.");
      }
    }
  });

  it("never returns other recipients' rows in a successful body", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(proofReq(), res);

    expect(state.status).toBe(200);
    const serialised = JSON.stringify(state.json);
    for (const other of ACCOUNTS.filter((a) => a !== TARGET)) {
      expect(serialised).not.toContain(other);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("honesty — an outage is never a verdict", () => {
  /** Every failure shape, and the code it must be distinguishable by. */
  const cases = [
    {
      name: "no store configured",
      arrange: () => {
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_KEY;
      },
      routes: () => healthyRoutes(),
      status: 503,
      code: "not-configured",
    },
    {
      name: "migration not applied",
      routes: () => [[isManifestQuery, upstream(404, SCHEMA_MISSING_BODY)]],
      status: 503,
      code: "schema-missing",
      operatorStep: /018_airdrop_manifests\.sql/,
    },
    {
      name: "store answers 500",
      routes: () => [[isManifestQuery, upstream(500, { message: "boom" })]],
      status: 502,
      code: "store-unreachable",
    },
    {
      name: "no manifest stored for this campaign",
      routes: () => [[isManifestQuery, upstream(200, [])]],
      status: 404,
      code: "manifest-missing",
    },
    {
      name: "the entry read fails",
      routes: () => [
        [isManifestQuery, upstream(200, [manifestRow()])],
        [isEntryQuery, upstream(503, { message: "unavailable" })],
      ],
      status: 502,
      code: "store-unreachable",
    },
    {
      name: "the leaf read comes back short",
      routes: () => [
        [isManifestQuery, upstream(200, [manifestRow()])],
        [isEntryQuery, upstream(200, [entryRow()])],
        // Two of three leaves. A partial list rebuilds a DIFFERENT root, and a proof
        // under it would revert at the distributor.
        [isLeafQuery, upstream(200, leafRows().slice(0, 2))],
      ],
      status: 502,
      code: "store-unreachable",
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.status} ${c.code}, and says nothing about the wallet`, async () => {
      c.arrange?.();
      await load(c.routes());
      const { res, state } = makeRes();
      await handleAirdrop(proofReq(), res);

      expect(state.status).toBe(c.status);
      expect(state.json.code).toBe(c.code);
      // THE POINT: no verdict field at all. A client cannot mistake this for "not a
      // recipient" because there is nothing here to mistake.
      expect(state.json).not.toHaveProperty("listed");
      expect(state.json).not.toHaveProperty("entry");
      expect(state.json.notAVerdict).toMatch(/not proof of ineligibility/i);
      if (c.operatorStep) expect(state.json.operatorStep).toMatch(c.operatorStep);
      // A refusal must not be cached: it would outlive the condition that produced it.
      expect(state.headers["Cache-Control"]).toBe("no-store");
    });
  }

  it("distinguishes a missing migration from a missing manifest by code, not by prose", async () => {
    await load([[isManifestQuery, upstream(404, SCHEMA_MISSING_BODY)]]);
    const a = makeRes();
    await handleAirdrop(proofReq(), a.res);

    vi.resetModules();
    await load([[isManifestQuery, upstream(200, [])]]);
    const b = makeRes();
    await handleAirdrop(proofReq(), b.res);

    // One is an operator's unapplied SQL file, the other is a campaign whose creator
    // published elsewhere. Collapsing them sends whoever is on call to the wrong place.
    expect(a.state.json.code).toBe("schema-missing");
    expect(b.state.json.code).toBe("manifest-missing");
    expect(a.state.json.code).not.toBe(b.state.json.code);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the only honest negative", () => {
  it("reports listed:false only after reading the manifest AND querying the list", async () => {
    await load([
      [isManifestQuery, upstream(200, [manifestRow()])],
      [isLeafQuery, upstream(200, leafRows())],
      [isEntryQuery, upstream(200, [])],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(proofReq({ account: "0x8888888888888888888888888888888888888888" }), res);

    expect(state.status).toBe(200);
    expect(state.json.listed).toBe(false);
    expect(state.json).not.toHaveProperty("entry");
    // The size quoted is the CAMPAIGN's, so a wallet turned away is told what it was
    // measured against.
    expect(state.json.detail).toContain(String(ACCOUNTS.length));
    expect(state.json.manifest.recipientCount).toBe(ACCOUNTS.length);
  });

  it("carries the campaign's criteria on a negative so the wallet learns the rule that excluded it", async () => {
    await load([
      [isManifestQuery, upstream(200, [manifestRow()])],
      [isEntryQuery, upstream(200, [])],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(proofReq({ account: "0x8888888888888888888888888888888888888888" }), res);
    expect(state.json.manifest.criteria).toBe("holders at block 25,900,000");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("proof generation", () => {
  it("serves a proof that verifies, matching the tree the browser builds", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(proofReq(), res);

    expect(state.status).toBe(200);
    expect(state.json.listed).toBe(true);
    expect(state.json.entry.index).toBe(TARGET_INDEX);
    expect(state.json.entry.account.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(state.json.entry.amount).toBe(AMOUNTS[TARGET_INDEX].toString());
    expect(state.json.entry.leaf.toLowerCase()).toBe(LEAVES[TARGET_INDEX]);
    // The generated proof is the SAME proof the client-side builder produces for this
    // tree — one implementation, exercised from both sides.
    expect(state.json.entry.proof.map((p) => p.toLowerCase())).toEqual(EXPECTED_PROOF);
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });

  it("resolves a campaign by distributor address as well as by root", async () => {
    await load([
      [isManifestQuery, upstream(200, [manifestRow({ distributor: "0x5555555555555555555555555555555555555555" })])],
      [isLeafQuery, upstream(200, leafRows())],
      [isEntryQuery, upstream(200, [entryRow()])],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(
      makeReq({
        query: {
          resource: "airdrop",
          chainId: "1",
          distributor: "0x5555555555555555555555555555555555555555",
          account: TARGET,
        },
      }),
      res,
    );
    expect(state.status).toBe(200);
    expect(state.json.listed).toBe(true);
    expect(fetchMock.calls.some((c) => c.url.includes("distributor=eq."))).toBe(true);
  });

  it("REFUSES to serve a proof when the rebuilt root is not the stored root", async () => {
    // The stored root claims one list; the stored leaves are another. This is the shape a
    // partial write, a tampered row, or a leaf-encoding drift produces — and the proof it
    // yields would cost a claimant gas for a revert.
    const wrongLeaves = leafRows();
    wrongLeaves[2] = { leaf_index: 2, leaf: `0x${"ab".repeat(32)}` };
    await load([
      [isManifestQuery, upstream(200, [manifestRow()])],
      [isEntryQuery, upstream(200, [entryRow()])],
      [isLeafQuery, upstream(200, wrongLeaves)],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(proofReq(), res);

    expect(state.status).toBe(500);
    expect(state.json.code).toBe("proof-unverifiable");
    // Loudly: nothing served, and it is on the record.
    expect(state.json).not.toHaveProperty("entry");
    expect(state.json).not.toHaveProperty("listed");
    expect(consoleErrorSpy).toHaveBeenCalled();
    // Still not a verdict about the wallet.
    expect(state.json.notAVerdict).toMatch(/not proof of ineligibility/i);
  });

  it("REFUSES to serve a proof when the stored leaf disagrees with the stored account/amount", async () => {
    // A `leaf` column that does not hash from its own row. The handler re-derives rather
    // than trusting the column, so the disagreement is caught instead of served.
    await load([
      [isManifestQuery, upstream(200, [manifestRow()])],
      [isLeafQuery, upstream(200, leafRows())],
      [isEntryQuery, upstream(200, [entryRow(TARGET_INDEX, { amount: "999999" })])],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(proofReq(), res);

    expect(state.status).toBe(500);
    expect(state.json.code).toBe("proof-unverifiable");
    expect(state.json).not.toHaveProperty("entry");
  });

  it("treats a malformed stored row as an outage rather than as an absent recipient", async () => {
    await load([
      [isManifestQuery, upstream(200, [manifestRow()])],
      [isEntryQuery, upstream(200, [entryRow(TARGET_INDEX, { amount: "not-a-number" })])],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(proofReq(), res);

    expect(state.status).toBe(502);
    expect(state.json).not.toHaveProperty("listed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("metadata read", () => {
  it("returns campaign facts and no addresses when no account is named", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(makeReq({ query: { resource: "airdrop", chainId: "1", root: ROOT } }), res);

    expect(state.status).toBe(200);
    expect(state.json.manifest.recipientCount).toBe(ACCOUNTS.length);
    expect(state.json).not.toHaveProperty("entry");
    const serialised = JSON.stringify(state.json);
    for (const account of ACCOUNTS) expect(serialised).not.toContain(account);
    // No account named means no entry query at all — there is no branch that returns
    // rows without one.
    expect(fetchMock.calls.some((c) => c.url.includes("/airdrop_manifest_entries"))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("publish", () => {
  function publishReq(over = {}) {
    return makeReq({
      method: "POST",
      query: { resource: "airdrop" },
      body: {
        action: "publish",
        chainId: 1,
        token: "0x4444444444444444444444444444444444444444",
        criteria: "holders at block 25,900,000",
        entries: ACCOUNTS.map((account, i) => ({ account, amount: AMOUNTS[i].toString() })),
        ...over,
      },
    });
  }

  const isManifestInsert = (url, init) => url.includes("/airdrop_manifests") && init.method === "POST";
  const isEntryInsert = (url, init) => url.includes("/airdrop_manifest_entries") && init.method === "POST";
  const isManifestDelete = (url, init) => url.includes("/airdrop_manifests") && init.method === "DELETE";

  it("stores the list and returns the root it computed itself", async () => {
    await load([
      [isManifestInsert, upstream(201, [manifestRow()])],
      [isEntryInsert, upstream(201, "")],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(publishReq(), res);

    expect(state.status).toBe(201);
    // The root the STORE derived, which the creator compares against the browser's
    // before signing a funding transaction. Both run src/lib/merkle/core.js.
    expect(state.json.root).toBe(ROOT);
    expect(state.json.manifest.recipientCount).toBe(ACCOUNTS.length);

    const inserted = JSON.parse(fetchMock.calls.find((c) => isEntryInsert(c.url, c))?.body ?? "[]");
    expect(inserted).toHaveLength(ACCOUNTS.length);
    // Indices come from address order, not submission order, so anyone holding the same
    // pairs rebuilds the same root.
    expect(inserted.map((r) => r.account)).toEqual(ACCOUNTS.map((a) => a.toLowerCase()));
    expect(inserted.map((r) => r.leaf)).toEqual(LEAVES);
  });

  it("assigns indices by address order regardless of the order submitted", async () => {
    await load([
      [isManifestInsert, upstream(201, [manifestRow()])],
      [isEntryInsert, upstream(201, "")],
    ]);
    const reversed = ACCOUNTS.map((account, i) => ({ account, amount: AMOUNTS[i].toString() })).reverse();
    const { res, state } = makeRes();
    await handleAirdrop(publishReq({ entries: reversed }), res);

    expect(state.status).toBe(201);
    expect(state.json.root).toBe(ROOT);
  });

  it("requires a signed-in creator", async () => {
    const { readSiweSession } = await import("../apiAuth.js");
    readSiweSession.mockResolvedValueOnce(null);
    await load([[isManifestInsert, upstream(201, [manifestRow()])]]);
    const { res, state } = makeRes();
    await handleAirdrop(publishReq(), res);

    expect(state.status).toBe(401);
    expect(state.json.code).toBe("signed-out");
    expect(fetchMock.calls.some((c) => isManifestInsert(c.url, c))).toBe(false);
  });

  it("rejects an amount that is not a base-unit decimal string", async () => {
    await load();
    const { res, state } = makeRes();
    // A JSON number cannot carry a uint256; accepting one would silently round an
    // allocation and the root would describe numbers nobody chose.
    await handleAirdrop(publishReq({ entries: [{ account: ACCOUNTS[0], amount: 1e24 }] }), res);
    expect(state.status).toBe(400);
    expect(state.json.error).toMatch(/BASE UNITS/);
  });

  it("rejects a duplicated address instead of summing it", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(
      publishReq({
        entries: [
          { account: ACCOUNTS[0], amount: "10" },
          { account: ACCOUNTS[0].toUpperCase().replace("0X", "0x"), amount: "20" },
        ],
      }),
      res,
    );
    expect(state.status).toBe(400);
    expect(state.json.error).toMatch(/more than once/);
  });

  it("rejects a zero amount, which no leaf may carry", async () => {
    await load();
    const { res, state } = makeRes();
    await handleAirdrop(publishReq({ entries: [{ account: ACCOUNTS[0], amount: "0" }] }), res);
    expect(state.status).toBe(400);
  });

  it("rolls the manifest row back when the recipient rows fail to store", async () => {
    // The half-write is the dangerous shape: a manifest with no entries answers
    // "campaign exists, you are not in it" for EVERY wallet — a confident lie.
    await load([
      [isManifestInsert, upstream(201, [manifestRow()])],
      [isEntryInsert, upstream(500, { message: "boom" })],
      [isManifestDelete, upstream(204, "")],
    ]);
    const { res, state } = makeRes();
    await handleAirdrop(publishReq(), res);

    expect(state.status).toBe(502);
    expect(fetchMock.calls.some((c) => isManifestDelete(c.url, c))).toBe(true);
    expect(state.json.error).toMatch(/removed/i);
  });

  it("tells the creator nothing was stored when the migration is unapplied, and keeps the root", async () => {
    await load([[isManifestInsert, upstream(404, SCHEMA_MISSING_BODY)]]);
    const { res, state } = makeRes();
    await handleAirdrop(publishReq(), res);

    expect(state.status).toBe(503);
    expect(state.json.code).toBe("schema-missing");
    // The root is still real — the creator can fund and publish the JSON themselves.
    expect(state.json.root).toBe(ROOT);
    expect(state.json.error).toMatch(/NOT stored/);
  });

  it("reports an already-published list as a conflict carrying the same root", async () => {
    await load([[isManifestInsert, upstream(409, { code: "23505", message: "duplicate key" })]]);
    const { res, state } = makeRes();
    await handleAirdrop(publishReq(), res);

    expect(state.status).toBe(409);
    expect(state.json.code).toBe("already-published");
    expect(state.json.root).toBe(ROOT);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("attach", () => {
  const isPatch = (url, init) => url.includes("/airdrop_manifests") && init.method === "PATCH";

  function attachReq(over = {}) {
    return makeReq({
      method: "POST",
      query: { resource: "airdrop" },
      body: {
        action: "attach",
        chainId: 1,
        root: ROOT,
        distributor: "0x5555555555555555555555555555555555555555",
        ...over,
      },
    });
  }

  it("records the distributor and scopes the write to the creator and an unset slot", async () => {
    await load([[isPatch, upstream(200, [manifestRow({ distributor: "0x5555555555555555555555555555555555555555" })])]]);
    const { res, state } = makeRes();
    await handleAirdrop(attachReq(), res);

    expect(state.status).toBe(200);
    const patch = fetchMock.calls.find((c) => isPatch(c.url, c));
    expect(patch.url).toContain(`creator=eq.${CREATOR.toLowerCase()}`);
    // The no-overwrite guarantee is in the filter, enforced by the database in the same
    // statement rather than by a read-then-write this handler could lose a race on.
    expect(patch.url).toContain("distributor=is.null");
  });

  it("refuses rather than reporting success when no row matched", async () => {
    await load([[isPatch, upstream(200, [])]]);
    const { res, state } = makeRes();
    await handleAirdrop(attachReq(), res);

    expect(state.status).toBe(409);
    expect(state.json.code).toBe("attach-refused");
  });

  it("requires a signed-in creator", async () => {
    const { readSiweSession } = await import("../apiAuth.js");
    readSiweSession.mockResolvedValueOnce(null);
    await load([[isPatch, upstream(200, [manifestRow()])]]);
    const { res, state } = makeRes();
    await handleAirdrop(attachReq(), res);
    expect(state.status).toBe(401);
  });
});
