// The ERC-20 holder-distribution read, and the keyed product envelope over it.
//
// The read itself was inline in api/v1/index.js's `erc20scan` case. It is here
// now because TWO surfaces need it and neither may be a copy of the other:
//   * `route=erc20scan` — the free consumer read the browser scanner calls;
//   * `route=scan`      — the keyed product, same read, product envelope.
// A second implementation of "did we actually read the holders" is the one thing
// this file exists to prevent: the honesty rules below were each written after a
// specific defect, and a fork would keep exactly one of the two surfaces fixed.
//
// THE RULE, ONCE, FOR BOTH CALLERS
//   Every read has three outcomes and only two are answers:
//     (a) read it, the answer is no   (b) read it, the answer is yes
//     (c) COULD NOT READ IT
//   (c) is not a finding. It never becomes a 200, and it is never cached.
//
// FOR THE PAID SURFACE THIS IS THE PRODUCT, NOT A NICETY
//   A security API that answers "no findings" when it could not scan is worse
//   than no API: the integrator's user sees a clean bill of health that nobody
//   ever issued. So the keyed envelope carries `scanned` as a top-level boolean,
//   and a refusal carries NO distribution field at all — there is nothing for a
//   client that ignores the status code to misread as a result.

import { readBoundedText, MAX_RESPONSE_BYTES } from './bodycap.js';
import { logSafe } from './logSafe.js';

const EP_BASE = 'https://api.ethplorer.io';
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Schema tag on every keyed scan body, so a consumer can pin what it parsed. */
export const SCAN_SCHEMA = 'tegridy.scan.erc20.v1';

/**
 * A base-unit integer as a digit string, or null when it cannot be read EXACTLY.
 * A JSON number past 2^53 had its low digits fabricated by the parse itself, so
 * there is nothing left there to read even though `BigInt(Math.trunc(v))`
 * returns a confident-looking integer.
 */
function baseUnits(v) {
  if (typeof v === 'string') return /^[0-9]+$/.test(v) ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return null;
}

/**
 * Read a token's holder distribution.
 *
 * @param {string} contract lowercased 0x address (validated by the caller)
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<
 *   | { ok: true, data: object }
 *   | { ok: false, kind: 'auth' | 'not-a-token' | 'upstream' }
 * >}
 */
