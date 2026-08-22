// Airdrop manifest store — the hosted claim list, and server-side proof generation.
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions and we are at 11.
//   This is dispatched from api/aggregator.js via ?resource=airdrop behind a LAZY
//   dynamic import, so the swap hot path never loads it and the function count is
//   unchanged. Same rationale as heat.js / alerts.js. See api/SERVERLESS_BUDGET.md.
//
// WHAT IT REPLACES:
//   Before this, a claimant had to be handed the creator's manifest JSON and paste it
//   into the claim page. That works and it still works (see `attach`/paste fallback in
//   ClaimPanel), but it means a campaign is claimable only for as long as the creator
//   keeps hosting a file, and it puts the entire recipient list in the hands of everyone
//   who claims. The list lives here instead and a claimant fetches one leaf.
//
// ─── THE ONE THING THIS FILE MUST NEVER DO ──────────────────────────────────
//
//   Serve the recipient list. Not paginated, not "just the count with addresses", not
//   behind an admin flag. An airdrop recipient list is a wallet-targeting database:
//   every row is an address with a balance worth phishing, pre-grouped by the criteria
//   that selected it. There is no caller for whom that is the right answer, so the
//   capability does not exist rather than being permission-checked.
//
//   Concretely, there are exactly two queries in this file that touch the entries table:
//
//     1. `fetchLeaves`  — selects `leaf_index,leaf` and NO account column. It reads
//        every row in the campaign (a tree rebuild needs all of them) and is
//        structurally incapable of returning an address.
//     2. `fetchEntry`   — filtered `account=eq.<one address>`, `limit=1`.
//
//   api/_lib/__tests__/airdrop.test.js pins both shapes. A third query that selects
//   `account` without an `account=eq.` filter is the regression this comment names.
//
// ─── THE HONESTY BOUNDARY ───────────────────────────────────────────────────
//
//   "There is no manifest for this campaign" and "this wallet is not a recipient" are
//   different facts, and only the second is about the wallet. The first is about us. A
//   claim surface that renders "you are not eligible" when the truth is "the store did
//   not answer" has told a recipient to walk away from their own money.
//
//   So: `listed: false` is emitted ONLY on a path where the manifest was read
//   successfully AND the per-account query returned zero rows. Every other failure —
//   unconfigured deployment, unapplied migration, unreachable PostgREST, absent
//   manifest, short read, unverifiable proof — gets its own status code and its own
//   `code`, and none of them carry `listed` at all. The client
//   (src/lib/merkle/manifestStore.ts) refuses to synthesise a manifest from any of
//   them, so `evaluateEligibility` sees `manifest: null` and answers `unknown`.
//
//   A proof that does not verify against the stored root is never served. It is not
//   "best effort" data and it is not a display concern: a claimant handed a bad proof
//   pays gas for a revert. That path returns 500 with `code: "proof-unverifiable"` and
//   logs, because it means the store and the tree disagree and only whoever holds the
//   original list can say which is right.
//
// ─── AUTHORITY MODEL ────────────────────────────────────────────────────────
//
//   Publishing requires a SIWE session; the manifest is attributed to that wallet and
//   only that wallet may later attach a distributor address to it.
//
//   Reading a proof requires NOTHING. Making a recipient sign a message to be told
//   their own allocation would be hostile, and it is the per-account filter — not a
//   session — that keeps the list unreadable in bulk.
//
//   Both use the SERVICE ROLE, unlike alerts.js which forwards the user's JWT. That is
//   forced by the read side: the safe read is anonymous and single-account, which RLS
//   cannot express without either trusting a client-supplied header or opening row-level
//   enumeration. So migration 018 gives `anon` and `authenticated` no policy and no
//   grant on either table, and the scoping implemented here is the only scoping there
//   is. That trade is why the two-query rule above is a hard invariant rather than a
//   style note.

