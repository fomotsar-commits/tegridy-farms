// Solana data adapter for the public token scanner.
//
// Reads a token's distribution through the SAME hardened same-origin RPC proxy the
// Solana swap surface uses (/api/solrpc). No new serverless function, no client-side
// RPC key. It uses only bounded, cheap JSON-RPC methods:
//
//   getTokenSupply(mint)          → authoritative total supply + decimals
//   getAccountInfo(mint)          → mint / freeze authority (HARD FACTS for the gate)
//   getTokenLargestAccounts(mint) → the top-20 token accounts (SPL caps this at 20)
//   getMultipleAccounts(...)      → resolve each token account → its owner wallet,
//                                   then classify each owner (System-Program-owned =
//                                   a real wallet; program-owned = a vault/PDA → excluded)
//
// COVERAGE: getTokenLargestAccounts is a hard top-20. That is a partial read of the
// LARGEST holders, so it yields an upper bound on concentration (disclosed by the
// scanner). Launch-time signals (bundles / snipers / token age) are NOT derivable
// from current balances, so they are left unmeasured — the core drops them from the
// blend and lowers confidence rather than assuming a flattering zero.
//
// ── THE DEFECT THIS FILE EXISTS TO NOT HAVE ──────────────────────────────────
// The same one curve/rpc.ts carries at its head, in the scanner's dialect.
//
// Every read here has THREE outcomes, and only two of them are answers:
//   (a) read it, the answer is no  — no mint at that address; no holders; renounced
//   (b) read it, the answer is yes — a supply, a holder set, a live authority
//   (c) COULD NOT READ IT          — a 200 carrying neither result nor error, an RPC
//                                    error, a payload whose shape drifted
//
// (c) is not a finding. The obvious code collapses it into (a): a missing
// `supply.value.amount` became "No SPL token supply found at that address — is it a
// valid mint?", and `largest.value ?? []` became an empty holder set, which the
// detection core reads as "no concentrated holders". Worst of all, a mint account
// that did not come back in jsonParsed form left `mintParsed?.mintAuthority != null`
// evaluating to `false` — "authority renounced" — which is the FLATTERING direction
// to be wrong in, and which silently removes the `concentrated` floor that a live
// mint authority is supposed to impose. And one level below the shapes, `safeBig`'s
// `catch { return 0n }` did the same thing to VALUES: an unreadable supply became a
// zero total, which the detection core does not read as "zero supply" but as "no
// total known" — so it substituted the enumerated top-20 sum as the denominator and
// published a concentration percentage, and a fired gate, derived from a field the
// scan never managed to read. All of them are verdicts about someone else's token
// manufactured out of our own silence, on a surface people use to decide whether to
// trust that token.
//
// So: an absent `value` member is REJECTED as unreadable, while an explicit
// `value: null` is kept as the real answer it is. The one RPC error that genuinely
// is a fact about the address (-32602 from getTokenSupply — "there is no such token
// account") keeps its "is it a valid mint?" wording. Everything unreadable throws
// ScanError('network'), which ScannerPage renders as "Couldn't complete the scan"
// with a retry — a statement about the READ, never about the token.
//
// Note the codes deliberately NOT used for this: 'not-found'/'empty' render as "No
// holder data for this token — double-check the address is a token", a claim about
// the token; 'unavailable' renders deployment copy that literally reads "Solana
// token scans work today". Both would launder a failed read into a finding.

import { normalizeHolders, type HardFacts, type RawHolder } from '../detection';
import { type AdapterResult, ScanError, type TokenMeta } from './scanner';

const SOLRPC_PATH = '/api/solrpc';
/** Accounts owned by the System Program are ordinary wallets; anything else is program-owned. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * JSON-RPC "Invalid param". Solana returns it from `getTokenSupply` for both
 * "could not find account" and "not a Token account" — the node looked, and there is
 * no SPL mint at that address. That is case (a): the single RPC error in this file
 * that is evidence about the ADDRESS rather than about the read.
 */
const INVALID_PARAM = -32602;