export async function readErc20Distribution(contract, opts = {}) {
  // OPERATOR: Ethplorer getTopTokenHolders usually needs a PAID key (the public
  // "freekey" may 403); set ETHPLORER_API_KEY, or swap the upstream for
  // Moralis/Covalent/Etherscan-Pro/the Ponder index. Callers self-gate until this
  // returns data — nothing downstream fabricates a distribution.
  const EP_KEY = process.env.ETHPLORER_API_KEY || 'freekey';
  const holderLimit = Math.min(Math.max(1, parseInt(opts.limit, 10) || 100), 100);

  const [infoRes, topRes] = await Promise.all([
    fetch(`${EP_BASE}/getTokenInfo/${contract}?apiKey=${EP_KEY}`, { headers: { Accept: 'application/json' } }),
    fetch(`${EP_BASE}/getTopTokenHolders/${contract}?apiKey=${EP_KEY}&limit=${holderLimit}`, {
      headers: { Accept: 'application/json' },
    }),
  ]);
  const { text: infoText, truncated: it } = await readBoundedText(infoRes, MAX_RESPONSE_BYTES);
  const { text: topText, truncated: tt } = await readBoundedText(topRes, MAX_RESPONSE_BYTES);
  if (it || tt) throw new Error('upstream-too-large');
  let info = null;
  let top = null;
  try { info = JSON.parse(infoText); } catch { info = null; }
  try { top = JSON.parse(topText); } catch { top = null; }

  // getTokenInfo carries the denominator every published percentage divides by. An
  // unparsable body is a failed read of ALL of it, not five nulls. An ABSENT
  // totalSupply is the route's documented gap and stays null (consumers fall back
  // to the enumerated sum, disclosed as an upper bound); a PRESENT one we cannot
  // read is neither, and must not go out as a mangled string — a client's `toBig`
  // turned "1e+21" into 121n and published 100% concentration off it.
  //
  // BOTH legs are checked, not just the holder one. Ethplorer reports a rate-limit
  // or a bad key as an {error:{code}} envelope under HTTP 429/200, and
  // `typeof envelope === "object"` is TRUE — so a typeof-object test alone reads a
  // throttled getTokenInfo as "the explorer did not report a total". The two calls
  // race one key in parallel, so exactly one of them being rejected is routine
  // (reproduced live on `freekey`). The consequence is not a missing label: with no
  // total, consumers substitute the enumerated top-100 sum as the denominator, so
  // every published share is inflated by 1/coverage — measured at 1.216x on UNI's
  // live top-100 — and a large-enough holder crosses the 50% single-holder-majority
  // gate. `typeof [] === "object"`, so an array body slipped through as a readable
  // token-info payload with every field undefined — straight back into the same
  // answer this check exists to prevent.
  const infoOk = !!info && typeof info === 'object' && !Array.isArray(info);
  const infoError = infoOk ? info.error : null;
  const infoUnreadable = !infoOk || !!infoError || !infoRes.ok;
  const rawTotal = infoOk ? info.totalSupply : null;
  const totalSupply = rawTotal == null ? null : baseUnits(rawTotal);

  // Ethplorer hands us the exact integer in `rawBalance`. An earlier revision
  // ignored it and rebuilt every balance from `share` — a percentage rounded to
  // TWO decimals — so each published balance carried a fixed ±0.005pp error whose
  // RELATIVE size explodes on small holders: measured on TOWELI's own live scan,
  // one holder was published 6.01% light (44,733 TOWELI), and any holder under
  // 0.005% rounds to a zero balance and vanishes from the set entirely.
  //
  // A row whose balance cannot be read is a failed read, not a row to drop:
  // dropping a holder understates concentration, the flattering direction. A row
  // that is not an EVM address can be attributed to nobody and stays dropped —
  // the only row-level drop left.
  const rows = top && typeof top === 'object' && Array.isArray(top.holders) ? top.holders : null;
  let holders = rows ? [] : null;
  for (const h of rows || []) {
    const address = String((h && h.address) || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    const balance = baseUnits(h && h.rawBalance != null ? h.rawBalance : h && h.balance);
    if (balance === null) { holders = null; break; }
    holders.push({ address, balance, isContract: false });
  }
  // Rows arrived but NONE of them were attributable. An empty `holders: []` is only
  // an answer when the upstream itself said "nobody"; deriving one by discarding
  // every row it did send is the same laundering in slow motion. Non-empty in,
  // empty out, is drift.
  if (rows && rows.length > 0 && holders !== null && holders.length === 0) holders = null;

  // Which of these holders are CONTRACTS? Ethplorer does not say, and an earlier
  // `!!h.isContract` therefore evaluated to `false` for every row — so a consumer's
  // exclusion pass (LP pairs, CEX wallets, bridges, lockers, vaults) ran and matched
  // nothing, and every pool was counted as a person. Measured on TOWELI's own live
  // scan: 15 of the top 100 have code, including the LARGEST at 27.47% — the Uniswap
  // V2 pair — and the staking contract at 5.1%. That published "largest holder
  // 27.47%" where the largest PERSON holds 3.71%, and 6.0 effective holders against
  // a real 23.1.
  //
  // Fail-closed on purpose: an unreadable code batch is an unreadable read, and a
  // distribution whose exclusion pass silently did not run is the defect this whole
  // path has been fixing. The chain walks a configured Alchemy key then three
  // keyless public nodes, so every URL failing means something is genuinely wrong
  // rather than one node being slow.
  let codeReadFailed = false;
  if (holders !== null && holders.length > 0) {
    try {
      const { fetchContractFlags } = await import('./eth-code.js');
      const flags = await fetchContractFlags(holders.map((h) => h.address));
      for (const h of holders) h.isContract = flags.get(h.address) === true;
    } catch (err) {
      console.error('erc20scan eth_getCode failed:', logSafe(err));
      codeReadFailed = true;
    }
  }

  const epError = top && typeof top === 'object' ? top.error : null;
  const unreadable =
    infoUnreadable || (rawTotal != null && totalSupply === null) || holders === null || codeReadFailed;

  if (!topRes.ok || epError || unreadable) {
    // ⚠ NOT every upstream error is a failed read. Ethplorer answers a wallet or an
    // NFT address with `{"error":{"code":150,"message":"Address is not a token
    // contract"}}` — it LOOKED, and that address is not an ERC-20. Treating that as
    // transient takes a real answer about the address and renders it as "couldn't
    // complete the scan" with a retry that can never succeed.
    const notAToken = Number(epError?.code) === 150 || Number(infoError?.code) === 150;
    // Auth is checked on BOTH legs: an info-side bad key is still a deployment gap,
    // not a transient blip, and reporting it as transient sends the operator looking
    // for an outage that is not happening. Ethplorer code 1 = invalid API key.
    const isAuth =
      topRes.status === 401 ||
      topRes.status === 403 ||
      infoRes.status === 401 ||
      infoRes.status === 403 ||
      Number(epError?.code) === 1 ||
      Number(infoError?.code) === 1;
    if (isAuth) return { ok: false, kind: 'auth' };
    if (notAToken) return { ok: false, kind: 'not-a-token' };
    return { ok: false, kind: 'upstream' };
  }

  // `decimals` and `holdersCount` are the two fields an unreadable value may stay
  // null for: neither feeds a metric, and a null holdersCount makes a consumer
  // disclose `top-n` coverage — the conservative direction.
  const decimals = parseInt(info.decimals, 10);
  return {
    ok: true,
    data: {
      chain: 'ethereum',
      contract,
      name: info.name || null,
      symbol: info.symbol || null,
      decimals: Number.isFinite(decimals) ? decimals : null,
      totalSupply,
      holdersCount: typeof info.holdersCount === 'number' ? info.holdersCount : null,
      source: 'ethplorer',
      holders,
    },
  };
}

const BS_BASE = 'https://base.blockscout.com/api/v2';

/**
 * The BASE leg of the same read — Blockscout v2, keyless (the flagship Base
 * instance). Same three-outcome rule as the Ethplorer leg above; the shape
 * emitted is byte-compatible with it so the client adapter needs no fork.
 * Advantages over the eth leg: Blockscout reports `is_contract` per holder
 * natively (no eth_getCode walk), and the info endpoint carries holders_count.
 * Holders come 50/page largest-first; up to two pages are read (top ≤100),
 * which is `top-n` coverage exactly like the eth route.
 *
 * @param {string} contract lowercased 0x address (validated by the caller)
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<
 *   | { ok: true, data: object }
 *   | { ok: false, kind: 'auth' | 'not-a-token' | 'upstream' }
 * >}
 */
export async function readBaseErc20Distribution(contract, opts = {}) {
  const holderLimit = Math.min(Math.max(1, parseInt(opts.limit, 10) || 100), 100);
  const accept = { headers: { Accept: 'application/json' } };

  const [infoRes, topRes] = await Promise.all([
    fetch(`${BS_BASE}/tokens/${contract}`, accept),
    fetch(`${BS_BASE}/tokens/${contract}/holders`, accept),
  ]);
  const { text: infoText, truncated: it } = await readBoundedText(infoRes, MAX_RESPONSE_BYTES);
  const { text: topText, truncated: tt } = await readBoundedText(topRes, MAX_RESPONSE_BYTES);
  if (it || tt) return { ok: false, kind: 'upstream' };

  // Blockscout answers a non-token (wallet, NFT contract, unindexed address)
  // with 404 {"message":"Not found"} — it LOOKED. That is an answer about the
  // address, same semantics as Ethplorer's code 150.
  if (infoRes.status === 404 || topRes.status === 404) return { ok: false, kind: 'not-a-token' };

  let info = null;
  let top = null;
  try { info = JSON.parse(infoText); } catch { info = null; }
  try { top = JSON.parse(topText); } catch { top = null; }

  const infoOk = !!info && typeof info === 'object' && !Array.isArray(info);
  // Blockscout types tokens; a non-fungible answer here is "not an ERC-20",
  // the address-shaped answer, not a failed read.
  if (infoOk && infoRes.ok && typeof info.type === 'string' && info.type !== 'ERC-20') {
    return { ok: false, kind: 'not-a-token' };
  }
  const infoUnreadable = !infoOk || !infoRes.ok;
  const rawTotal = infoOk ? info.total_supply : null;
  const totalSupply = rawTotal == null ? null : baseUnits(rawTotal);

  // Same row discipline as the eth leg: an unreadable balance fails the WHOLE
  // read (dropping a holder understates concentration — the flattering
  // direction); a non-address row is attributable to nobody and is dropped.
  const readPage = (body) => (body && typeof body === 'object' && Array.isArray(body.items) ? body.items : null);
  let rows = topRes.ok ? readPage(top) : null;

  // Second page only when the caller wants more than one and the first page
  // says there is one. A FAILED page-2 read fails the read: silently serving
  // 50-of-100 as if it were the requested coverage is drift.
  if (rows && rows.length > 0 && holderLimit > rows.length && top.next_page_params && typeof top.next_page_params === 'object') {
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(top.next_page_params)) {
        if (v !== null && v !== undefined) qs.set(k, String(v));
      }
      const page2Res = await fetch(`${BS_BASE}/tokens/${contract}/holders?${qs}`, accept);
      const { text: p2Text, truncated: p2t } = await readBoundedText(page2Res, MAX_RESPONSE_BYTES);
      if (p2t || !page2Res.ok) { rows = null; }
      else {
        let p2 = null;
        try { p2 = JSON.parse(p2Text); } catch { p2 = null; }
        const more = readPage(p2);
        if (more === null) rows = null;
        else rows = rows.concat(more);
      }
    } catch {
      rows = null;
    }
  }

  let holders = rows ? [] : null;
  for (const h of (rows || []).slice(0, holderLimit)) {
    const address = String(h?.address?.hash || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    const balance = baseUnits(h?.value);
    if (balance === null) { holders = null; break; }
    holders.push({ address, balance, isContract: h?.address?.is_contract === true });
  }
  if (rows && rows.length > 0 && holders !== null && holders.length === 0) holders = null;

  const unreadable = infoUnreadable || (rawTotal != null && totalSupply === null) || holders === null;
  if (unreadable) return { ok: false, kind: 'upstream' };

  const decimals = parseInt(info.decimals, 10);
  const holdersCount = parseInt(info.holders_count, 10);
  return {
    ok: true,
    data: {
      chain: 'base',
      contract,
      name: info.name || null,
      symbol: info.symbol || null,
      decimals: Number.isFinite(decimals) ? decimals : null,
      totalSupply,
      holdersCount: Number.isFinite(holdersCount) ? holdersCount : null,
      source: 'blockscout',
      holders,
    },
  };
}