import { checkRateLimit } from "./ratelimit.js";
import { isOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { readSiweSession } from "./apiAuth.js";
// ONE implementation of the leaf encoding and the tree shape, shared with the browser.
// A JS fork of these two functions is how a root the deployed bytecode cannot verify
// gets shipped, and it would surface at claim time. See src/lib/merkle/core.js.
import { hashLeaf, buildMerkleTree, merkleProof, verifyMerkleProof } from "../../src/lib/merkle/core.js";

const MANIFESTS = "airdrop_manifests";
const ENTRIES = "airdrop_manifest_entries";

/**
 * Recipients per campaign. Not a product limit — it is what one lambda invocation can
 * hash and one PostgREST request can carry without the publish silently half-landing.
 * A creator with a longer list gets a refusal that names the number, not a truncated
 * tree whose root does not match the file they uploaded.
 */
const MAX_RECIPIENTS = 5000;

/** A publish body is `MAX_RECIPIENTS` × ~70 bytes of address+amount. */
const MAX_BODY_BYTES = 1_500_000;

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ROOT_RE = /^0x[a-fA-F0-9]{64}$/;
/** Base-unit amounts cross the wire as decimal strings; a JS number loses 1e24. */
const BASE_UNITS_RE = /^\d+$/;

const MIGRATION_STEP =
  "Apply frontend/supabase/migrations/018_airdrop_manifests.sql to the Supabase project. This repo has no migration ledger — migrations are applied by hand — so the tables do not exist until an operator runs it.";

const CONFIG_STEP =
  "Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_KEY on the deployment. Publishing also needs SUPABASE_JWT_SECRET so the creator's SIWE session can be verified.";

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // Publishing reads the SIWE cookie, so the browser needs this to send it.
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function config() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

/** True when PostgREST is telling us the table is not there — never a real empty read. */
function isSchemaMissing(status, text) {
  if (status !== 404 && status !== 400) return false;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return status === 404;
  }
  const code = typeof body?.code === "string" ? body.code : "";
  const message = typeof body?.message === "string" ? body.message : "";
  return (
    code === "PGRST205" ||
    code === "PGRST202" ||
    code === "42P01" ||
    /schema cache/i.test(message) ||
    /does not exist/i.test(message)
  );
}

async function postgrest(cfg, path, init = {}) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const { text, truncated } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  // A truncated read is reported as its own failure rather than parsed. Half a
  // leaf list rebuilds a different root, and a different root is a wrong proof.
  if (truncated) return { status: 502, text: "", truncated: true };
  return { status: res.status, text, truncated: false };
}

/** Every store failure funnels through here so no caller can invent a verdict. */
function storeFailure(res, kind, detail, extra = {}) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(kind.status).json({
    error: detail,
    code: kind.code,
    // Spelled out on every failure because this is the sentence the claim surface
    // has to render instead of a verdict, and a client that only reads `error`
    // still gets it.
    notAVerdict:
      "This says nothing about whether any wallet is a recipient. Absence of a manifest is not proof of ineligibility.",
    ...extra,
  });
}

const NOT_CONFIGURED = { status: 503, code: "not-configured" };
const SCHEMA_MISSING = { status: 503, code: "schema-missing" };
const UNREACHABLE = { status: 502, code: "store-unreachable" };
const MANIFEST_MISSING = { status: 404, code: "manifest-missing" };
const PROOF_UNVERIFIABLE = { status: 500, code: "proof-unverifiable" };

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * Resolve the manifest row from either identifier.
 *
 * `root` is the campaign's identity in this store; `distributor` is what a claimant
 * actually has in hand, and it resolves only after the creator attached it. Returns a
 * discriminated result rather than throwing so every failure keeps its own code.
 */
async function loadManifest(cfg, { chainId, root, distributor }) {
  const filter = root
    ? `root=eq.${encodeURIComponent(root.toLowerCase())}`
    : `distributor=eq.${encodeURIComponent(distributor.toLowerCase())}`;
  const path = `${MANIFESTS}?select=id,chain_id,root,distributor,token,creator,recipient_count,total,criteria,created_at&chain_id=eq.${chainId}&${filter}&limit=1`;
  const { status, text } = await postgrest(cfg, path, { method: "GET" });
  if (isSchemaMissing(status, text)) return { kind: "schema-missing" };
  if (status >= 400) return { kind: "unreachable", status, text };
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return { kind: "unreachable", status, text: "unparseable" };
  }
  if (!Array.isArray(rows)) return { kind: "unreachable", status, text: "unexpected shape" };
  if (rows.length === 0) return { kind: "absent" };
  return { kind: "found", row: rows[0] };
}

