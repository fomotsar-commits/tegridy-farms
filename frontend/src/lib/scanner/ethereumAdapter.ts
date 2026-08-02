// Ethereum data adapter for the public token scanner.
//
// Reads an ERC-20's top holders + supply through a NEW normalized route on the
// existing developer-API catchall (/api/v1?route=erc20scan&contract=0x…). That
// route is added server-side (see the build package's integrationPatch) so the
// scanner adds ZERO new top-level serverless functions and stays under the Vercel
// function cap. The client here depends only on the STABLE shape the route emits,
// not on whatever upstream explorer the route proxies.
//
// The route emits: { chain, contract, name, symbol, decimals, totalSupply,
// holdersCount, source, holders: [{ address, balance, isContract, label }] }.
// `name`/`symbol`/`decimals`/`totalSupply`/`holdersCount`/`source` may each be
// null — the explorer does not always report them. `balance` is a raw base-unit
// integer. There is deliberately no hand-written interface for that here: an
// `as`-cast asserts a shape nobody checked, and the checks below ARE the contract.
//
// DATA-GAP HONESTY: there is no free, keyless way to enumerate the FULL holder set
// of an arbitrary ERC-20 on the current infra (the Alchemy proxy is NFT-scoped;
// Etherscan's holder list is a paid endpoint; the Ponder indexer is not deployed).
// So this reads the TOP ~100 holders via the route's explorer backend — a partial,
// largest-first read (an upper bound on concentration), disclosed as such. If the
// route is not present or returns nothing, the adapter throws a typed ScanError and
// the UI self-gates to an honest "unavailable" state — it NEVER invents numbers.
//
// ── THE DEFECT THIS FILE EXISTS TO NOT HAVE ──────────────────────────────────
// The same one solanaAdapter.ts and launcher/solana/curve/rpc.ts carry at their
// heads, in this route's dialect.
//
// Every read has THREE outcomes and only two of them are answers:
//   (a) read it, the answer is no  — this token has no holders; no total reported
//   (b) read it, the answer is yes — a holder set, a supply
//   (c) COULD NOT READ IT          — a body we cannot parse, a payload whose shape
//                                    drifted, a field carrying something that is
//                                    not a number
//
// (c) is not a finding. This file collapsed it into (a) in two places:
//
//   - `Array.isArray(json.holders) ? json.holders : []` turned a body with no
//     holder list into an empty holder set, which falls straight through to
//     `ScanError('empty')` — rendered as "No holder data for this token —
//     double-check the address is a token (not a wallet or an NFT)". That is a
//     claim ABOUT SOMEONE'S TOKEN manufactured out of our own failed read, and it
//     is byte-identical to what a genuinely holder-less token produces.
//
//   - `toBig` coerced instead of rejecting: it stripped a decimal tail and then
//     every remaining non-digit, so a `totalSupply` that was not a plain decimal
//     became a DIFFERENT integer rather than an error. `"1e+21"` — what
//     `String(n)` yields for any JSON number ≥ 1e21, which is the size a meme-coin
//     supply actually is — became `121n`. Nothing throws: detection's
//     `classifyHolders` only substitutes the enumerated sum when the total is 0n,
//     so a wrong-but-nonzero denominator is used as-is, `ratio()` clamps every
//     holder at `part >= whole` → 1, and the scan SUCCEEDS and publishes 100%
//     concentration plus a fired single-holder-majority gate against a token whose
//     real top-holder share might be a fraction of a percent. The maximally
//     damning verdict, derived from a field we never managed to read.
//
// So: unreadable routes to ScanError('network'), which useTokenScan maps to
// `error` and ScannerPage renders as "Couldn't complete the scan" with a retry — a
// statement about the READ, never about the token. The codes deliberately NOT used
// for it: 'empty'/'not-found' render the "double-check the address is a token"
// copy above, and 'unavailable' renders deployment copy asserting the route is
// unconfigured. Both would launder a failed read into a finding.
//
// An explicit empty `holders: []` still means what it says — a read that came back
// with nobody in it — and still lands on 'empty'. That is case (a), and it stays.

