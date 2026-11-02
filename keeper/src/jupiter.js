// Outside prices, from Jupiter.
//
// HOSTS. With JUPITER_API_KEY set every call goes to api.jup.ag with the key in
// `x-api-key`; a 401/403/404/429 there is tried ONCE on the keyless lite-api host,
// the same rule as the site's proxy (PR #839). A 5xx or a timeout is never retried
// elsewhere: it is reported as unread. Without a key, lite-api only.
//
// WHAT IS REFUSED. A price is only a price when its route is the route asked for:
//   - BAYLA is forced through pump.fun's one pool (`dexes`), and a route through
//     any other pool or venue is refused;
//   - the SOL/USDC hop names every Raydium venue in `excludeDexes`, and a route that
//     still crosses one is refused (owner, 2026-10-13: no money to Raydium, ever);
//   - a route through our own pool program, if Jupiter ever lists it, is refused,
//     because our pool would then be pricing itself.
// The key is never put into an error or a log line, and neither is any text
// Jupiter sends (a venue name could carry anything); answers are read with a byte cap.

import { isAddress } from './base58.js';
import { readCapped } from './http.js';
import { PROGRAM_ID, PUMP_AMM_PROGRAM, PUMP_BAYLA_POOL } from './config.js';

const LITE = 'https://lite-api.jup.ag';
const KEYED = 'https://api.jup.ag';
const FALLBACK_ON = [401, 403, 404, 429];
/** Jupiter's own tip is refused below this (HTTP 400 "Tip amount must be at least 1000000", 2026-10-25). */
export const JUPITER_TIP_FLOOR_LAMPORTS = 1_000_000n;
/** A quote, a venue list or a build is a few dozen KB; anything past this is refused unread. */
const MAX_BODY_BYTES = 1024 * 1024;

export class JupiterError extends Error {}

/** Calls spaced so the free plans' limits hold: keyless 0.5/s, a free key 1/s. */
function spacer(minGapMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + minGapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

/** Longest wait for a keyless rate-limit window before the one retry. */
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * How long Jupiter asks a rate-limited caller to wait: `x-ratelimit-reset` as seconds to
 * wait or as a unix time in seconds, held between 1 s and MAX_RETRY_WAIT_MS; 3 s if absent.
 */
export function retryWaitMs(res, now = Date.now()) {
  const raw = Number(res.headers?.get?.('x-ratelimit-reset'));
  if (!Number.isFinite(raw) || raw <= 0) return 3_000;
  const ms = raw > 1e9 ? raw * 1000 - now : raw * 1000;
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(1_000, ms));
}

export function makeJupiter({ apiKey = null, fetchImpl = fetch, timeoutMs = 8_000, minGapMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const wait = spacer(minGapMs ?? (apiKey ? 1_100 : 2_500));

  async function get(path, { keyedOnly = false } = {}) {
    const attempts = apiKey
      ? [{ base: KEYED, headers: { 'x-api-key': apiKey } }, ...(keyedOnly ? [] : [{ base: LITE, headers: {}, fallback: true }])]
      : [{ base: LITE, headers: {} }];
    let lastStatus = null;
    const ask = async (a) => {
      try {
        return await fetchImpl(`${a.base}${path}`, { headers: { Accept: 'application/json', ...a.headers }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new JupiterError(`Jupiter ${e?.name === 'TimeoutError' ? 'timed out' : 'did not answer'}`);
      }
    };
    for (const a of attempts) {
      if (a.fallback && !FALLBACK_ON.includes(lastStatus)) break;
      await wait();
      let res = await ask(a);
      // Keyless, a 429 is usually other callers on the same IP: wait out the window Jupiter
      // names and ask once more, rather than leave the whole look unread.
      if (res.status === 429 && a.base === LITE) {
        await sleep(retryWaitMs(res));
        await wait();
        res = await ask(a);
      }
      if (res.ok) {
        let text;
        try {
          text = await readCapped(res, MAX_BODY_BYTES);
        } catch {
          throw new JupiterError('Jupiter’s answer was too large or cut off');
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new JupiterError('Jupiter answered with something that is not JSON');
        }
      }
      lastStatus = res.status;
    }
    throw new JupiterError(`Jupiter refused the request (HTTP ${lastStatus})`);
  }

  /** Jupiter's venue names, keyed by program id. */
  async function labels() {
    const m = await get('/swap/v1/program-id-to-label');
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new JupiterError('Jupiter sent no venue list');
    for (const [k, v] of Object.entries(m)) {
      if (!isAddress(k) || typeof v !== 'string') throw new JupiterError('Jupiter’s venue list has an entry that is not an address and a name');
    }
    return m;
  }

  /**
   * One ExactIn quote. `route.dexes` forces venues, `route.excludeDexes` bans them
   * (never both). Returns the amount out and the pools the price came through.
   */
  async function quote({ inputMint, outputMint, amount, dexes = null, excludeDexes = null }) {
    if (dexes && excludeDexes) throw new JupiterError('a quote cannot both force and ban venues');
    const qs = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: '50',
      swapMode: 'ExactIn',
      restrictIntermediateTokens: 'true',
    });
    if (dexes) {
      qs.set('dexes', dexes.join(','));
      qs.set('onlyDirectRoutes', 'true');
    }
    if (excludeDexes) qs.set('excludeDexes', excludeDexes.join(','));
    const q = await get(`/swap/v1/quote?${qs}`);
    return readQuote(q, { inputMint, outputMint, amount });
  }

  /**
   * The outside leg as raw instructions (/swap/v2/build), for the size check only. Asked
   * with a key: keyless calls are too scarce to spend on it (lite-api also serves /build).
   * No tip is asked for by default: the keeper tips Jito itself (config.js TIP_LAMPORTS),
   * and Jupiter refuses a tip under its 0.001 SOL floor. Nothing here signs.
   */
  async function build({ inputMint, outputMint, amount, taker, dexes = null, excludeDexes = null, maxAccounts, tipLamports = 0n }) {
    if (!apiKey) throw new JupiterError('the size check needs JUPITER_API_KEY');
    if (!isAddress(taker)) throw new JupiterError('KEEPER_TAKER is not an address');
    if (tipLamports > 0n && tipLamports < JUPITER_TIP_FLOOR_LAMPORTS) throw new JupiterError('Jupiter refuses a tip under 0.001 SOL; the keeper tips Jito itself');
    const qs = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      taker,
      slippageBps: '50',
      maxAccounts: String(maxAccounts),
    });
    if (tipLamports > 0n) qs.set('tipAmount', tipLamports.toString());
    if (dexes) qs.set('dexes', dexes.join(','));
    if (excludeDexes) qs.set('excludeDexes', excludeDexes.join(','));
    const b = await get(`/swap/v2/build?${qs}`, { keyedOnly: true });
    const q = readQuote(b, { inputMint, outputMint, amount });
    const ixs = [
      ...(b.computeBudgetInstructions ?? []),
      ...(b.setupInstructions ?? []),
      b.swapInstruction,
      ...(b.cleanupInstruction ? [b.cleanupInstruction] : []),
      ...(b.otherInstructions ?? []),
      ...(b.tipInstruction ? [b.tipInstruction] : []),
    ].map(readInstruction);
    const tables = b.addressesByLookupTableAddress ?? {};
    if (typeof tables !== 'object' || Array.isArray(tables)) throw new JupiterError('Jupiter’s lookup tables are not a map');
    for (const [k, v] of Object.entries(tables)) {
      if (!isAddress(k) || !Array.isArray(v) || !v.every(isAddress)) throw new JupiterError('Jupiter named a lookup table that is not a list of addresses');
    }
    return { ...q, instructions: ixs, lookupTables: tables };
  }

  return { labels, quote, build };
}