/** Public shape of a manifest. Deliberately carries no addresses at all. */
function manifestMeta(row) {
  return {
    chainId: Number(row.chain_id),
    root: String(row.root),
    distributor: row.distributor ? String(row.distributor) : null,
    token: row.token ? String(row.token) : null,
    recipientCount: Number(row.recipient_count),
    total: String(row.total),
    criteria: typeof row.criteria === "string" && row.criteria !== "" ? row.criteria : null,
    publishedAt: row.created_at ? String(row.created_at) : null,
  };
}

/**
 * Every leaf in the campaign, for the tree rebuild.
 *
 * The select list is the security control: no `account`, no `amount`. This is the one
 * query that reads all rows, and it cannot return an address.
 */
async function fetchLeaves(cfg, manifestId, expectedCount) {
  const path = `${ENTRIES}?select=leaf_index,leaf&manifest_id=eq.${encodeURIComponent(manifestId)}&order=leaf_index.asc&limit=${MAX_RECIPIENTS}`;
  const { status, text, truncated } = await postgrest(cfg, path, { method: "GET" });
  if (truncated) return { kind: "unreachable", detail: "leaf read exceeded the response cap" };
  if (isSchemaMissing(status, text)) return { kind: "schema-missing" };
  if (status >= 400) return { kind: "unreachable", detail: `store answered ${status}` };
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return { kind: "unreachable", detail: "store returned unparseable JSON" };
  }
  if (!Array.isArray(rows)) return { kind: "unreachable", detail: "store returned an unexpected shape" };
  // A short read is an outage, not a smaller campaign. Rebuilding from fewer leaves
  // than were published yields a valid-looking root for a tree nobody funded, and the
  // proof under it would revert at the distributor.
  if (rows.length !== expectedCount) {
    return {
      kind: "unreachable",
      detail: `read ${rows.length} of ${expectedCount} leaves; a partial list rebuilds a different root`,
    };
  }
  const leaves = [];
  for (const r of rows) {
    const idx = Number(r?.leaf_index);
    const leaf = typeof r?.leaf === "string" ? r.leaf : "";
    if (!Number.isInteger(idx) || idx !== leaves.length || !ROOT_RE.test(leaf)) {
      return { kind: "unreachable", detail: "stored leaves are not a contiguous, well-formed sequence" };
    }
    leaves.push(leaf.toLowerCase());
  }
  return { kind: "found", leaves };
}

/** The claimant's own row, and nobody else's. */
async function fetchEntry(cfg, manifestId, account) {
  const path = `${ENTRIES}?select=leaf_index,account,amount,leaf&manifest_id=eq.${encodeURIComponent(manifestId)}&account=eq.${encodeURIComponent(account.toLowerCase())}&limit=1`;
  const { status, text } = await postgrest(cfg, path, { method: "GET" });
  if (isSchemaMissing(status, text)) return { kind: "schema-missing" };
  if (status >= 400) return { kind: "unreachable", detail: `store answered ${status}` };
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return { kind: "unreachable", detail: "store returned unparseable JSON" };
  }
  if (!Array.isArray(rows)) return { kind: "unreachable", detail: "store returned an unexpected shape" };
  // The ONLY honest negative in this file, and it is reachable only from here: the
  // manifest was read, the list was queried, and this account is not in it.
  if (rows.length === 0) return { kind: "not-listed" };
  return { kind: "found", row: rows[0] };
}