/** Chains this deployment can scan. `chain` is required so a caller never has to
 *  infer which one answered — a silent default is how a Solana address gets an
 *  Ethereum answer. */
const SUPPORTED_CHAINS = new Set(['ethereum']);

/**
 * `GET /api/v1?route=scan&chain=ethereum&address=0x…` — the keyed product.
 *
 * Returns the status it sent, so the caller can settle the meter: a 5xx is our
 * failure and must not be billed.
 *
 * @param {{ tier: import('./apiTiers.js').ApiTier }} ctx
 * @returns {Promise<number>} the HTTP status written
 */
export async function handleScanRoute(req, res, ctx) {
  const chain = String(req.query.chain || '').toLowerCase();
  const address = String(req.query.address || req.query.contract || '').toLowerCase();

  if (!chain) return send(res, 400, { error: 'Missing chain', code: 'missing_chain', scanned: false });
  if (!SUPPORTED_CHAINS.has(chain)) {
    return send(res, 400, {
      error: `Chain "${chain}" is not scannable on this deployment. Supported: ${[...SUPPORTED_CHAINS].join(', ')}.`,
      code: 'chain_not_supported',
      scanned: false,
    });
  }
  if (!ETH_ADDRESS_RE.test(address)) {
    return send(res, 400, { error: 'Invalid address', code: 'invalid_address', scanned: false });
  }

  let result;
  try {
    result = await readErc20Distribution(address);
  } catch (err) {
    console.error('scan route failed:', logSafe(err));
    result = { ok: false, kind: 'upstream' };
  }

  if (!result.ok) {
    // EVERY refusal below omits `distribution` entirely. A client that checks only
    // for the presence of a field — and integrators do — finds nothing to read as
    // a result. `scanned: false` says the same thing to one that checks the body.
    if (result.kind === 'auth') {
      return send(res, 503, {
        error: 'The holder-data source is not enabled on this deployment, so no scan was performed.',
        code: 'source_not_configured',
        scanned: false,
      });
    }
    if (result.kind === 'not-a-token') {
      // 422, and `scanned: true`: the upstream LOOKED. This is an answer about the
      // address, and the one refusal here that is not an outage.
      return send(res, 422, {
        error: 'That address is not an ERC-20 token contract.',
        code: 'not_a_token',
        scanned: true,
        chain,
        address,
      });
    }
    return send(res, 502, {
      error: 'The holder-data source is unavailable — NO SCAN WAS PERFORMED. This is not a clean result.',
      code: 'upstream_unavailable',
      scanned: false,
    });
  }

  const d = result.data;
  const enumerated = d.holders.length;
  // Coverage is stated, never implied. `complete` only when the upstream's own
  // holder count agrees with what it enumerated; anything else is a top-N sample,
  // and a share computed against a sample is a lower bound on concentration.
  const coverage =
    typeof d.holdersCount === 'number' && d.holdersCount <= enumerated ? 'complete' : 'top-n';

  res.setHeader('Cache-Control', 'no-store');
  return send(res, 200, {
    schema: SCAN_SCHEMA,
    scanned: true,
    chain,
    address,
    computedAt: new Date().toISOString(),
    tier: ctx?.tier?.id ?? null,
    provenance: {
      // Named so an integrator can attribute the number in their own UI, which is
      // the whole reason this is sellable and a scraped score is not.
      source: d.source,
      totalSupplyRead: d.totalSupply !== null,
      holdersReported: d.holdersCount,
      holdersEnumerated: enumerated,
      coverage,
    },
    token: {
      name: d.name,
      symbol: d.symbol,
      decimals: d.decimals,
      totalSupply: d.totalSupply,
    },
    // Base-unit strings, never numbers: a supply past 2^53 loses its low digits to
    // JSON parsing on the way out, and the loss is invisible at the far end.
    distribution: { holders: d.holders },
  });
}

function send(res, status, body) {
  if (status !== 200) res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
  return status;
}
