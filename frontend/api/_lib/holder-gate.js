// Server-side enforcement of the "HOLDER EXCLUSIVE" claim the chat UI makes
// (CommunityChat.jsx:925-932). Pre-fix the only gate was hiding the textarea
// (CommunityChat.jsx:885): any SIWE-authenticated wallet holding zero NFTs
// could POST to /api/supabase-proxy and land a message in a room the UI
// advertises as holder-only. RLS (migration 004:97-102) pins `author` to the
// JWT wallet but knows nothing about NFT ownership.
//
// The client gate is not merely bypassable by crafting an API call — the
// holder count it reads comes from unsigned localStorage
// (useHolderStatus.jsx:12-17, 71-76), so writing one cache key renders the
// composer. That stays true after this change; what changes is that the send
// is now refused by the server instead of succeeding.
//
// FAIL-CLOSED: unknown slug, bad wallet, or an exhausted RPC chain DENIES.
import { alchemyUrl, padAddr, ethCall } from "./ethcall.js";

const SELECTOR_BALANCE_OF = "0x70a08231"; // balanceOf(address)

// Mirrors COLLECTIONS in frontend/src/nakamigos/constants.js:28-83. api/ is
// plain serverless JS and cannot import from src/ (constants.js pulls in
// ../lib/constants.ts), so the map is duplicated — same precedent as
// ALLOWED_CONTRACTS in api/alchemy.js:63-67. holder-gate.test.js pins parity.
export const SLUG_CONTRACTS = Object.freeze({
  nakamigos: "0xd774557b647330c91bf44cfeab205095f7e6c367",
  gnssart:   "0xa1de9f93c56c290c48849b1393b09eb616d55dbb",
  junglebay: "0xd37264c71e9af940e49795f0d3a8336afaafdda9",
});

const IS_PROD = process.env.NODE_ENV === "production"
  || process.env.VERCEL_ENV === "production"
  || process.env.VERCEL_ENV === "preview";

// supabase-proxy.js runs on the Hobby default 10s limit (only orderbook.js is
// raised, frontend/vercel.json:4-8). A fully degraded chain is 5 URLs x 2.5s
// = 12.5s, which would surface as an opaque 504 instead of an honest 503.
const GATE_BUDGET_MS = 4000;

export async function erc721BalanceOf(contract, owner) {
  const result = await ethCall(contract, `${SELECTOR_BALANCE_OF}${padAddr(owner)}`);
  if (!result || result === "0x") return 0n;
  return BigInt(result);
}

/** @returns {{ok:true}|{ok:false,status:number,error:string}} */
export async function assertChatHolder(wallet, body) {
  if (!/^0x[a-f0-9]{40}$/.test(String(wallet || ""))) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }
  const rows = Array.isArray(body) ? body : [body];
  const slugs = new Set(rows.map((r) => r?.slug));
  const deadline = Date.now() + GATE_BUDGET_MS;

  for (const slug of slugs) {
    const contract = SLUG_CONTRACTS[slug];
    if (!contract) return { ok: false, status: 403, error: "Unknown collection" };
    if (Date.now() >= deadline) {
      return { ok: false, status: 503, error: "Holder check temporarily unavailable" };
    }
    let balance;
    let budgetTimer;
    try {
      balance = await Promise.race([
        erc721BalanceOf(contract, wallet),
        new Promise((_, rej) => {
          budgetTimer = setTimeout(
            () => rej(new Error("gate-budget-exceeded")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } catch (err) {
      console.error("[holder-gate] balanceOf failed:", err?.message ?? err);
      // Local dev with no RPC reachable: skip, mirroring the documented
      // policy at seaport-verify.js:342-345 / 403-406. Prod NEVER skips.
      if (!IS_PROD && !alchemyUrl()) {
        console.warn("[holder-gate] RPC unavailable in non-prod — gate skipped");
        continue;
      }
      return { ok: false, status: 503, error: "Holder check temporarily unavailable" };
    } finally {
      // The losing leg of Promise.race keeps its timer armed otherwise, which
      // holds the lambda's event loop open for the remainder of the budget.
      clearTimeout(budgetTimer);
    }
    if (balance <= 0n) {
      return { ok: false, status: 403,
        error: "Holders only — this room requires an NFT from this collection" };
    }
  }
  return { ok: true };
}
