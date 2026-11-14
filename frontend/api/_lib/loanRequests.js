// The NFT loan request book: a borrower's signed "I want a loan on this NFT, on these terms",
// stored so lenders can find it and answer with an ordinary offer (loanOffers.js).
//
// Served from api/orderbook.js beside the offer book (same CORS, rate limit, body cap and
// service-role Supabase client). Money never passes through here and a request can move
// none: it is signed under its own domain, which no contract reads (src/lib/gondi/
// loanRequest.js). What this book can get wrong is only what it SHOWS, so:
//
//   loan-request-create  the venue's request rules, the borrower's signature (a wallet key,
//                        or a contract wallet asked isValidSignature), then the chain: the
//                        borrower holds the NFT now. One open request per NFT: a new one
//                        replaces the old.
//   loan-request-cancel  the borrower signs the cancel; the request closes.
//   loan-request-sync    re-reads who holds the NFT and closes a request whose borrower no
//                        longer does (sold, or locked in a loan). No auth: the chain is the
//                        authority, so anyone may ask.
//   loan-requests (GET)  open requests, newest first, and `open`: whether the book takes
//                        requests at all. The site re-checks each holder on chain.
//
// A closed request's row stays, so its signature cannot be posted again (the key is
// borrower + nonce). Table: supabase/migrations/032_nft_loan_requests.sql. Until that file
// is applied the table is missing: reads answer an empty list with `open: false`, so the
// site offers no ask form, and writes say nothing was saved.

import { hashTypedData } from "viem";
import { defaultChain } from "./loanOffers.js";
import { GONDI_LOAN_ADDRESS, LENDING_COLLECTIONS, ZERO_ADDRESS, sameAddress } from "../../src/lib/gondi/loanOffer.js";
import {
  CANCEL_REQUEST_TYPES,
  LOAN_REQUEST_TYPES,
  requestDomain,
  requestToMessage,
  validateRequestShape,
} from "../../src/lib/gondi/loanRequest.js";

export const REQUEST_GET_ACTIONS = new Set(["loan-requests"]);
export const REQUEST_POST_ACTIONS = new Set(["loan-request-create", "loan-request-cancel", "loan-request-sync"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2}){65,2048}$/;
const REQUEST_LIMIT = 200;
const TABLE = "nft_loan_requests";