import type { HardFacts, RawHolder, HolderCategory } from '../detection';
import { type AdapterResult, ScanError, type TokenMeta } from './scanner';

const V1_PATH = '/api/v1';

const VALID_LABELS: ReadonlySet<HolderCategory> = new Set<HolderCategory>([
  'lp',
  'cex',
  'bridge',
  'burn',
  'locker',
  'contract',
]);

/** A failed READ. Never a finding about the token — see the header. */
function unreadable(detail: string): ScanError {
  return new ScanError(
    'network',
    `Could not read the holder payload from the Ethereum data proxy (${detail}) — nothing was concluded about this token.`,
  );
}

/** What a value IS, for an unreadable's detail line. */
function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/**
 * A base-unit integer amount, or an unreadable.
 *
 * This is the VALUE-level half of the rule the shape guards enforce, and it is the
 * one that bites hardest because it does not fail — it succeeds with a wrong number.
 * A caught exception is NOT a sufficient test: `BigInt('')` is `0n` and throws
 * nothing, `BigInt('0x10')` is `16n`, and `BigInt(' 42 ')` is `42n`. So the test is
 * an explicit decimal-digits match rather than a try/catch.
 *
 * Numbers are tolerated but only when exact. Past 2^53 a JSON number's low digits
 * were already fabricated by the parse itself, so there is nothing there to read
 * even though `BigInt(Math.trunc(v))` would return a confident-looking integer.
 */
function expectBaseUnits(label: string, v: unknown): bigint {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw unreadable(`${label} was the number ${String(v)}, which is not an exact non-negative integer`);
    }
    return BigInt(v);
  }
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) {
    throw unreadable(
      `expected ${label} to be an integer base-unit amount, got ${typeof v === 'string' ? JSON.stringify(v) : describeType(v)}`,
    );
  }
  return BigInt(v);
}

/**
 * PURE: normalize the route's JSON into the detection core's input. No network,
 * no clock — unit-testable with fixtures.
 *
 * `json` is `unknown` on purpose: it comes off the wire, and the guards below are
 * the only thing that makes any statement about its shape true.
 */
