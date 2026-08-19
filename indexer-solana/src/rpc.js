// Solana JSON-RPC over plain fetch.
//
// No @solana/web3.js. Three methods are needed — getSlot,
// getSignaturesForAddress, getTransaction — all of them plain JSON in and JSON
// out, and Node 20 ships fetch. Adding a wallet-and-keypair SDK to a read-only
// indexer would pull a signing surface into a process whose whole job is to not
// hold keys.
//
// Every failure is TYPED, because the caller has to tell them apart: a network
// blip is retried, a pruned transaction is recorded as a gap, and a response
// shaped like nothing we recognise is neither.

export class SolanaRpcError extends Error {
  /**
   * @param {'unreachable'|'rejected'|'malformed'|'pruned'} kind
   */
  constructor(kind, message, detail) {
    super(message);
    this.name = "SolanaRpcError";
    this.kind = kind;
    this.detail = detail ?? null;
  }
}

export const RPC_TIMEOUT_MS = 20_000;

/**
 * JSON-RPC error codes that mean "this data is gone / out of range", as opposed
 * to "the node is unhappy right now". Retrying these forever is how a service
 * stops making progress while looking busy.
 *   -32004 block not available
 *   -32007 slot skipped or missing in long-term storage
 *   -32009 slot was skipped
 *   -32019 long-term storage slot not yet available
 */
const PRUNED_CODES = new Set([-32004, -32007, -32009, -32019]);

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {{ urls: string[], fetchImpl?: typeof fetch, timeoutMs?: number, onRotate?: Function }} opts
 */
export function createSolanaRpc(opts) {
  const urls = opts.urls.slice();
  if (urls.length === 0) throw new Error("createSolanaRpc requires at least one URL");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  let cursor = 0;
  let id = 0;

  async function callOnce(url, method, params) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: ac.signal,
      });
    } catch (e) {
      throw new SolanaRpcError("unreachable", `${method}: no answer from the cluster`, String(e));
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status >= 500) {
      throw new SolanaRpcError("unreachable", `${method}: cluster returned ${res.status}`);
    }
    if (!res.ok) {
      throw new SolanaRpcError("rejected", `${method}: cluster returned ${res.status}`);
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new SolanaRpcError("malformed", `${method}: response was not JSON`);
    }
    if (!isObject(body)) {
      throw new SolanaRpcError("malformed", `${method}: response was not a JSON-RPC object`);
    }
    if (isObject(body.error)) {
      const code = Number(body.error.code);
      const kind = PRUNED_CODES.has(code) ? "pruned" : "rejected";
      throw new SolanaRpcError(kind, `${method}: ${String(body.error.message ?? "rpc error")}`, code);
    }
    if (!("result" in body)) {
      throw new SolanaRpcError("malformed", `${method}: response carried neither result nor error`);
    }
    return body.result;
  }

  /**
   * Try each configured endpoint once before giving up.
   *
   * Same intent as the `fallback` transport wrapping PONDER_RPC_URL_1..4 in
   * indexer/ponder.config.ts: one provider's outage rotates instead of stalling
   * the sync. `pruned` and `rejected` do NOT rotate — a second endpoint will
   * answer the same way and rotating on them turns one honest error into N.
   */
  async function call(method, params) {
    let last;
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const url = urls[(cursor + attempt) % urls.length];
      try {
        const result = await callOnce(url, method, params);
        cursor = (cursor + attempt) % urls.length;
        return result;
      } catch (e) {
        last = e;
        if (e instanceof SolanaRpcError && e.kind !== "unreachable") throw e;
        if (opts.onRotate && attempt + 1 < urls.length) opts.onRotate(url, e);
      }
    }
    throw last;
  }

  return {
    async getSlot() {
      const slot = await call("getSlot", [{ commitment: "confirmed" }]);
      if (!Number.isInteger(slot)) {
        throw new SolanaRpcError("malformed", "getSlot: result was not an integer");
      }
      return slot;
    },

    /**
     * Newest-first, exactly as the cluster returns it.
     *
     * `until` is exclusive and is the resume point; `before` walks further back
     * within one tick. Both are signatures, not slots — the RPC offers no slot
     * form, which is why the cursor stores a signature.
     */
    async getSignaturesForAddress(address, { limit, before, until } = {}) {
      const cfg = { limit: limit ?? 200, commitment: "confirmed" };
      if (before) cfg.before = before;
      if (until) cfg.until = until;
      const result = await call("getSignaturesForAddress", [address, cfg]);
      if (!Array.isArray(result)) {
        throw new SolanaRpcError("malformed", "getSignaturesForAddress: result was not an array");
      }
      return result.map((r) => {
        if (!isObject(r) || typeof r.signature !== "string" || !Number.isInteger(r.slot)) {
          throw new SolanaRpcError("malformed", "getSignaturesForAddress: entry missing signature/slot");
        }
        return {
          signature: r.signature,
          slot: r.slot,
          blockTime: Number.isInteger(r.blockTime) ? r.blockTime : null,
          err: r.err ?? null,
        };
      });
    },

    /**
     * `jsonParsed` is what makes the balance-delta read possible: it is the
     * encoding that attaches an `owner` to every pre/post token balance. Under
     * `base64` the owner is absent and the deltas cannot be attributed.
     *
     * Returns null when the cluster has no record of the signature — the caller
     * must treat that as a gap, never as a transaction that did nothing.
     */
    async getTransaction(signature) {
      const result = await call("getTransaction", [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
      if (result === null || result === undefined) return null;
      if (!isObject(result) || !isObject(result.meta) || !Number.isInteger(result.slot)) {
        throw new SolanaRpcError("malformed", "getTransaction: result missing meta/slot");
      }
      return result;
    },
  };
}
