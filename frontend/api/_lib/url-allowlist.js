// AUDIT R053: URL-scheme allowlist for proxy responses.
//
// JS port of `frontend/src/lib/imageSafety.ts:isAllowedUri` so the OpenSea
// proxy can scrub disallowed URLs before they reach the browser. The
// frontend still has its own gate, but cleaning at the proxy layer means a
// poisoned `image_url` never even hits the user's `<img src>` cache.
//
// Allowlist matches OpenSea metadata standard: https, ipfs, ar, data
// (image/png|jpeg|webp|gif only — no svg+xml, no html, no javascript:).

const HTTPS_RE = /^https:\/\//i;
const IPFS_RE = /^ipfs:\/\//i;
const AR_RE = /^ar:\/\//i;
// data:image/(png|jpeg|webp|gif);base64,...
const DATA_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

export function isAllowedUri(uri) {
  if (typeof uri !== "string") return false;
  const trimmed = uri.trim();
  if (!trimmed) return false;
  if (HTTPS_RE.test(trimmed)) return true;
  if (IPFS_RE.test(trimmed)) return true;
  if (AR_RE.test(trimmed)) return true;
  if (trimmed.toLowerCase().startsWith("data:")) return DATA_RE.test(trimmed);
  return false;
}

// Keys whose values represent URLs and should be scheme-checked. Anything
// not in the allowlist is replaced with `null` so the frontend renders its
// placeholder. We DON'T touch arbitrary string fields (e.g. `description`)
// because those are rendered as text; XSS risk there is the frontend's
// concern (React escapes by default) and we can't tell from the proxy
// which strings will ever reach `dangerouslySetInnerHTML`.
const URL_KEYS = new Set([
  "image_url",
  "image",
  "image_original_url",
  "image_preview_url",
  "image_thumbnail_url",
  "display_image_url",
  "display_animation_url",
  "animation_url",
  "external_url",
  "permalink",
  "opensea_url",
  "metadata_url",
  "token_uri",
]);

/**
 * Recursively walk a JSON value and null out URL fields whose value isn't
 * in the scheme allowlist. Mutates and returns the input.
 *
 * Works on arbitrarily nested OpenSea responses. Bounded by JSON's depth.
 */
export function sanitizeUrlFields(value) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = sanitizeUrlFields(value[i]);
    return value;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (typeof v === "string" && URL_KEYS.has(k)) {
        if (!isAllowedUri(v)) value[k] = null;
      } else if (v && typeof v === "object") {
        value[k] = sanitizeUrlFields(v);
      }
    }
  }
  return value;
}
