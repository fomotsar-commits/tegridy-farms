// The NFT loan offer book: signed Gondi v3.2 offers, stored so borrowers can find them.
//
// Served from api/orderbook.js (same CORS, rate limit, body cap and service-role Supabase
// client as the listing book). Money never passes through here: an offer is a lender's
// signature, and Gondi's loan contract checks it again when a borrower takes it. What this
// book can get wrong is only what it SHOWS, so every write is checked against the chain:
//
//   loan-offer-create  the venue's offer rules (src/lib/gondi/loanOffer.js), the signature
//                      checked exactly as Gondi's _checkSignature does, then the chain: the
//                      offer id unused, the lender holding and having approved the WETH.
//   loan-offer-sync    re-reads one offer on chain and closes it if cancelled or used up.
//                      No auth: the chain is the authority, so anyone may ask.
//   loan-record        reads a transaction receipt and records the loans in it (opened,
//                      repaid, liquidated, refinanced). No auth, same reason.
//   loan-offers (GET)  open offers, newest terms first. The site re-checks each on chain.
//   loans (GET)        a wallet's loans. The site checks each against getLoanHash.
//
// Tables: supabase/migrations/030_nft_loan_offers.sql.

import {
  createPublicClient,
  decodeEventLog,
  fallback,
  hashTypedData,
  http,
  recoverAddress,
} from "viem";
import { mainnet } from "viem/chains";
import { rpcUrlChain } from "./ethcall.js";
import { fetchWholeBody } from "../../src/lib/fetchWholeBody.js";
import { GONDI_LOAN_ABI } from "../../src/lib/gondi/abi.js";
import {
  GONDI_LOAN_ADDRESS,
  LENDING_COLLECTIONS,
  LOAN_OFFER_TYPES,
  WETH_ADDRESS,
  ZERO_ADDRESS,
  gondiDomain,
  offerToMessage,
  sameAddress,
  validateOfferShape,
} from "../../src/lib/gondi/loanOffer.js";

export const LOAN_GET_ACTIONS = new Set(["loan-offers", "loans"]);
export const LOAN_POST_ACTIONS = new Set(["loan-offer-create", "loan-offer-sync", "loan-record"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
// 65 bytes for a wallet key; a smart wallet (Safe) may send more. Bounded by the 10 KB body cap.
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2}){65,2048}$/;
const MAGICVALUE_1271 = "0x1626ba7e";
const OFFER_LIMIT = 200;
const LOAN_LIMIT = 100;

// Plain ABI objects, not parseAbi(): nothing in this file may call viem at load, because
// api/orderbook.js imports it and the listing-book tests stub viem.
const ERC20_READS = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
const ERC1271 = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
    outputs: [{ name: "", type: "bytes4" }],
  },
];
const LOAN_EVENTS = GONDI_LOAN_ABI.filter((e) => e.type === "event");

let _client = null;
function client() {
  if (!_client) {
    _client = createPublicClient({
      chain: mainnet,
      transport: fallback(rpcUrlChain().map((u) => http(u, { fetchFn: fetchWholeBody }))),
    });
  }
  return _client;
}

/** The chain reads this book needs, on a viem public client. The e2e walk passes a fork's. */
export function makeChain(getClient) {
  return {
    verifyOffer({ offer, signature, loanAddress }) {
      return checkOfferSignature(offer, signature, loanAddress, {
        getCode: (address) => getClient().getCode({ address }),
        isValidSignature: (address, digest, sig) =>
          getClient().readContract({ address, abi: ERC1271, functionName: "isValidSignature", args: [digest, sig] }),
      });
    },
    async readOfferState({ lender, offerId, loanAddress }) {
      const [cancelled, used, balance, allowance] = await getClient().multicall({
        allowFailure: false,
        contracts: [
          { address: loanAddress, abi: GONDI_LOAN_ABI, functionName: "isOfferCancelled", args: [lender, BigInt(offerId)] },
          { address: loanAddress, abi: GONDI_LOAN_ABI, functionName: "getUsedCapacity", args: [lender, BigInt(offerId)] },
          { address: WETH_ADDRESS, abi: ERC20_READS, functionName: "balanceOf", args: [lender] },
          { address: WETH_ADDRESS, abi: ERC20_READS, functionName: "allowance", args: [lender, loanAddress] },
        ],
      });
      return { cancelled, used, balance, allowance };
    },
    async getReceipt(hash) {
      try {
        return await getClient().getTransactionReceipt({ hash });
      } catch (err) {
        if (err?.name === "TransactionReceiptNotFoundError") return null;
        throw err;
      }
    },
  };
}

