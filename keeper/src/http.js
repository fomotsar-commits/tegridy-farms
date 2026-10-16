// Read an HTTP answer with a hard size cap, counted in bytes as they arrive.
//
// res.text() and res.json() pull the whole body into memory before anyone can look
// at its size, so a broken or hostile server streaming hundreds of megabytes could
// kill a small server's process, and with it every alert. This stops reading the
// moment the cap is passed.

export class TooLarge extends Error {}

export async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge(`answer larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/** Text that came from outside, made safe to print, log and alert: one line, short. */
export function clean(text, max = 300) {
  const s = String(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
