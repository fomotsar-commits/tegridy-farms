// AUDIT API-H3 (R049): Bounded upstream body reader.
//
// `await response.text()` / `await response.json()` reads the entire upstream
// body into memory before the proxy can react. A malicious or compromised
// upstream that returns a 100MB JSON blob (or a gzip-bomb that decompresses
// to gigabytes) OOMs the Vercel lambda, racks up memory-time billing, and
// can DoS the function instance for legitimate traffic.
//
// This helper streams the body via `getReader()` and aborts as soon as the
// cumulative byte count exceeds `maxBytes`. If `Content-Length` is set and
// already over the cap, we short-circuit before consuming any chunks.
//
// USAGE
//   import { readBoundedText } from './_lib/bodycap.js';
//   const { text, truncated } = await readBoundedText(response, 5_000_000);
//   if (truncated) { /* upstream over-cap; treat as 502 */ }

const DEFAULT_MAX_BYTES = 5_000_000; // 5 MB — generous for JSON, blocks bombs.

// cancel() answers with a PROMISE, and on a stream that already errored (a dropped
// connection, a deadline that fired mid-body) it rejects with the stream's error. A
// try/catch only catches a synchronous throw, so the caller got its throw AND an unhandled
// rejection, which ends a Node process by default. Same rule as aggregator-proxy.js and
// alchemy-failover.js discardBody. Pinned in __tests__/bodycap.stall.test.js.
function quietCancel(target) {
  try {
    Promise.resolve(target?.cancel?.()).catch(() => {});
  } catch {
    /* best-effort only */
  }
}

/**
 * Read a fetch Response body, capped at `maxBytes`. Returns the decoded text
 * and a `truncated` flag. If the cap is hit mid-stream we cancel the reader
 * (releases the upstream socket) and return what we have — callers should
 * reject the response, not parse the partial body.
 *
 * @param {Response} response
 * @param {number} [maxBytes]
 * @returns {Promise<{ text: string, truncated: boolean, bytes: number }>}
 */
export async function readBoundedText(response, maxBytes = DEFAULT_MAX_BYTES) {
  // Fast path: if Content-Length is set and over cap, never read the body.
  const lenHeader = response.headers?.get?.("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      quietCancel(response.body);
      return { text: "", truncated: true, bytes: declared };
    }
  }

  // Stream path: read chunks until cap.
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    // Fallback for environments without streaming bodies. We still cap by
    // length after reading; callers in production hit the streaming path.
    //
    // AUDIT FIX 2026-05-26: prefer .text() when available, fall back to .json()
    // re-stringification for mock environments that only expose .json(). Real
    // fetch Response always has .text(), so this branch is mock-only in prod.
    let text;
    if (typeof response.text === "function") {
      text = await response.text();
    } else if (typeof response.json === "function") {
      text = JSON.stringify(await response.json());
    } else {
      return { text: "", truncated: false, bytes: 0 };
    }
    if (text.length > maxBytes) {
      return { text: "", truncated: true, bytes: text.length };
    }
    return { text, truncated: false, bytes: text.length };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let out = "";
  try {
     
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
      if (received > maxBytes) {
        quietCancel(reader);
        return { text: "", truncated: true, bytes: received };
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode(); // flush
    return { text: out, truncated: false, bytes: received };
  } catch (err) {
    quietCancel(reader);
    throw err;
  }
}

export const MAX_RESPONSE_BYTES = DEFAULT_MAX_BYTES;