export const defaultChain = makeChain(client);

/**
 * BaseLoan._checkSignature, off chain: a lender with code (a Safe, or a wallet with EIP-7702
 * code) is asked isValidSignature and must answer the 1271 magic value; any other lender
 * must ecrecover to itself. The same rule the loan contract applies when the offer is taken.
 */
export async function checkOfferSignature(offer, signature, loanAddress, reads) {
  const digest = hashTypedData({
    domain: gondiDomain(loanAddress),
    types: LOAN_OFFER_TYPES,
    primaryType: "LoanOffer",
    message: offerToMessage(offer),
  });
  const code = await reads.getCode(offer.lender);
  if (code && code !== "0x") {
    try {
      return (await reads.isValidSignature(offer.lender, digest, signature)) === MAGICVALUE_1271;
    } catch {
      return false;
    }
  }
  try {
    return sameAddress(await recoverAddress({ hash: digest, signature }), offer.lender);
  } catch {
    return false;
  }
}

/** Handles one of the loan actions. Returns false when the action is not a loan action. */
export async function handleLoanAction(req, res, deps) {
  const { supabase, chain = defaultChain, now = () => Math.floor(Date.now() / 1000), loanAddress = GONDI_LOAN_ADDRESS } = deps;
  const isGet = req.method === "GET";
  const action = isGet ? req.query?.action : req.body?.action;
  if (!(isGet ? LOAN_GET_ACTIONS : LOAN_POST_ACTIONS).has(action)) return false;

  const live = !sameAddress(loanAddress, ZERO_ADDRESS);
  if (!live) {
    if (isGet) return send(res, 200, action === "loans" ? { loans: [], live: false } : { offers: [], count: 0, live: false });
    return send(res, 503, { error: "NFT lending is not live yet" });
  }
  try {
    if (action === "loan-offers") return await queryOffers(req.query, res, supabase, now);
    if (action === "loans") return await queryLoans(req.query, res, supabase);
    if (action === "loan-offer-create") return await createOffer(req.body, res, supabase, chain, now, loanAddress);
    if (action === "loan-offer-sync") return await syncOffer(req.body, res, supabase, chain, loanAddress);
    return await recordLoans(req.body, res, supabase, chain, loanAddress);
  } catch (err) {
    console.error(`[loanOffers] ${action} failed:`, err?.message ?? err);
    return send(res, 503, { error: "Could not reach the chain or the database. Nothing was saved; try again." });
  }
}