async function handleProof(req, res, cfg, ident, account) {
  const loaded = await loadManifest(cfg, ident);
  if (loaded.kind === "schema-missing") {
    return storeFailure(
      res,
      SCHEMA_MISSING,
      "The manifest tables do not exist on this deployment, so no claim list could be read. This is a missing migration, not an empty campaign.",
      { operatorStep: MIGRATION_STEP },
    );
  }
  if (loaded.kind === "unreachable") {
    console.error("airdrop manifest read failed:", loaded.status, logSafe(String(loaded.text).slice(0, 300)));
    return storeFailure(res, UNREACHABLE, "The manifest store could not be read, so no claim list was loaded.");
  }
  if (loaded.kind === "absent") {
    return storeFailure(
      res,
      MANIFEST_MISSING,
      "No manifest is stored for this campaign. The chain stores only a 32-byte root, so a campaign created before this store existed — or one whose creator never published here — has its list somewhere else.",
      { pasteFallback: true },
    );
  }

  const row = loaded.row;
  const meta = manifestMeta(row);

  const entry = await fetchEntry(cfg, row.id, account);
  if (entry.kind === "schema-missing") {
    return storeFailure(
      res,
      SCHEMA_MISSING,
      "The manifest entry table does not exist on this deployment, so the claim list could not be searched.",
      { operatorStep: MIGRATION_STEP },
    );
  }
  if (entry.kind === "unreachable") {
    console.error("airdrop entry read failed:", logSafe(entry.detail));
    return storeFailure(res, UNREACHABLE, "The claim list could not be searched, so nothing was checked.");
  }
  if (entry.kind === "not-listed") {
    // Only here. The list was read and this account is absent from it.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      manifest: meta,
      listed: false,
      detail: `${account} is not among the ${meta.recipientCount} addresses in the stored list for this campaign.`,
    });
  }

  const index = Number(entry.row.leaf_index);
  const amount = String(entry.row.amount);
  const storedAccount = String(entry.row.account);
  if (!BASE_UNITS_RE.test(amount) || !EVM_ADDRESS_RE.test(storedAccount) || !Number.isInteger(index) || index < 0) {
    console.error("airdrop entry malformed for manifest", logSafe(String(row.id)));
    return storeFailure(res, UNREACHABLE, "The stored row for this wallet is malformed, so no proof was generated.");
  }

  const leavesResult = await fetchLeaves(cfg, row.id, meta.recipientCount);
  if (leavesResult.kind === "schema-missing") {
    return storeFailure(res, SCHEMA_MISSING, "The manifest entry table does not exist on this deployment.", {
      operatorStep: MIGRATION_STEP,
    });
  }
  if (leavesResult.kind === "unreachable") {
    console.error("airdrop leaf read failed:", logSafe(leavesResult.detail));
    return storeFailure(
      res,
      UNREACHABLE,
      "The campaign's leaves could not be read in full, so no proof was generated. A proof built from a partial list would revert at the distributor.",
    );
  }

  // ─── Generation, then verification. Never one without the other. ───
  let derivedLeaf;
  let proof;
  let tree;
  try {
    // Re-derived from `account` and `amount`, not trusted from the stored `leaf`
    // column, so a tampered or drifted leaf cannot survive into a served proof.
    derivedLeaf = hashLeaf({ index, account: storedAccount, amount: BigInt(amount) });
    tree = buildMerkleTree(leavesResult.leaves);
    proof = merkleProof(tree, index);
  } catch (err) {
    console.error("airdrop proof generation threw:", logSafe(err));
    return storeFailure(
      res,
      PROOF_UNVERIFIABLE,
      "A proof could not be generated from the stored list for this campaign. The store is inconsistent with the root it recorded; nothing was served.",
      { operatorStep: "Re-publish the campaign's manifest. Do not hand out proofs from this campaign until the stored root matches its list." },
    );
  }

  const storedLeaf = String(entry.row.leaf).toLowerCase();
  const rootMatchesStore = tree.root.toLowerCase() === meta.root.toLowerCase();
  const leafMatchesStore = derivedLeaf.toLowerCase() === storedLeaf;
  const proofVerifies = verifyMerkleProof(proof, meta.root, derivedLeaf);

  if (!rootMatchesStore || !leafMatchesStore || !proofVerifies) {
    // LOUD, and nothing served. A claimant handed a proof that does not verify pays
    // gas for a revert; a claimant told "unavailable" loses nothing but a page load.
    console.error(
      "airdrop proof failed verification:",
      logSafe(
        JSON.stringify({
          manifest: String(row.id),
          rootMatchesStore,
          leafMatchesStore,
          proofVerifies,
        }),
      ),
    );
    return storeFailure(
      res,
      PROOF_UNVERIFIABLE,
      "The proof generated for this wallet does not verify against the root this campaign recorded, so it was not served. This is a fault in the stored list, not a statement about the wallet.",
      { operatorStep: "Re-publish the campaign's manifest; the stored list and the stored root disagree." },
    );
  }

  // Per-account and never shared-cacheable: an edge cache keyed on the URL would be
  // fine, but one keyed loosely is one wallet's allocation shown to another.
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    manifest: meta,
    listed: true,
    entry: { index, account: storedAccount, amount, leaf: derivedLeaf, proof },
  });
}

