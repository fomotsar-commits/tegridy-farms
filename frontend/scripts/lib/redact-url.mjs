// Printing an endpoint an operator can READ without printing the credential in it.
//
// WHY THIS FILE EXISTS. `bayla-ladder-ops.mjs` echoed its `--rpc` value verbatim in
// the header it prints on EVERY invocation, dry runs included:
//
//     rpc     https://solana-mainnet.g.alchemy.com/v2/<the live API key>
//
// During the 2026-09-20 BAYLA ladder mainnet go-live that line put the owner's live
// Alchemy key into a terminal screenshot that was then shared, and the key had to be
// rotated. `BAYLA_LADDER_MAINNET_RUNBOOK.md` §0 says of the keyed mainnet RPC "Never
// paste the URL into the repo" — but the tool pasted it into stdout unasked, so every
// screenshot, CI log and pasted terminal transcript carried it.
//
// The line is not the bug and must not be deleted: an operator's one defence against
// running a mainnet ceremony against the CLI's DEVNET DEFAULT is reading the host back.
// So the host is kept and everything that can carry a secret is masked.
//
// WHAT IS MASKED. Credentials live in four places in a real keyed endpoint, and all
// four are covered:
//   path       Alchemy `/v2/<key>`, Infura `/v3/<key>`, Ankr `/solana/<key>`,
//              QuickNode `/<token>/`   → every path segment that is not a short route
//                                        word becomes `***`
//   query      Helius `?api-key=<uuid>`, drpc `?dkey=<key>`  → EVERY value becomes
//              `***`, names kept. Not a list of known key names: the next provider
//              names it something else, and a value we have not heard of is exactly
//              the one that leaks.
//   userinfo   `https://user:pass@host`  → rendered `***@`, so its presence still shows
//   fragment   `#<anything>`             → `***`
//
// WHAT IS NOT, AND SAY IT PLAINLY: the HOST is printed in full, because identifying the
// host is the entire purpose of the line. A provider that puts the credential in the
// HOSTNAME is therefore not protected by this — nothing that also answers "am I on
// mainnet?" could be. Of the endpoints this repo uses, none do; QuickNode's per-account
// subdomain is not a credential on its own (the path token is).
//
// (`contracts/monitoring/lib/arbLinkage.mjs` has a stricter `redactEndpoint` that keeps
// the origin and NOTHING else. It renders into a public issue tracker, where losing the
// path shape costs nothing. It is not imported here and this is not imported there:
// frontend/ and contracts/ are separate package roots, and only frontend/ tests are
// collected by frontend/vitest.config.ts.)

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
