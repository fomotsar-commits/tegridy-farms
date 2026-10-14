// viem's request timeout stops at the headers: its timer covers only the fetch it calls,
// and the body is read afterwards with no clock. Given to a transport as `fetchFn`, this
// reads the body before it returns, so viem's own timer and abort cover the whole answer.
// It starts no timer itself: the clock is the signal viem hands in.
// Plain .js because api/_lib/seaport-verify.js runs it too; types are in the .d.ts.

/** viem's default `maxResponseBodySize`. viem refuses a longer answer, so no more is held. */
const MAX_BODY_BYTES = 10_485_760;

export async function fetchWholeBody(input, init) {
  try {
    const res = await fetch(input, init);
    const body = await readBody(res);
    // `null` when nothing came: a status such as 204 refuses even an empty body.
    return new Response(body.byteLength ? body : null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (e) {
    // An abort that lands during the body read can come back under another name, and
    // viem turns only an AbortError into its TimeoutError. The signal says what happened.
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw e;
  }
}

/** The body's bytes, read no further than the first chunk past the limit. */
async function readBody(res) {
  // No stream to read in steps (a 204, or a fetch older than streams): take it whole.
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size <= MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size > MAX_BODY_BYTES) await reader.cancel();
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}