/** Postgres (42P01) and PostgREST (PGRST205) both say "no such table" before the migration runs. */
function tableMissing(error) {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

class NotOpenYet extends Error {}

function check(error) {
  if (!error) return;
  if (tableMissing(error)) throw new NotOpenYet();
  throw new Error(error.message);
}

/** Handles one of the request actions. Returns false when the action is not one. */
export async function handleLoanRequestAction(req, res, deps) {
  const { supabase, chain = defaultChain, now = () => Math.floor(Date.now() / 1000), loanAddress = GONDI_LOAN_ADDRESS } = deps;
  const isGet = req.method === "GET";
  const action = isGet ? req.query?.action : req.body?.action;
  if (!(isGet ? REQUEST_GET_ACTIONS : REQUEST_POST_ACTIONS).has(action)) return false;

  if (sameAddress(loanAddress, ZERO_ADDRESS)) {
    if (isGet) return send(res, 200, { requests: [], count: 0, live: false, open: false });
    return send(res, 503, { error: "NFT lending is not live yet" });
  }
  try {
    if (action === "loan-requests") return await queryRequests(req.query, res, supabase, now);
    if (action === "loan-request-create") return await createRequest(req.body, res, supabase, chain, now);
    if (action === "loan-request-cancel") return await cancelRequest(req.body, res, supabase, chain);
    return await syncRequest(req.body, res, supabase, chain);
  } catch (err) {
    if (err instanceof NotOpenYet) {
      if (isGet) return send(res, 200, { requests: [], count: 0, live: true, open: false });
      return send(res, 503, { error: "Loan requests are not open yet. Nothing was saved." });
    }
    console.error(`[loanRequests] ${action} failed:`, err?.message ?? err);
    return send(res, 503, { error: "Could not reach the chain or the database. Nothing was saved; try again." });
  }
}

async function createRequest(body, res, supabase, chain, now) {
  const checked = validateRequestShape(body?.request, now());
  if (!checked.ok) return send(res, 400, { error: checked.error });
  const request = checked.request;
  const signature = body?.signature;
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return send(res, 400, { error: "Missing or malformed signature" });

  const digest = hashTypedData({
    domain: requestDomain(),
    types: LOAN_REQUEST_TYPES,
    primaryType: "LoanRequest",
    message: requestToMessage(request),
  });
  if (!(await chain.verifyDigest({ signer: request.borrower, digest, signature }))) {
    return send(res, 400, { error: "The signature is not the borrower's for this request" });
  }
  const owner = await chain.ownerOf({ collection: request.nftCollateralAddress, tokenId: request.nftCollateralTokenId });
  if (!sameAddress(owner, request.borrower)) {
    return send(res, 400, { error: "That NFT is not in the borrower's wallet, so it cannot be asked against." });
  }

  const collection = request.nftCollateralAddress.toLowerCase();
  const borrower = request.borrower.toLowerCase();
  // This exact request, posted before (open, cancelled or replaced): refuse before touching
  // anything, so a copied signature can neither reopen it nor close the live one.
  const seen = await supabase.from(TABLE).select("status").eq("borrower", borrower).eq("nonce", request.nonce).limit(1);
  check(seen.error);
  if (seen.data?.[0]) return send(res, 409, { error: "This request was already posted. Sign a new one." });

  // One open request per NFT: the holder's newest replaces whatever was open on it.
  const closed = await supabase
    .from(TABLE)
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("collection", collection)
    .eq("token_id", request.nftCollateralTokenId)
    .eq("status", "active");
  check(closed.error);

  const { error } = await supabase.from(TABLE).insert({
    borrower,
    nonce: request.nonce,
    collection,
    token_id: request.nftCollateralTokenId,
    principal_wei: request.principalAmount,
    max_apr_bps: Number(request.maxAprBps),
    duration_s: Number(request.duration),
    expires_at: new Date(Number(request.expirationTime) * 1000).toISOString(),
    request,
    signature,
  });
  if (error?.code === "23505") {
    return send(res, 409, { error: "Another request for this NFT was posted at the same moment. Try again." });
  }
  check(error);
  return send(res, 201, { ok: true, request });
}

async function cancelRequest(body, res, supabase, chain) {
  const { borrower, nonce, signature } = body ?? {};
  if (typeof borrower !== "string" || !ADDRESS_RE.test(borrower)) return send(res, 400, { error: "Invalid borrower address" });
  if (typeof nonce !== "string" || !UINT_RE.test(nonce)) return send(res, 400, { error: "Invalid request number" });
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return send(res, 400, { error: "Missing or malformed signature" });

  const digest = hashTypedData({
    domain: requestDomain(),
    types: CANCEL_REQUEST_TYPES,
    primaryType: "CancelLoanRequest",
    message: { borrower, nonce: BigInt(nonce) },
  });
  if (!(await chain.verifyDigest({ signer: borrower, digest, signature }))) {
    return send(res, 400, { error: "The signature is not the borrower's for this cancel" });
  }
  const found = await supabase.from(TABLE).select("status").eq("borrower", borrower.toLowerCase()).eq("nonce", nonce).limit(1);
  check(found.error);
  if (!found.data?.[0]) return send(res, 404, { error: "No such request in the book" });
  const { error } = await supabase
    .from(TABLE)
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("borrower", borrower.toLowerCase())
    .eq("nonce", nonce)
    .eq("status", "active");
  check(error);
  return send(res, 200, { status: "closed" });
}

async function syncRequest(body, res, supabase, chain) {
  const { collection, tokenId } = body ?? {};
  if (typeof collection !== "string" || !LENDING_COLLECTIONS.some((c) => sameAddress(c.address, collection))) {
    return send(res, 400, { error: "Unknown collection" });
  }
  if (typeof tokenId !== "string" || !UINT_RE.test(tokenId)) return send(res, 400, { error: "Invalid token id" });
  const found = await supabase
    .from(TABLE)
    .select("borrower")
    .eq("collection", collection.toLowerCase())
    .eq("token_id", tokenId)
    .eq("status", "active")
    .limit(1);
  check(found.error);
  const row = found.data?.[0];
  if (!row) return send(res, 200, { status: "none" });
  const owner = await chain.ownerOf({ collection, tokenId });
  if (sameAddress(owner, row.borrower)) return send(res, 200, { status: "active" });
  const { error } = await supabase
    .from(TABLE)
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("collection", collection.toLowerCase())
    .eq("token_id", tokenId)
    .eq("status", "active");
  check(error);
  return send(res, 200, { status: "closed" });
}

async function queryRequests(query, res, supabase, now) {
  const { collection, borrower } = query;
  if (collection !== undefined && !LENDING_COLLECTIONS.some((c) => sameAddress(c.address, collection))) {
    return send(res, 400, { error: "Unknown collection" });
  }
  if (borrower !== undefined && (typeof borrower !== "string" || !ADDRESS_RE.test(borrower))) {
    return send(res, 400, { error: "Invalid borrower address" });
  }
  let q = supabase
    .from(TABLE)
    .select("request, signature, created_at")
    .eq("status", "active")
    .gt("expires_at", new Date(now() * 1000).toISOString());
  if (collection) q = q.eq("collection", collection.toLowerCase());
  if (borrower) q = q.eq("borrower", borrower.toLowerCase());
  const { data, error } = await q.order("created_at", { ascending: false }).limit(REQUEST_LIMIT);
  check(error);
  const requests = (data || []).map((r) => ({ request: r.request, signature: r.signature, createdAt: r.created_at }));
  return send(res, 200, { requests, count: requests.length, live: true, open: true });
}

function send(res, status, body) {
  res.status(status).json(body);
  return true;
}
