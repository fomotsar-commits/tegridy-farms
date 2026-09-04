/**
 * A v4 UUID from the platform CSPRNG, never from `Math.random()`.
 *
 * ONE COPY, because there were three. The alert rule store, the analytics
 * session id and the payment-link id generator each grew their own version of
 * this, and two of them fell back to `Date.now()` + `Math.random()` when
 * `crypto.randomUUID` was missing — which CodeQL flags as js/insecure-randomness
 * and which is genuinely the wrong tool: `Math.random()` is seeded per realm and
 * guarantees no uniformity, and the `Date.now()` half is predictable by
 * construction, so two ids minted in the same millisecond share a prefix.
 *
 * THE FALLBACK IS REACHABLE, which is why it exists and why it has to be good.
 * `crypto.randomUUID` is exposed only in a SECURE context, so a page served over
 * plain http has `crypto.getRandomValues` and no `randomUUID`. The branch is
 * about where the page is served from, not about how old the browser is.
 */
export function randomUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 §4.4: pin the version to 4 and the variant to 10xx, so this is a
  // real v4 UUID rather than sixteen random bytes wearing the shape of one.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
