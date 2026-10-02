// A COPY of the code in scripts/lib/redact-url.mjs, for the serverless functions.
//
// There is meant to be one endpoint redactor, at the repo root, with its contract in
// scripts/lib/redact-url.test.mjs. A function under frontend/api cannot import it: the
// Vercel project's Root Directory is frontend/, and .vercelignore uploads frontend/
// and nothing else, so an import that climbs above frontend/ resolves on a laptop and
// is missing in the deployed function. Every api/ import today stays inside frontend/.
//
// So the function runs this copy, and api/__tests__/redact-url-mirror.test.js fails if
// it differs from the root file by one character from `const MASK` on. Change the root
// file, then paste its code here. Never edit only this one.
//
// Used by api/errors.js to scrub page URLs and URLs inside error text before storage:
// the host survives, and every path segment that is not a short route word, every
// query value, any userinfo and any fragment become `***`.

const MASK = '***';

/**
 * A path segment that is a route name rather than a credential: at most eight letters,
 * optionally followed by a version number of at most two digits. `v2`, `v3`, `rpc`,
 * `api`, `solana`, `ogrpc`, `ethereum` pass; a 32-char hex key, a UUID, a base58 token
 * and anything with digits inside it do not. Every keyed endpoint in this repo's roster
 * carries a credential of 16 characters or more, so the floor is far below any of them.
 */
const ROUTE_WORD = /^[A-Za-z][A-Za-z-]{0,7}\d{0,2}$/;

/**
 * An endpoint rendered for human eyes: host intact, credential masked.
 *
 * Refuses rather than passes through. A string that is not a URL is NOT echoed — it
 * could be a bare key, and "we could not parse it" is never a reason to print it.
 *
 * @param {unknown} raw the endpoint as configured (`--rpc`, `$SOLANA_RPC`, …)
 * @returns {string} always a string, and never one containing a credential from `raw`
 */
export function redactRpcUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '[no endpoint]';

  let u;
  try {
    u = new URL(raw);
  } catch {
    return '[unreadable endpoint]';
  }
  // `file:`, `data:` and friends have no host, and there is nothing safe to show.
  if (!u.host) return '[unreadable endpoint]';

  const userinfo = u.username || u.password ? `${MASK}@` : '';

  // A root path prints as nothing when nothing follows it, so the common keyless default
  // (`https://api.devnet.solana.com`) comes back exactly as it went in — and as '/' when a
  // query does follow, so a keyed endpoint keeps the shape its operator configured.
  const root = u.pathname === '/' || u.pathname === '';
  const path = root
    ? (u.search || u.hash ? '/' : '')
    : u.pathname.split('/').map((seg) => (seg === '' || ROUTE_WORD.test(seg) ? seg : MASK)).join('/');

  // Read off the raw search string, not searchParams: a repeated parameter must stay
  // repeated rather than collapse, and one with no `=` must not be dropped.
  //
  // A pair with NO `=` IS MASKED WHOLE. `?<key>` is a real shape, and treating the pair as
  // a parameter name — names are not secrets, so names are kept — would have printed that
  // key in full. The one place the name/value split cannot be trusted is where there is no
  // split to read.
  const query = u.search
    ? `?${u.search.slice(1).split('&').map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? MASK : `${pair.slice(0, eq)}=${MASK}`;
    }).join('&')}`
    : '';

  return `${u.protocol}//${userinfo}${u.host}${path}${query}${u.hash ? `#${MASK}` : ''}`;
}