async function handleManifestMeta(req, res, cfg, ident) {
  const loaded = await loadManifest(cfg, ident);
  if (loaded.kind === "schema-missing") {
    return storeFailure(
      res,
      SCHEMA_MISSING,
      "The manifest tables do not exist on this deployment, so no claim list could be read.",
      { operatorStep: MIGRATION_STEP },
    );
  }
  if (loaded.kind === "unreachable") {
    console.error("airdrop manifest read failed:", loaded.status, logSafe(String(loaded.text).slice(0, 300)));
    return storeFailure(res, UNREACHABLE, "The manifest store could not be read.");
  }
  if (loaded.kind === "absent") {
    return storeFailure(
      res,
      MANIFEST_MISSING,
      "No manifest is stored for this campaign. Its list, if it has one, was published somewhere else.",
      { pasteFallback: true },
    );
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ manifest: manifestMeta(loaded.row) });
}

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * Validate and normalise a publish body into the exact tuple list the tree is built
 * from. Rejects rather than repairs: a silently dropped row changes the root away from
 * the file the creator reviewed, and they would fund a campaign that excludes people.
 */
function parseEntries(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: "entries must be an array." };
  if (raw.length === 0) return { ok: false, error: "The claim list is empty." };
  if (raw.length > MAX_RECIPIENTS) {
    return { ok: false, error: `This campaign has ${raw.length} recipients; the store accepts at most ${MAX_RECIPIENTS}.` };
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    const account = typeof e?.account === "string" ? e.account.trim() : "";
    const amount = typeof e?.amount === "string" ? e.amount.trim() : "";
    if (!EVM_ADDRESS_RE.test(account)) {
      return { ok: false, error: `Row ${i + 1} does not carry a 0x-prefixed 40-character address.` };
    }
    if (!BASE_UNITS_RE.test(amount)) {
      return {
        ok: false,
        error: `Row ${i + 1} amount must be a decimal string of BASE UNITS. A JSON number cannot carry a uint256.`,
      };
    }
    const value = BigInt(amount);
    if (value === 0n) return { ok: false, error: `Row ${i + 1} has a zero amount, which no leaf may carry.` };
    const key = account.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: `${account} appears more than once. Summing the rows would change the total you reviewed.` };
    }
    seen.add(key);
    out.push({ account: key, amount: value });
  }
  // Address order, matching buildCampaign in src/lib/merkle/campaign.ts. The index a
  // row gets is its claimed-bitmap slot forever, so it must be reproducible by anyone
  // holding the same pairs without also holding the creator's row order.
  out.sort((a, b) => (a.account < b.account ? -1 : 1));
  return { ok: true, entries: out };
}

