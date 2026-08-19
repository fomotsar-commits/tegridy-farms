// Arb-linkage facts: the chain reads and the GO/WARN/HALT rule, in one module.
//
// This is split out of arbLinkageMonitor.mjs for the same reason
// scripts/lib/caller-credit.mjs is split out of scripts/pull-caller-credit.mjs:
// the watcher that REPORTS the linkage and the operator tool that PREPARES the
// pause must share one definition of "broken". Two implementations would
// eventually disagree about whether the condition that gates the oracle is met,
// and the disagreement would surface during an incident.
//
// Read-only. Nothing here signs, and nothing here may grow a signer.

const HEX_WORD = 64;

/** Derived with `cast sig`, not recalled. */
export const SELECTORS = {
  getReserves: '0x0902f1ac',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
};

export const DEFAULT_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.merkle.io',
];

/**
 * Mainnet defaults. WETH is the shared numeraire, so both venues must actually
 * hold it — see readPair, which refuses to guess.
 */
export function resolveConfig(env = process.env) {
  return {
    chainId: Number(env.CHAIN_ID || 1),
    weth: (env.WETH || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase(),
    nativePair: env.NATIVE_PAIR || '0x55875887B43C2E23aE424AF0FC8606Fdb058a481',
    uniswapPair: env.UNISWAP_PAIR || '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D',
    haltRatio: Number(env.HALT_RATIO || 3),
    warnRatio: Number(env.WARN_RATIO || 4),
    liveFloorWeth: Number(env.LIVE_FLOOR_WETH || 1.0),
    // ~50 mainnet blocks. Wide enough that runner/node clock skew cannot trip it,
    // narrow enough that a wedged endpoint replaying an old head is caught before
    // its depth figures are reported as the current picture.
    maxBlockAgeSec: Number(env.MAX_BLOCK_AGE_SEC || 600),
    rpcs: (env.RPC ? [env.RPC] : []).concat(DEFAULT_RPCS),
    timeoutMs: Number(env.RPC_TIMEOUT_MS || 12_000),
  };
}

export class ReadFailure extends Error {}

/**
 * Endpoints are named in reports that get posted to a PUBLIC issue tracker, and
 * the operator-supplied RPC is the one entry that may carry an API key — most
 * paid endpoints put it in the path (`/v2/<key>`) or the query string, and some
 * in userinfo. Only the origin identifies which provider was used, and only the
 * origin is ever rendered.
 */
export function redactEndpoint(url) {
  if (!url) return url;
  try {
    return new URL(url).origin;
  } catch {
    return '[unparseable endpoint]';
  }
}

function word(hex, i) {
  const start = 2 + i * HEX_WORD;
  const slice = hex.slice(start, start + HEX_WORD);
  if (slice.length !== HEX_WORD) {
    throw new ReadFailure(`expected at least ${i + 1} return word(s), got ${(hex.length - 2) / HEX_WORD}`);
  }
  return BigInt(`0x${slice}`);
}

function addressWord(hex, i) {
  return `0x${word(hex, i).toString(16).padStart(40, '0')}`.toLowerCase();
}

/**
 * One JSON-RPC round trip against ONE endpoint. It never falls through to a
 * sibling endpoint: an internally consistent picture is the whole point of
 * readLinkageFrom, and silently sourcing half the reads elsewhere would produce
 * a ratio between two numbers that were never simultaneously true.
 */
export function makeRpc(url, { timeoutMs = 12_000, fetchImpl = fetch } = {}) {
  let id = 0;
  return async function rpc(method, params) {
    // Manual controller + cleared timer (not AbortSignal.timeout): the timeout
    // handle must be cleared before exit, else libuv asserts on close (Windows).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new ReadFailure(`${method}: HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.error) throw new ReadFailure(`${method}: ${json.error.message || JSON.stringify(json.error)}`);
      // A missing `result` with no `error` is not an empty answer, it is a
      // non-answer. Returning undefined here would surface downstream as a
      // decoding crash whose message names the wrong culprit.
      if (!json || json.result === undefined || json.result === null) {
        throw new ReadFailure(`${method}: response carried neither result nor error`);
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * WETH-side reserve of a Uniswap-V2-shaped pair, pinned to `blockTag`.
 *
 * Both token slots are read. The pre-existing shape — compare token0, else
 * assume token1 — reports the OTHER token's reserve as "WETH depth" whenever the
 * configured address is a pool that holds no WETH at all, and a misconfigured
 * arb-venue address is exactly the situation in which the ratio looks healthiest.
 */
export async function readPair(rpc, pair, weth, blockTag) {
  const call = async (selector, label) => {
    let hex;
    try {
      hex = await rpc('eth_call', [{ to: pair, data: selector }, blockTag]);
    } catch (e) {
      throw new ReadFailure(`${pair} ${label}: ${e.message}`);
    }
    if (typeof hex !== 'string' || hex === '0x') {
      throw new ReadFailure(`${pair} ${label}: empty return — not a pair contract at this address?`);
    }
    return hex;
  };

  const [reservesHex, token0Hex, token1Hex] = await Promise.all([
    call(SELECTORS.getReserves, 'getReserves()'),
    call(SELECTORS.token0, 'token0()'),
    call(SELECTORS.token1, 'token1()'),
  ]);

  const r0 = word(reservesHex, 0);
  const r1 = word(reservesHex, 1);
  const token0 = addressWord(token0Hex, 0);
  const token1 = addressWord(token1Hex, 0);

  let wethWei;
  let otherWei;
  if (token0 === weth) {
    wethWei = r0;
    otherWei = r1;
  } else if (token1 === weth) {
    wethWei = r1;
    otherWei = r0;
  } else {
    throw new ReadFailure(
      `${pair} holds no WETH (token0=${token0}, token1=${token1}) — a depth figure from this pair would not be WETH depth`,
    );
  }

  return {
    pair,
    wethWei,
    otherWei,
    wethEth: Number(wethWei) / 1e18,
    // A pool with one side at zero quotes nothing and arbs nothing, however
    // deep the other side reads.
    degenerate: r0 === 0n || r1 === 0n,
  };
}

/** Every read for one observation, from one endpoint, pinned to one block. */
export async function readLinkageFrom(url, config, { fetchImpl = fetch, now = Date.now } = {}) {
  const rpc = makeRpc(url, { timeoutMs: config.timeoutMs, fetchImpl });

  const chainIdHex = await rpc('eth_chainId', []);
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== config.chainId) {
    throw new ReadFailure(`endpoint serves chain ${chainId}, expected ${config.chainId}`);
  }

  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block || !block.number || !block.timestamp) {
    throw new ReadFailure('latest block carried no number/timestamp');
  }
  const blockNumber = Number(BigInt(block.number));
  const blockTimestamp = Number(BigInt(block.timestamp));
  const blockAgeSeconds = Math.round(now() / 1000) - blockTimestamp;
  if (blockAgeSeconds > config.maxBlockAgeSec) {
    throw new ReadFailure(
      `chain view is ${blockAgeSeconds}s behind (limit ${config.maxBlockAgeSec}s) — depth here is not proven current`,
    );
  }

  const [native, uniswap] = await Promise.all([
    readPair(rpc, config.nativePair, config.weth, block.number),
    readPair(rpc, config.uniswapPair, config.weth, block.number),
  ]);

  return { endpoint: url, chainId, blockNumber, blockTimestamp, blockAgeSeconds, native, uniswap };
}

/**
 * Uniswap WETH depth as a multiple of native WETH depth, via BigInt so a pool
 * deep enough to exceed float integer precision still divides exactly.
 */
export function depthRatio(nativeWei, uniswapWei) {
  if (nativeWei <= 0n) return null;
  return Number((uniswapWei * 10_000n) / nativeWei) / 10_000;
}

/**
 * The rule. Pure, so the thresholds that gate the oracle can be asserted without
 * a network.
 *
 * Ordering is load-bearing: the conditions that make the ratio MEANINGLESS
 * (an empty venue, a one-sided pool) are answered before the ratio is trusted,
 * because a pool holding 7 WETH and zero TOWELI produces the healthiest-looking
 * multiple this monitor can print while arbing nothing at all.
 */
export function decide(observation, config) {
  const { native, uniswap } = observation;
  const ratio = depthRatio(native.wethWei, uniswap.wethWei);

  if (native.wethWei <= 0n) {
    return { status: 'HALT', code: 2, ratio, reason: 'native pool holds no WETH — oracle must not be live' };
  }
  if (native.degenerate) {
    return { status: 'HALT', code: 2, ratio, reason: 'native pool has a zero-side reserve — it cannot price' };
  }
  if (uniswap.wethWei <= 0n) {
    return { status: 'HALT', code: 2, ratio, reason: 'arb venue holds no WETH — the native pool is the only venue' };
  }
  if (uniswap.degenerate) {
    return { status: 'HALT', code: 2, ratio, reason: 'arb venue has a zero-side reserve — it cannot arb the native pool' };
  }
  if (ratio < config.haltRatio) {
    return {
      status: 'HALT',
      code: 2,
      ratio,
      reason: `arb venue depth ${ratio.toFixed(2)}x < ${config.haltRatio}x native — pause oracle features`,
    };
  }
  if (native.wethEth < config.liveFloorWeth) {
    return {
      status: 'WARN',
      code: 1,
      ratio,
      reason: `native WETH ${native.wethEth.toFixed(4)} below live floor ${config.liveFloorWeth} — deepen before enabling`,
    };
  }
  if (ratio < config.warnRatio) {
    return {
      status: 'WARN',
      code: 1,
      ratio,
      reason: `arb venue depth ${ratio.toFixed(2)}x < ${config.warnRatio}x native — react before HALT`,
    };
  }
  return { status: 'GO', code: 0, ratio, reason: `arb linkage healthy (${ratio.toFixed(2)}x)` };
}

/**
 * Walk the endpoint roster until one serves a whole consistent observation.
 *
 * Every endpoint failing is reported as ERROR at exit 2 and never as any other
 * status: a monitor that could not look has not established that the linkage
 * holds, and the one outcome it must be incapable of producing is a GO nobody
 * read.
 */
export async function readLinkage(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const unreadable = [];
  for (const url of config.rpcs) {
    try {
      const observation = await readLinkageFrom(url, config, { fetchImpl, now });
      const verdict = decide(observation, config);
      return {
        status: verdict.status,
        code: verdict.code,
        reason: verdict.reason,
        ratio: verdict.ratio === null ? null : Number(verdict.ratio.toFixed(3)),
        nativeWethEth: Number(observation.native.wethEth.toFixed(6)),
        uniswapWethEth: Number(observation.uniswap.wethEth.toFixed(6)),
        nativePair: config.nativePair,
        uniswapPair: config.uniswapPair,
        haltRatio: config.haltRatio,
        warnRatio: config.warnRatio,
        liveFloorWeth: config.liveFloorWeth,
        chainId: observation.chainId,
        blockNumber: observation.blockNumber,
        blockAgeSeconds: observation.blockAgeSeconds,
        endpoint: redactEndpoint(observation.endpoint),
        // Unredacted, for the process that must issue further calls against the
        // same view. Never rendered; renderHuman and every consumer print
        // `endpoint`.
        endpointUrl: observation.endpoint,
        // Endpoints that failed before one succeeded. The reading stands, but a
        // roster quietly shrinking to its last member is how the next outage
        // becomes total without warning.
        unreadable,
        at: new Date(now()).toISOString(),
      };
    } catch (e) {
      unreadable.push(`${redactEndpoint(url)}: ${e.message || e}`);
    }
  }
  return {
    status: 'ERROR',
    code: 2,
    reason: 'no endpoint served a complete, current, same-block reading — the linkage is UNKNOWN, not healthy',
    ratio: null,
    nativeWethEth: null,
    uniswapWethEth: null,
    nativePair: config.nativePair,
    uniswapPair: config.uniswapPair,
    haltRatio: config.haltRatio,
    warnRatio: config.warnRatio,
    liveFloorWeth: config.liveFloorWeth,
    chainId: null,
    blockNumber: null,
    blockAgeSeconds: null,
    endpoint: null,
    endpointUrl: null,
    unreadable,
    at: new Date(now()).toISOString(),
  };
}

/**
 * The reading minus the one field that may carry a credential. Anything printed,
 * logged, pasted into a ticket or posted to an issue goes through this; only a
 * process that must issue further calls against the same view touches
 * `endpointUrl`.
 */
export function publicResult(result) {
  const { endpointUrl: _dropped, ...rest } = result;
  return rest;
}

const TAGS = { GO: 'GO', WARN: 'WARN', HALT: 'HALT', ERROR: 'ERROR (treat as HALT)' };

export function renderHuman(r) {
  const lines = [`${TAGS[r.status]}  — ${r.reason}`];
  if (r.status !== 'ERROR') {
    lines.push(`  native pool WETH  : ${r.nativeWethEth}   (${r.nativePair})`);
    lines.push(`  uniswap pool WETH : ${r.uniswapWethEth}   (${r.uniswapPair})`);
    lines.push(`  ratio (uni/native): ${r.ratio ?? 'n/a'}  (halt<${r.haltRatio}x, warn<${r.warnRatio}x)`);
    lines.push(`  read at block ${r.blockNumber} (${r.blockAgeSeconds}s old) via ${r.endpoint}`);
  }
  if (r.unreadable.length) {
    lines.push('  endpoints that could not serve this reading:');
    for (const u of r.unreadable) lines.push(`    - ${u}`);
  }
  return lines.join('\n');
}