async function createOffer(body, res, supabase, chain, now, loanAddress) {
  const checked = validateOfferShape(body?.offer, now());
  if (!checked.ok) return send(res, 400, { error: checked.error });
  const offer = checked.offer;
  const signature = body?.signature;
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return send(res, 400, { error: "Missing or malformed signature" });

  if (!(await chain.verifyOffer({ offer, signature, loanAddress }))) {
    return send(res, 400, { error: "The signature is not the lender's for this offer" });
  }
  const state = await chain.readOfferState({ lender: offer.lender, offerId: offer.offerId, loanAddress });
  const principal = BigInt(offer.principalAmount);
  const capacity = BigInt(offer.capacity);
  if (state.cancelled) return send(res, 409, { error: "This offer id is already cancelled or used on chain. Sign a new offer." });
  if (capacity !== 0n && state.used >= capacity) return send(res, 409, { error: "This offer is already used up on chain." });
  if (state.balance < principal) return send(res, 400, { error: "The lender's wallet holds less WETH than the loan amount." });
  if (state.allowance < principal) return send(res, 400, { error: "The lender has not approved the loan contract for this much WETH." });

  const { error } = await supabase.from("nft_loan_offers").insert({
    lender: offer.lender.toLowerCase(),
    offer_id: offer.offerId,
    collection: offer.nftCollateralAddress.toLowerCase(),
    token_id: offer.nftCollateralTokenId,
    principal_wei: offer.principalAmount,
    apr_bps: Number(offer.aprBps),
    duration_s: Number(offer.duration),
    capacity_wei: offer.capacity,
    expires_at: new Date(Number(offer.expirationTime) * 1000).toISOString(),
    offer,
    signature,
  });
  if (error) {
    if (error.code === "23505") return send(res, 409, { error: "This lender already used that offer id. Sign a new offer." });
    throw new Error(error.message);
  }
  return send(res, 201, { ok: true, offer });
}

async function queryOffers(query, res, supabase, now) {
  const { collection, lender } = query;
  if (collection !== undefined && !LENDING_COLLECTIONS.some((c) => sameAddress(c.address, collection))) {
    return send(res, 400, { error: "Unknown collection" });
  }
  if (lender !== undefined && !ADDRESS_RE.test(lender)) return send(res, 400, { error: "Invalid lender address" });
  let q = supabase
    .from("nft_loan_offers")
    .select("offer, signature, created_at")
    .eq("status", "active")
    .gt("expires_at", new Date(now() * 1000).toISOString());
  if (collection) q = q.eq("collection", collection.toLowerCase());
  if (lender) q = q.eq("lender", lender.toLowerCase());
  const { data, error } = await q.order("created_at", { ascending: false }).limit(OFFER_LIMIT);
  if (error) throw new Error(error.message);
  const offers = (data || []).map((r) => ({ offer: r.offer, signature: r.signature, createdAt: r.created_at }));
  return send(res, 200, { offers, count: offers.length, live: true });
}

async function syncOffer(body, res, supabase, chain, loanAddress) {
  const { lender, offerId } = body ?? {};
  if (typeof lender !== "string" || !ADDRESS_RE.test(lender)) return send(res, 400, { error: "Invalid lender address" });
  if (typeof offerId !== "string" || !UINT_RE.test(offerId)) return send(res, 400, { error: "Invalid offer id" });
  const { data, error } = await supabase
    .from("nft_loan_offers")
    .select("capacity_wei, status")
    .eq("lender", lender.toLowerCase())
    .eq("offer_id", offerId)
    .limit(1);
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) return send(res, 404, { error: "No such offer in the book" });
  if (row.status !== "active") return send(res, 200, { status: row.status });
  const state = await chain.readOfferState({ lender, offerId, loanAddress });
  const capacity = BigInt(row.capacity_wei);
  const closed = state.cancelled || (capacity !== 0n && state.used >= capacity);
  if (!closed) return send(res, 200, { status: "active" });
  await closeOffer(supabase, lender, offerId);
  return send(res, 200, { status: "closed" });
}