async function handlePublish(req, res, cfg, body) {
  if (!process.env.SUPABASE_JWT_SECRET) {
    return storeFailure(
      res,
      NOT_CONFIGURED,
      "This deployment cannot verify a creator session, so no manifest can be published.",
      { operatorStep: CONFIG_STEP },
    );
  }
  // `readSiweSession` verifies the signature and the claims but does NOT consult
  // `revoked_jwts`, which alerts.js / supabase-proxy.js / auth/me.js all do. That is a
  // known and deliberate gap here, not an oversight: replicating the revocation lookup
  // would fork ~30 lines of it into a fourth copy, and the write it would protect is
  // narrow — a revoked-but-unexpired token can only publish a list attributed to its own
  // wallet, at one row per (chain, root), and can never read another campaign's list or
  // move a token. If this handler ever gains a write that is not creator-scoped and
  // idempotent, the lookup stops being optional and belongs in a shared helper rather
  // than a fifth copy.
  const session = await readSiweSession(req);
  if (!session?.wallet || !EVM_ADDRESS_RE.test(session.wallet)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).json({
      error: "Publishing a manifest is attributed to a wallet, so it needs a signed-in creator.",
      code: "signed-out",
    });
  }

  const chainId = Number(body?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return res.status(400).json({ error: "chainId must be a positive integer.", code: "bad-request" });
  }
  const token = typeof body?.token === "string" && EVM_ADDRESS_RE.test(body.token.trim()) ? body.token.trim().toLowerCase() : null;
  const criteria = typeof body?.criteria === "string" && body.criteria.trim() !== "" ? body.criteria.trim().slice(0, 2000) : null;

  const parsed = parseEntries(body?.entries);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: "bad-request" });

  let root;
  let leaves;
  let total = 0n;
  try {
    leaves = parsed.entries.map((e, index) => hashLeaf({ index, account: e.account, amount: e.amount }));
    root = buildMerkleTree(leaves).root.toLowerCase();
    for (const e of parsed.entries) total += e.amount;
  } catch (err) {
    // The builder refuses duplicate leaves and out-of-range amounts. Surfaced as a 400
    // with the builder's own words rather than a 500: this is the creator's list.
    return res.status(400).json({ error: `The list could not be turned into a tree: ${String(err?.message || err)}`, code: "bad-request" });
  }

  const insertManifest = await postgrest(cfg, MANIFESTS, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      chain_id: chainId,
      root,
      token,
      creator: session.wallet,
      recipient_count: parsed.entries.length,
      total: total.toString(),
      criteria,
    }),
  });
  if (isSchemaMissing(insertManifest.status, insertManifest.text)) {
    return storeFailure(
      res,
      SCHEMA_MISSING,
      "The manifest tables do not exist on this deployment, so this list was NOT stored. Keep your manifest JSON — nothing was saved here.",
      { operatorStep: MIGRATION_STEP, root },
    );
  }
  if (insertManifest.status === 409) {
    // Same (chain, root) already published. The root is a function of the list, so
    // this is the same list — report the root rather than pretending to have stored it
    // twice, and let the caller carry on with the campaign that exists.
    res.setHeader("Cache-Control", "no-store");
    return res.status(409).json({
      error: "This exact list is already published for this chain. The root below is the one already stored.",
      code: "already-published",
      root,
    });
  }
  if (insertManifest.status >= 400) {
    console.error("airdrop publish (manifest) failed:", insertManifest.status, logSafe(insertManifest.text.slice(0, 300)));
    return storeFailure(res, UNREACHABLE, "The manifest was not stored. Keep your manifest JSON.", { root });
  }

  let manifestRow;
  try {
    manifestRow = JSON.parse(insertManifest.text)?.[0];
  } catch {
    manifestRow = null;
  }
  if (!manifestRow?.id) {
    console.error("airdrop publish returned no manifest id");
    return storeFailure(res, UNREACHABLE, "The manifest was not stored. Keep your manifest JSON.", { root });
  }

  const rows = parsed.entries.map((e, index) => ({
    manifest_id: manifestRow.id,
    leaf_index: index,
    account: e.account,
    amount: e.amount.toString(),
    leaf: leaves[index].toLowerCase(),
  }));

  const insertEntries = await postgrest(cfg, ENTRIES, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (insertEntries.status >= 400) {
    // The header row landed and the entries did not, which is the one shape that would
    // make the store answer "manifest exists, you are not in it" for EVERY wallet — a
    // confident lie built from a half-write. Undo it and say so.
    console.error("airdrop publish (entries) failed:", insertEntries.status, logSafe(insertEntries.text.slice(0, 300)));
    await postgrest(cfg, `${MANIFESTS}?id=eq.${encodeURIComponent(manifestRow.id)}`, { method: "DELETE" }).catch(() => {});
    return storeFailure(
      res,
      UNREACHABLE,
      "The recipient rows were not stored, so the partially written manifest was removed. Nothing is published. Keep your manifest JSON.",
      { root },
    );
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(201).json({
    manifest: manifestMeta({ ...manifestRow, recipient_count: parsed.entries.length, total: total.toString() }),
    root,
  });
}

/**
 * Record the distributor address against an already-published root.
 *
 * Split from `publish` because the two happen on either side of a wallet signature:
 * the root has to be visible BEFORE funding, and the distributor address does not
 * exist until after. Creator-only, and never overwrites an existing attachment — a
 * root re-pointed at a second distributor would send claimants to the wrong contract.
 */
async function handleAttach(req, res, cfg, body) {
  const session = await readSiweSession(req);
  if (!session?.wallet) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).json({ error: "Attaching a campaign address needs a signed-in creator.", code: "signed-out" });
  }
  const chainId = Number(body?.chainId);
  const root = typeof body?.root === "string" ? body.root.trim().toLowerCase() : "";
  const distributor = typeof body?.distributor === "string" ? body.distributor.trim().toLowerCase() : "";
  if (!Number.isInteger(chainId) || chainId <= 0 || !ROOT_RE.test(root) || !EVM_ADDRESS_RE.test(distributor)) {
    return res.status(400).json({ error: "chainId, root and distributor are all required and must be well-formed.", code: "bad-request" });
  }

  // `distributor=is.null` in the filter is the no-overwrite guarantee, enforced by the
  // database in the same statement rather than by a read-then-write this handler could
  // lose a race on.
  const path = `${MANIFESTS}?chain_id=eq.${chainId}&root=eq.${encodeURIComponent(root)}&creator=eq.${encodeURIComponent(session.wallet)}&distributor=is.null`;
  const { status, text } = await postgrest(cfg, path, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ distributor }),
  });
  if (isSchemaMissing(status, text)) {
    return storeFailure(res, SCHEMA_MISSING, "The manifest tables do not exist on this deployment.", {
      operatorStep: MIGRATION_STEP,
    });
  }
  if (status >= 400) {
    console.error("airdrop attach failed:", status, logSafe(text.slice(0, 300)));
    return storeFailure(res, UNREACHABLE, "The campaign address was not recorded.");
  }
  let updated;
  try {
    updated = JSON.parse(text);
  } catch {
    updated = null;
  }
  if (!Array.isArray(updated) || updated.length === 0) {
    // No row matched. Either this wallet did not publish that root, or a distributor is
    // already attached. Both are refusals; neither is reported as a success.
    res.setHeader("Cache-Control", "no-store");
    return res.status(409).json({
      error:
        "No manifest was updated. Either this wallet did not publish that root on this chain, or a campaign address is already recorded for it — an existing attachment is never overwritten.",
      code: "attach-refused",
    });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ manifest: manifestMeta(updated[0]) });
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleAirdrop(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isOriginAllowed(req.headers?.origin || "")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // A proof read is one round-trip per claimant and a publish is rare. The ceiling is
  // low deliberately: the per-account filter stops this being a list dump, and the rate
  // limit is what stops it being a slow one against a list of addresses a caller
  // already has.
  const allowed = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "airdrop" });
  if (!allowed) return;

  const cfg = config();
  if (!cfg) {
    return storeFailure(
      res,
      NOT_CONFIGURED,
      "This deployment has no manifest store configured, so no claim list could be read or saved.",
      { operatorStep: CONFIG_STEP, pasteFallback: true },
    );
  }

  try {
    if (req.method === "POST") {
      const raw = req.body;
      const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
      if (JSON.stringify(body).length > MAX_BODY_BYTES) {
        return res.status(413).json({ error: "Request body too large", code: "bad-request" });
      }
      if (body.action === "publish") return await handlePublish(req, res, cfg, body);
      if (body.action === "attach") return await handleAttach(req, res, cfg, body);
      return res.status(400).json({ error: "Unknown action.", code: "bad-request" });
    }

    const chainId = Number(req.query.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      return res.status(400).json({ error: "chainId must be a positive integer.", code: "bad-request" });
    }
    const rootParam = typeof req.query.root === "string" ? req.query.root.trim() : "";
    const distributorParam = typeof req.query.distributor === "string" ? req.query.distributor.trim() : "";
    const root = ROOT_RE.test(rootParam) ? rootParam.toLowerCase() : null;
    const distributor = EVM_ADDRESS_RE.test(distributorParam) ? distributorParam.toLowerCase() : null;
    if (!root && !distributor) {
      return res.status(400).json({
        error: "Name the campaign by `root` (32-byte hex) or by `distributor` (address).",
        code: "bad-request",
      });
    }
    const ident = { chainId, root, distributor };

    const accountParam = typeof req.query.account === "string" ? req.query.account.trim() : "";
    if (accountParam === "") {
      // No account named: metadata only. There is no branch of this endpoint that
      // returns rows without an account, by design.
      return await handleManifestMeta(req, res, cfg, ident);
    }
    if (!EVM_ADDRESS_RE.test(accountParam)) {
      return res.status(400).json({ error: "account must be a 0x-prefixed 40-character address.", code: "bad-request" });
    }
    return await handleProof(req, res, cfg, ident, accountParam.toLowerCase());
  } catch (err) {
    console.error("airdrop error:", logSafe(err));
    return storeFailure(res, UNREACHABLE, "The manifest store could not be reached.");
  }
}