export function parseEthereumScan(_contract: string, json: unknown): AdapterResult {
  // A body that is not an object cannot carry a holder list, so the guard below is
  // what reports it. This narrowing exists only so a null or primitive body reaches
  // that guard instead of throwing an untyped TypeError on the way.
  const body: Record<string, unknown> =
    typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {};

  // An absent or non-array `holders` is a payload we could not read. An `[]` IS an
  // answer and falls through to the 'empty' below — that is the whole distinction.
  const rawHolders = body.holders;
  if (!Array.isArray(rawHolders)) {
    throw unreadable(
      rawHolders === undefined
        ? 'the response carried no `holders` list'
        : `expected \`holders\` to be an array, got ${describeType(rawHolders)}`,
    );
  }

  const holders: RawHolder[] = [];
  for (const h of rawHolders) {
    const row = typeof h === 'object' && h !== null ? (h as Record<string, unknown>) : {};
    // A row whose address is not an EVM address is not a holder we can attribute to
    // anyone — dropped, as before. The BALANCE is different: it is the measurement,
    // and an unreadable one silently dropped the row, understating concentration.
    const address = typeof row.address === 'string' ? row.address : null;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const balance = expectBaseUnits(`holder ${address}'s balance`, row.balance);
    if (balance <= 0n) continue;
    const label =
      typeof row.label === 'string' && VALID_LABELS.has(row.label as HolderCategory)
        ? (row.label as HolderCategory)
        : null;
    holders.push({ address, balance, isContract: row.isContract === true, label });
  }

  // Rows arrived but NONE of them were attributable. An empty holder set is only an
  // answer when the payload itself was empty; deriving one by discarding every row it
  // did send is the same laundering in slow motion, and lands on the "No holder data
  // for this token — double-check the address is a token" copy. Non-empty in, empty
  // out, is drift. (The route now 502s this case too, so this is the client half of
  // the same guard rather than the only one.)
  if (rawHolders.length > 0 && holders.length === 0) {
    throw unreadable(`all ${rawHolders.length} holder rows were unattributable`);
  }

  if (holders.length === 0) {
    throw new ScanError('empty', 'No holder data was returned for this token.');
  }

  // null/absent is the route's documented "the explorer did not report a total" — a
  // real answer, and the core then falls back to the enumerated sum, which the
  // coverage notes already disclose as an upper bound. A total that is PRESENT but
  // unreadable is neither answer, and must not become a denominator.
  const totalSupply = body.totalSupply == null ? undefined : expectBaseUnits('`totalSupply`', body.totalSupply);
  const holdersCount = typeof body.holdersCount === 'number' ? body.holdersCount : null;

  // No free, reliable way to read mint/pause/LP-lock facts for an arbitrary ERC-20
  // here, so leave every HARD FACT unknown — unknown never fires the gate.
  const hardFacts: HardFacts = {};

  const coverage: 'full' | 'top-n' =
    holdersCount != null && holders.length >= holdersCount ? 'full' : 'top-n';

  const token: TokenMeta = {
    name: typeof body.name === 'string' ? body.name : null,
    symbol: typeof body.symbol === 'string' ? body.symbol : null,
    decimals: typeof body.decimals === 'number' ? body.decimals : null,
    holdersCount,
  };

  const source = typeof body.source === 'string' && body.source ? body.source : null;

  return {
    input: {
      holders,
      chain: 'ethereum',
      totalSupply,
      hardFacts,
      launch: { bundlesResolved: false, snipersResolved: false, tokenAgeSeconds: null },
    },
    token,
    enumeratedHolders: holders.length,
    holderCoverage: coverage,
    source: source ? `Ethereum explorer (${source}, top holders)` : 'Ethereum explorer (top holders)',
  };
}

/** Fetch + parse an ERC-20 scan through the normalized v1 route. */
export async function fetchEthereumScan(contract: string, signal?: AbortSignal): Promise<AdapterResult> {
  const url = `${V1_PATH}?route=erc20scan&contract=${encodeURIComponent(contract.toLowerCase())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  } catch {
    throw new ScanError('network', 'Could not reach the Ethereum data proxy.');
  }

  if (res.status === 429) throw new ScanError('rate-limited', 'Too many scans right now — try again in a moment.');
  // The route (or the contract allowlist that precedes it) is not yet serving
  // arbitrary ERC-20s → present this as an honest "unavailable", not a failure of
  // the token being scanned.
  // 422 = the upstream LOOKED and this address is not an ERC-20 (Ethplorer code 150,
  // which a wallet or an NFT address returns). That is an answer about the address,
  // not a failed read, and 'not-found' is the code whose copy — "double-check the
  // address is a token (not a wallet or an NFT)" — was written for it. Routing it to
  // 'network' would be the mirror of the defect this file exists to not have: a real
  // answer rendered as "Couldn't complete the scan", with a retry that can never
  // succeed no matter how many times it is pressed.
  if (res.status === 422) {
    throw new ScanError(
      'not-found',
      'That address is not an ERC-20 token contract — the explorer looked, and there is no token there.',
    );
  }
  // The route (or the contract allowlist that precedes it) is not serving this read.
  // Deliberately vague about WHICH gap: the route may be deployed and merely missing
  // its upstream API key, so blaming "the route is unconfigured" sends an operator to
  // the wrong place. The server's own message is shown alongside this one.
  if (res.status === 400 || res.status === 403 || res.status === 404 || res.status === 501) {
    throw new ScanError(
      'unavailable',
      'Ethereum token scanning is not enabled on this deployment yet — the holder-data source is unconfigured or its key is missing.',
    );
  }
  if (!res.ok) throw new ScanError('network', `Ethereum data proxy returned ${res.status}.`);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ScanError('network', 'Ethereum data proxy returned an invalid response.');
  }
  return parseEthereumScan(contract, json);
}