interface RpcCall {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

/**
 * One call's outcome.
 *
 * `ok` carries whatever the node returned — including `null`, which is an answer. A
 * call MISSING from the batch map answered nothing at all; `takeResult` turns that
 * into an unreadable rather than into a default. The old map stored `undefined` for
 * both "errored" and "never answered", which is precisely the distinction the rest
 * of this file needs.
 */
type BatchEntry =
  | { ok: true; result: unknown }
  | { ok: false; code: number | null; message: string };

/** A failed READ. Never a finding about the token — see the header. */
function unreadable(method: string, detail: string): ScanError {
  return new ScanError(
    'network',
    `Could not read ${method} from the Solana data proxy (${detail}) — nothing was concluded about this token.`,
  );
}

/** POST a JSON-RPC batch to the same-origin proxy and return outcomes keyed by id. */
async function solrpcBatch(calls: RpcCall[], signal?: AbortSignal): Promise<Map<number, BatchEntry>> {
  let res: Response;
  try {
    res = await fetch(SOLRPC_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(calls),
      signal,
    });
  } catch {
    throw new ScanError('network', 'Could not reach the Solana data proxy.');
  }
  if (res.status === 429) throw new ScanError('rate-limited', 'Too many scans right now — try again in a moment.');
  if (!res.ok) throw new ScanError('network', `Solana data proxy returned ${res.status}.`);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ScanError('network', 'Solana data proxy returned an invalid response.');
  }

  const arr: unknown[] = Array.isArray(json) ? json : [json];
  const out = new Map<number, BatchEntry>();
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (typeof r.id !== 'number') continue;

    // A batch answering the same id twice is a protocol violation, and plain last-write-wins
    // lets ARRIVAL ORDER decide whether an error is seen at all: [error, result] for one id
    // would keep the result and report a verdict about the token, while [result, error]
    // reports the read. Neither is a reading of the chain, so both are unreadable. `code`
    // stays null so this can never be mistaken for the -32602 "not a mint" answer.
    if (out.has(r.id)) {
      out.set(r.id, { ok: false, code: null, message: `the batch answered id ${r.id} more than once` });
      continue;
    }

    if (r.error && typeof r.error === 'object') {
      out.set(r.id, {
        ok: false,
        code: typeof r.error.code === 'number' ? r.error.code : null,
        message: typeof r.error.message === 'string' ? r.error.message : 'unknown RPC error',
      });
      continue;
    }
    // `'result' in r` rather than `r.result !== undefined`: an explicit `"result":
    // null` is a real answer and must survive, while a body with no `result` member
    // at all is a non-answer. Leaving it out of the map is what makes `takeResult`
    // report it as unreadable instead of as a default.
    if ('result' in r) out.set(r.id, { ok: true, result: r.result });
  }
  return out;
}

/**
 * The result of call `id`, or a typed unreadable.
 *
 * Both "the proxy never answered this call" and "the node returned an error" are
 * failed reads here. The one error that is an answer (-32602 on getTokenSupply) is
 * checked by the caller BEFORE this, because it is the only one that is a fact about
 * the address rather than about the read.
 */
function takeResult(batch: Map<number, BatchEntry>, id: number, method: string): unknown {
  const entry = batch.get(id);
  if (!entry) throw unreadable(method, 'the proxy returned neither a result nor an error');
  if (!entry.ok) throw unreadable(method, entry.message);
  return entry.result;
}

// ── shape guards: a shape we did not expect is never evidence ─────────────────

/** Narrow an RPC payload to an object, or say the shape was wrong. */
function expectRpcObject(method: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) {
    throw unreadable(method, `expected an object, got ${v === null ? 'null' : typeof v}`);
  }
  return v as Record<string, unknown>;
}

/**
 * Pull `.value` out of an RPC context wrapper.
 *
 * `value: null` is a real answer ("no account here") and is returned as `null`. A
 * MISSING `value` member is a malformed response and throws, because "the account is
 * absent" and "the server did not answer" are different facts and only one of them
 * is about the chain.
 */
function expectRpcValue(method: string, payload: unknown): unknown {
  const o = expectRpcObject(method, payload);
  if (!('value' in o)) throw unreadable(method, 'the response carried no `value`');
  return o.value;
}

/** `.value` as an array. Replaces the `?? []` that turned a failed read into "no holders". */
function expectRpcArray(method: string, payload: unknown): unknown[] {
  const v = expectRpcValue(method, payload);
  if (!Array.isArray(v)) {
    throw unreadable(method, `expected \`value\` to be an array, got ${v === null ? 'null' : typeof v}`);
  }
  return v;
}