function readQuote(q, { inputMint, outputMint, amount }) {
  if (!q || typeof q !== 'object') throw new JupiterError('Jupiter sent no quote');
  if (q.inputMint !== inputMint || q.outputMint !== outputMint || q.inAmount !== amount.toString()) {
    throw new JupiterError('Jupiter answered for a different trade');
  }
  if (typeof q.outAmount !== 'string' || !/^\d{1,30}$/.test(q.outAmount)) throw new JupiterError('Jupiter answered without an amount');
  const out = BigInt(q.outAmount);
  if (out <= 0n) throw new JupiterError('Jupiter quoted nothing back');
  if (!Array.isArray(q.routePlan) || q.routePlan.length === 0) throw new JupiterError('Jupiter did not say which pools its price came from');
  const steps = q.routePlan.map((s) => {
    const info = s?.swapInfo;
    if (!isAddress(info?.ammKey) || typeof info?.label !== 'string') throw new JupiterError('Jupiter named a pool that is not an address');
    return { ammKey: info.ammKey, label: info.label };
  });
  return { out, steps };
}

function readInstruction(ix) {
  if (!ix || !isAddress(ix.programId) || !Array.isArray(ix.accounts) || typeof ix.data !== 'string') {
    throw new JupiterError('Jupiter sent an instruction we cannot read');
  }
  const accounts = ix.accounts.map((a) => {
    if (!isAddress(a?.pubkey) || typeof a.isSigner !== 'boolean' || typeof a.isWritable !== 'boolean') {
      throw new JupiterError('Jupiter sent an instruction account we cannot read');
    }
    return { pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable };
  });
  return { programId: ix.programId, accounts, dataLength: Buffer.from(ix.data, 'base64').length };
}

/**
 * The venue names the keeper routes by, read from Jupiter's own list rather than
 * typed in: the name it gives pump.fun's AMM program, every Raydium venue, and our
 * own program's name if it ever appears.
 */
export function venueNames(labels) {
  const pump = labels[PUMP_AMM_PROGRAM];
  if (typeof pump !== 'string') throw new JupiterError('Jupiter’s venue list does not name pump.fun’s AMM');
  const raydium = [...new Set(Object.values(labels).filter((l) => /raydium/i.test(l)))];
  if (raydium.length === 0) throw new JupiterError('Jupiter’s venue list names no Raydium venue, so none could be banned');
  return { pump, raydium, own: labels[PROGRAM_ID] ?? null };
}

/** A BAYLA price must come through pump.fun's one pool and nothing else. */
export function checkForcedRoute(steps, names) {
  for (const s of steps) {
    if (s.label !== names.pump || s.ammKey !== PUMP_BAYLA_POOL) {
      // The label is Jupiter's text: never repeated, only the checked pool address.
      throw new JupiterError(`the BAYLA price came through a pool other than pump.fun’s (${s.ammKey})`);
    }
  }
}

/** The SOL/USDC hop may cross any venue except Raydium and our own pools. */
export function checkHop(steps, names, ownPools) {
  for (const s of steps) {
    if (/raydium/i.test(s.label) || names.raydium.includes(s.label)) throw new JupiterError('the SOL/USDC price came through Raydium');
    if ((names.own && s.label === names.own) || ownPools.includes(s.ammKey)) throw new JupiterError('the SOL/USDC price came through our own pool');
  }
}