async function closeOffer(supabase, lender, offerId) {
  const { error } = await supabase
    .from("nft_loan_offers")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("lender", lender.toLowerCase())
    .eq("offer_id", offerId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
}

async function recordLoans(body, res, supabase, chain, loanAddress) {
  const txHash = body?.txHash;
  if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) return send(res, 400, { error: "Invalid transaction hash" });
  const receipt = await chain.getReceipt(txHash);
  if (!receipt) return send(res, 404, { error: "That transaction is not on chain yet" });
  if (receipt.status !== "success") return send(res, 400, { error: "That transaction reverted, so it opened or closed no loan" });

  const touched = [];
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, loanAddress)) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: LOAN_EVENTS, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const a = ev.args;
    if (ev.eventName === "LoanEmitted") {
      await upsertLoan(supabase, a.loanId, a.loan, txHash);
      // Gondi marks a single-use offer cancelled when it is taken; mirror that in the book.
      for (const id of a.offerId) await syncTakenOffer(supabase, chain, loanAddress, a.loan, id);
      touched.push({ loanId: a.loanId.toString(), status: "open" });
    } else if (ev.eventName === "LoanRefinanced" || ev.eventName === "LoanRefinancedFromNewOffers") {
      await setLoanStatus(supabase, a.oldLoanId ?? a.loanId, "refinanced", txHash);
      await upsertLoan(supabase, a.newLoanId, a.loan, txHash);
      touched.push({ loanId: a.newLoanId.toString(), status: "open" });
    } else if (ev.eventName === "LoanRepaid") {
      await setLoanStatus(supabase, a.loanId, "repaid", txHash);
      touched.push({ loanId: a.loanId.toString(), status: "repaid" });
    } else if (ev.eventName === "LoanLiquidated") {
      await setLoanStatus(supabase, a.loanId, "liquidated", txHash);
      touched.push({ loanId: a.loanId.toString(), status: "liquidated" });
    }
  }
  if (touched.length === 0) return send(res, 400, { error: "That transaction opened or closed no loan on this venue" });
  return send(res, 200, { loans: touched });
}

async function syncTakenOffer(supabase, chain, loanAddress, loan, offerId) {
  for (const t of loan.tranche) {
    const state = await chain.readOfferState({ lender: t.lender, offerId: offerId.toString(), loanAddress });
    const { data } = await supabase
      .from("nft_loan_offers")
      .select("capacity_wei")
      .eq("lender", t.lender.toLowerCase())
      .eq("offer_id", offerId.toString())
      .limit(1);
    const capacity = data?.[0] ? BigInt(data[0].capacity_wei) : 0n;
    if (state.cancelled || (capacity !== 0n && state.used >= capacity)) await closeOffer(supabase, t.lender, offerId.toString());
  }
}

async function upsertLoan(supabase, loanId, loan, txHash) {
  const json = toJson(loan);
  const { error } = await supabase.from("nft_loans").upsert(
    {
      loan_id: loanId.toString(),
      borrower: loan.borrower.toLowerCase(),
      lender: loan.tranche[0].lender.toLowerCase(),
      collection: loan.nftCollateralAddress.toLowerCase(),
      token_id: loan.nftCollateralTokenId.toString(),
      loan: json,
      emit_tx: txHash.toLowerCase(),
    },
    { onConflict: "loan_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}

async function setLoanStatus(supabase, loanId, status, txHash) {
  const { error } = await supabase
    .from("nft_loans")
    .update({ status, close_tx: txHash.toLowerCase(), closed_at: new Date().toISOString() })
    .eq("loan_id", loanId.toString())
    .eq("status", "open");
  if (error) throw new Error(error.message);
}

async function queryLoans(query, res, supabase) {
  const { wallet } = query;
  if (typeof wallet !== "string" || !ADDRESS_RE.test(wallet)) return send(res, 400, { error: "Invalid wallet address" });
  const w = wallet.toLowerCase();
  const { data, error } = await supabase
    .from("nft_loans")
    .select("loan_id, loan, status, emit_tx, close_tx, created_at")
    .or(`borrower.eq.${w},lender.eq.${w}`)
    .order("created_at", { ascending: false })
    .limit(LOAN_LIMIT);
  if (error) throw new Error(error.message);
  const loans = (data || []).map((r) => ({
    loanId: String(r.loan_id),
    loan: r.loan,
    status: r.status,
    emitTx: r.emit_tx,
    closeTx: r.close_tx,
  }));
  return send(res, 200, { loans, live: true });
}

function toJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  return value;
}

function send(res, status, body) {
  res.status(status).json(body);
  return true;
}