/**
 * A base-unit integer amount, or an unreadable.
 *
 * This is the VALUE-level half of the same rule the shape guards enforce, and it is the
 * one that bites hardest, because it fails in both forbidden directions at once:
 *   - an unreadable SUPPLY becomes `0n`, and the detection core treats a zero total as
 *     "no total supply known" and silently substitutes the sum of the enumerated top-20
 *     as the denominator (detection/exclusions.ts). The scan then SUCCEEDS and publishes
 *     a concentration figure — and can fire the `single-holder-majority` gate — computed
 *     entirely from a field we could not read;
 *   - an unreadable HOLDER balance becomes `0n` and the row is dropped, and dropping
 *     every row lands on `ScanError('empty')`: "No holder data for this token."
 *
 * A `try { BigInt(s) } catch { return 0n }` is NOT sufficient here: `BigInt('')` is `0n`
 * and throws nothing at all. `BigInt('0x10')` is `16n` and `BigInt(' 42 ')` is `42n` —
 * neither is a shape an SPL base-unit amount ever has. So the test is an explicit
 * decimal-digits match rather than a caught exception.
 */
function expectBaseUnits(method: string, s: string): bigint {
  if (!/^[0-9]+$/.test(s)) {
    throw unreadable(method, `expected an integer base-unit amount, got ${JSON.stringify(s)}`);
  }
  return BigInt(s);
}

/** One `getTokenLargestAccounts` row, after validation. */
interface LargestEntry {
  address: string;
  balance: bigint;
}

/**
 * Validate the top-N rows.
 *
 * Every row must carry both fields. The previous code filtered rows without an
 * `address` out of the list it sent to `getMultipleAccounts` while still indexing
 * the responses by the UNFILTERED position, so a single drifted row would have
 * silently attributed every later holder to the wrong owner wallet. Rejecting the
 * drift outright removes that hazard rather than guarding it, and lets `fetch` and
 * `parse` derive the same list from the same function — which is what keeps the
 * three arrays index-aligned.
 */
function largestEntries(payload: unknown): LargestEntry[] {
  const method = 'getTokenLargestAccounts';
  return (
    expectRpcArray(method, payload)
      .map((row, i) => {
        const o = expectRpcObject(method, row);
        if (typeof o.address !== 'string' || typeof o.amount !== 'string') {
          throw unreadable(method, `entry ${i} carried no address/amount pair`);
        }
        return { address: o.address, balance: expectBaseUnits(method, o.amount) };
      })
      // Zero-balance rows (a closed or drained ATA the node still lists) are dropped HERE
      // rather than in the parse loop, so the follow-up batches are requested for exactly
      // the rows that will be read. Filtering compacts the array, which is safe — and only
      // safe — because `fetch` and `parse` both derive it from this one function, so their
      // arrays are identical. That is the same property that makes index alignment sound;
      // filtering in one path and indexing the unfiltered array in the other was the
      // original hazard.
      .filter((e) => e.balance > 0n)
  );
}

/**
 * `data.parsed.info` from a jsonParsed account, or null when it is not there.
 *
 * Returning null rather than an empty object is load-bearing: every caller reads
 * fields off this with `!= null`, so an `undefined` standing in for a missing parse
 * would read as "the authority is renounced".
 */
function jsonParsedInfo(account: Record<string, unknown>): Record<string, unknown> | null {
  const data = account.data;
  if (typeof data !== 'object' || data === null) return null;
  const parsed = (data as Record<string, unknown>).parsed;
  if (typeof parsed !== 'object' || parsed === null) return null;
  const info = (parsed as Record<string, unknown>).info;
  if (typeof info !== 'object' || info === null) return null;
  return info as Record<string, unknown>;
}

/**
 * The wallet that owns token account `i`.
 *
 * Strict on purpose. The old `?? tokenAccount` fallback made an unparsable response
 * look like a token account owned by itself, so a whale's several ATAs would each
 * count as a separate holder — understating concentration, again in the flattering
 * direction. These accounts were just named by `getTokenLargestAccounts`, so a null
 * or unparsed entry here is drift, not absence.
 */
function tokenAccountOwner(i: number, entry: unknown): string {
  const method = 'getMultipleAccounts';
  if (entry === null) {
    // getMultipleAccounts answers `null` for an address with no account, and elsewhere in
    // this file that is a real answer. Not here: these addresses came back from
    // getTokenLargestAccounts moments earlier WITH a positive balance, so a null means the
    // account was closed mid-read. There is no owner to report, and guessing one (the old
    // `?? tokenAccount`) invents a holder. Fail closed — the page offers a retry, which
    // self-heals on the next read.
    throw unreadable(method, `token account ${i} no longer exists`);
  }
  const info = jsonParsedInfo(expectRpcObject(method, entry));
  const owner = info?.owner;
  if (typeof owner !== 'string') {
    throw unreadable(method, `token account ${i} carried no parsed owner`);
  }
  return owner;
}

/** Reject a length mismatch: index alignment across the three arrays is what groups ATAs. */
function expectSameLength(method: string, got: unknown[], want: number, label: string): unknown[] {
  if (got.length !== want) {
    throw unreadable(method, `expected ${want} ${label}, got ${got.length}`);
  }
  return got;
}

/**
 * The already-fetched RPC payloads, so parsing is a PURE, unit-testable step.
 *
 * Every field is `unknown` rather than a hand-written shape: these come off the wire
 * and the previous `as`-casts asserted a shape nobody had checked, which is what let
 * a drifted payload flow into a confident finding. The guards above are the check.
 */
export interface SolanaScanRaw {
  mint: string;
  supply: unknown;
  mintInfo: unknown;
  largest: unknown;
  /** getMultipleAccounts(jsonParsed) over the largest token accounts — resolves owner wallets. */
  tokenAccounts: unknown;
  /** getMultipleAccounts(base64) over the owner wallets — classifies program-owned vaults. */
  ownerAccounts: unknown;
}

/**
 * Turn the raw Solana RPC payloads into the detection core's input. PURE — no
 * network, no clock — so the whole normalization path is testable with fixtures.
 */
export function parseSolanaScan(raw: SolanaScanRaw): AdapterResult {
  // ── supply ─────────────────────────────────────────────────────────────────
  // `value: null` is the node saying there is nothing token-like here (a real "no").
  // A missing `value`, or no payload at all, is a non-answer and must NOT become
  // "is it a valid mint?" — that sentence is a verdict on someone's address.
  const supplyValue = expectRpcValue('getTokenSupply', raw.supply);
  if (supplyValue === null) {
    throw new ScanError('not-found', 'No SPL token supply found at that address — is it a valid mint?');
  }
  const supplyObj = expectRpcObject('getTokenSupply', supplyValue);
  if (typeof supplyObj.amount !== 'string') {
    throw unreadable('getTokenSupply', 'the supply carried no `amount`');
  }
  const decimals = typeof supplyObj.decimals === 'number' ? supplyObj.decimals : null;
  // Strict: a 0n total here does not read as "zero supply", it reads as "no total known",
  // and the core then quietly uses the top-20 sum as the denominator instead.
  const totalSupply = expectBaseUnits('getTokenSupply', supplyObj.amount);

  // ── hard facts ─────────────────────────────────────────────────────────────
  // A present mint/freeze authority string means it is LIVE (not renounced); a null
  // authority means renounced. `value: null` — no mint account — leaves both facts
  // UNKNOWN, and unknown never fires the gate.
  //
  // But a mint account that came back WITHOUT parsed authority fields is unreadable,
  // not renounced. These two facts are gate inputs: `mintAuthorityLive` floors the
  // whole verdict at `concentrated`, so guessing `false` here publishes a materially
  // safer-looking verdict than the evidence supports.
  const mintValue = expectRpcValue('getAccountInfo', raw.mintInfo);
  const hardFacts: HardFacts = {};
  if (mintValue !== null) {
    const info = jsonParsedInfo(expectRpcObject('getAccountInfo', mintValue));
    if (!info || !('mintAuthority' in info) || !('freezeAuthority' in info)) {
      throw unreadable('getAccountInfo', 'the mint account carried no parsed authority fields');
    }
    hardFacts.mintAuthorityLive = info.mintAuthority != null;
    hardFacts.freezeAuthorityLive = info.freezeAuthority != null;
  }

  // ── holders ────────────────────────────────────────────────────────────────
  // An empty `value` array is a real "this mint has no token accounts"; a missing
  // `value` is a failed read. Only the first may reach the core, which would read
  // either as "no concentrated holders".
  const entries = largestEntries(raw.largest);

  // The two follow-up batches are only issued when there is something to look up, so
  // their absence is expected — and ONLY expected — when there are no entries.
  const tokenAccts = entries.length
    ? expectSameLength(
        'getMultipleAccounts',
        expectRpcArray('getMultipleAccounts', raw.tokenAccounts),
        entries.length,
        'token accounts',
      )
    : [];
  const ownerAccts = entries.length
    ? expectSameLength(
        'getMultipleAccounts',
        expectRpcArray('getMultipleAccounts', raw.ownerAccounts),
        entries.length,
        'owner accounts',
      )
    : [];

  const holders: RawHolder[] = [];
  for (let i = 0; i < entries.length; i++) {
    // Length-checked above; the fallback only satisfies noUncheckedIndexedAccess.
    const entry = entries[i];
    if (!entry) continue;

    // Resolve token-account → owner wallet (so a whale's multiple ATAs collapse to one holder).
    const owner = tokenAccountOwner(i, tokenAccts[i]);

    // Classify the owner: an account owned by a program (or marked executable) is a
    // vault / PDA / contract, not a person — exclude it. A System-Program-owned
    // account is treated as a wallet and left to the core (which promotes a large
    // unlabeled wallet to `unclassified`, lowering confidence, never hostile).
    //
    // An explicit `null` element is a real answer — getMultipleAccounts returns null
    // for an address with no account — and means "not program-owned". A non-null
    // element that carries no `owner` is drift, and drift that defaults to "wallet"
    // would let a vault count as a person.
    const rawOwnerAcct = ownerAccts[i];
    let label: 'contract' | null = null;
    if (rawOwnerAcct != null) {
      const ownerAcct = expectRpcObject('getMultipleAccounts', rawOwnerAcct);
      if (typeof ownerAcct.owner !== 'string') {
        throw unreadable('getMultipleAccounts', `owner account ${i} carried no owner`);
      }
      const programOwned = ownerAcct.owner !== SYSTEM_PROGRAM;
      label = ownerAcct.executable === true || programOwned ? 'contract' : null;
    }

    holders.push({ address: entry.address, balance: entry.balance, ownerAddress: owner, label });
  }

  const enumeratedHolders = normalizeHolders(holders).length;

  const token: TokenMeta = {
    name: null, // getTokenLargestAccounts / getTokenSupply do not carry a token name
    symbol: null,
    decimals,
    holdersCount: null, // Solana top-20 read has no authoritative total-holder count
  };

  return {
    input: {
      holders,
      chain: 'solana',
      totalSupply,
      hardFacts,
      launch: { bundlesResolved: false, snipersResolved: false, tokenAgeSeconds: null },
    },
    token,
    enumeratedHolders,
    holderCoverage: 'top-n',
    source: 'Solana RPC (getTokenLargestAccounts, top 20)',
  };
}

/** Fetch + parse a Solana token scan through the same-origin RPC proxy. */
export async function fetchSolanaScan(mint: string, signal?: AbortSignal): Promise<AdapterResult> {
  // Batch 1: supply + mint authorities + the top-20 token accounts.
  const b1 = await solrpcBatch(
    [
      { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] },
      { jsonrpc: '2.0', id: 2, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] },
      { jsonrpc: '2.0', id: 3, method: 'getTokenLargestAccounts', params: [mint] },
    ],
    signal,
  );

  // The one error that is an answer: the node looked and there is no SPL mint there.
  // Checked before `takeResult`, which would otherwise report it as a failed read.
  const supplyEntry = b1.get(1);
  if (supplyEntry && !supplyEntry.ok && supplyEntry.code === INVALID_PARAM) {
    throw new ScanError('not-found', 'No SPL token supply found at that address — is it a valid mint?');
  }

  const supply = takeResult(b1, 1, 'getTokenSupply');
  const mintInfo = takeResult(b1, 2, 'getAccountInfo');
  const largest = takeResult(b1, 3, 'getTokenLargestAccounts');

  // Derived through the SAME validator `parseSolanaScan` uses, so the addresses sent
  // to getMultipleAccounts are positionally identical to the rows parsing will index.
  const tokenAccountAddrs = largestEntries(largest).map((e) => e.address);

  let tokenAccounts: unknown;
  let ownerAccounts: unknown;
  if (tokenAccountAddrs.length > 0) {
    // Batch 2: resolve each token account to its owner wallet.
    const b2 = await solrpcBatch(
      [{ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [tokenAccountAddrs, { encoding: 'jsonParsed' }] }],
      signal,
    );
    tokenAccounts = takeResult(b2, 1, 'getMultipleAccounts');

    // Batch 3: classify each owner wallet (System-Program-owned vs program-owned vault).
    const parsedAccts = expectSameLength(
      'getMultipleAccounts',
      expectRpcArray('getMultipleAccounts', tokenAccounts),
      tokenAccountAddrs.length,
      'token accounts',
    );
    const ownerAddrs = parsedAccts.map((a, i) => tokenAccountOwner(i, a));
    const b3 = await solrpcBatch(
      [{ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [ownerAddrs, { encoding: 'base64' }] }],
      signal,
    );
    ownerAccounts = takeResult(b3, 1, 'getMultipleAccounts');
  }

  return parseSolanaScan({ mint, supply, mintInfo, largest, tokenAccounts, ownerAccounts });
}
