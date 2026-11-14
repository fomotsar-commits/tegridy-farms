// The chain readers behind the all-time volume counter (scripts/venue-volume.mjs).
// Each reader starts from its cursor, reads only what is new, and returns the new swaps
// with their SOL, USDC, USDT or WETH leg. It values nothing: the caller prices each swap
// once, when first seen. A reader that cannot finish throws, so its cursor never moves past
// a swap it did not read. Keyless endpoints only; every address is pinned to
// scripts/addresses.json by venue-volume.test.mjs.

export const VENUE_PROGRAM = "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// The Squads vault's WSOL, USDC and USDT accounts: the site's Jupiter fee lands in one of
// these (src/lib/jupiter.ts picks the fee mint). An account added here is read from its
// first signature, since the cursor has no entry for it.
export const JUPITER_FEE_ACCOUNTS = [
  "2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa",
  "3gGzyz6cushQWNTAYRj4qJoQJyGcqdctXh98vNwBRvZ6",
  "GT8LWC8xwwXGE9FatRyMDZccSYBqYNRMZkz2SCdgV6dj",
];
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
// The island's coins, the pairing coins after SOL and USDC (api/_lib/pool-index.js's
// QUOTE_COINS; a test pins the two together), all with 6 decimals. A swap with no SOL, USDC
// or USDT leg is valued on one of these, at its market price when it is counted.
export const ISLAND_COINS = Object.freeze([
  Object.freeze({ symbol: "BAYLA", mint: "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump" }),
  Object.freeze({ symbol: "BOBO", mint: "4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump" }),
  Object.freeze({ symbol: "SOY", mint: "8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump" }),
  Object.freeze({ symbol: "BRAINLET", mint: "4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump" }),
  Object.freeze({ symbol: "RIZZ", mint: "5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k" }),
]);
export const ISLAND_DECIMALS = 6;
export const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
// Counted apart (bot_swaps, bot_usd) so a "without bots" figure needs no rescan: an outside
// arbitrage wallet, and the venue's own price keeper (scripts/price-keeper.mjs).
export const SOLANA_BOTS = new Set([
  "CzacL7gUCr4HYz6a2TGJjnmAR3Uxc65WEkKy6rU8w5bf",
  "9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz",
]);
const POOL_SIZE = 637;

export const EVM_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
// Our factories on each chain: the first one, then the one that charges to open a pool
// (live 2026-11-09), where every new pool opens. The SwapFeeRouter is not read: it swaps
// through these pairs, so its swaps are already their Swap logs (the 2026-10-19 hand read
// counted one twice). startBlock is where a first run reads from when a factory already
// has pairs; the opening factories were made after it on every chain. The RPCs serve only
// recent logs (publicnode about a day on Base, two on Ethereum; drpc any age, 100 blocks a
// call), so older ranges come from Blockscout, or from drpc a little at a time.
export const EVM_CHAINS = {
  ethereum: {
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    blockscout: "https://eth.blockscout.com",
    factories: ["0xa24C7287eC56A7DEFDc70033803451240e267a52", "0xf73C993A1303Fe3612c5F878783CEf63D080834E"],
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    startBlock: 25263332,
    bots: new Set(["0x6338afee3ff32599bff2ce3d8b7604bd6d6a41a7"]),
  },
  base: {
    rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.gateway.tenderly.co", "https://mainnet.base.org"],
    blockscout: "https://base.blockscout.com",
    factories: ["0x12a249A027AA7DdF184E824b4bb63ba031A39fEC", "0x09E1B43f90cb6488063BB91310FD40c4339027e6"],
    weth: "0x4200000000000000000000000000000000000006",
    // Its first pair, BRB/WETH, was created here (tx 0x3795131f…039d, 2026-10-21); none before.
    startBlock: 52884793,
    bots: new Set(),
  },
  robinhood: {
    rpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    blockscout: "https://robinhoodchain.blockscout.com",
    factories: ["0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3", "0xB62BaD165997E95C503044787b2Dcc85DC6D83F1"],
    // The routers' WETH (src/lib/chains/registry.ts). Unset until 2026-11-13, so the
    // WETH/DODO pair's swaps were counted with no dollar value and its pool added $0 to TVL.
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    // Its first pair, WETH/DODO, was created here; none before.
    startBlock: 109405136,
    // Its RPC answers up to 10,000,000 blocks a call, and makes a block every quarter second.
    logSpan: 1_000_000,
    bots: new Set(),
  },
};

// NFT Lending: our Gondi v3.2 loan contract on Ethereum (scripts/addresses.json gondi-loan,
// deployed in block 26365735). Its new loans are volume: the WETH a lender paid out.
// A refinance is not counted again: its event carries the whole loan, not the part re-lent.
export const NFT_LENDING = Object.freeze({
  rpcs: EVM_CHAINS.ethereum.rpcs,
  blockscout: EVM_CHAINS.ethereum.blockscout,
  loan: "0x4f2b53DAE3edCf1B527c53d2C11A28ec5Ac6D630",
  weth: EVM_CHAINS.ethereum.weth,
  startBlock: 26365735,
});
// keccak256 of LoanEmitted(uint256,uint256[],(address,uint256,address,address,uint256,uint256,
// uint256,(uint256,uint256,uint256,address,uint256,uint256,uint256)[],uint256,bool),uint256);
// a test checks it against the ABI in src/lib/gondi/abi.js. Nothing in it is indexed.
export const LOAN_EMITTED_TOPIC = "0x539d6c095c91e90f7790c6e3b4d5cf0d47330259a392b73829d928b9a7a324a9";
const LOG_SPAN = 5000;
const MIN_LOG_SPAN = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
export function unbase58(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

/** One pool account (cp-swap layout, 637 bytes): its vaults, mints and decimals. */
export function decodePool(address, base64) {
  const d = Buffer.from(base64, "base64");
  if (d.length !== POOL_SIZE) throw new Error(`pool ${address} is ${d.length} bytes, not ${POOL_SIZE}`);
  const pk = (o) => base58(d.subarray(o, o + 32));
  return { address, vault0: pk(72), vault1: pk(104), mint0: pk(168), mint1: pk(200), decimals0: d[331], decimals1: d[332] };
}

const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
function tokenDelta(tx, index) {
  const pick = (list) => {
    const b = (list ?? []).find((x) => x.accountIndex === index);
    return b ? BigInt(b.uiTokenAmount.amount) : 0n;
  };
  return pick(tx.meta.postTokenBalances) - pick(tx.meta.preTokenBalances);
}
// Value on a dollar leg (USDC, then USDT) when the swap has one, else on SOL, else on an
// island coin (the first in rank order).
const LEG_MINTS = [USDC_MINT, USDT_MINT, SOL_MINT, ...ISLAND_COINS.map((c) => c.mint)];
function pickLeg(amounts) {
  const mint = LEG_MINTS.find((m) => amounts[m] > 0n);
  return mint ? { mint, raw: amounts[mint] } : null;
}

/**
 * A swap in one of our pools: one vault rose and the other fell. Deposits (both rise),
 * withdrawals (both fall) and fee collection are not swaps. Returns null for those, or
 * { leg, payer } where leg is the USDC, USDT or SOL side (null when the pool has none).
 */
export function poolSwap(tx, pool) {
  if (tx.meta.err) return null;
  const keys = keysOf(tx);
  const i0 = keys.indexOf(pool.vault0);
  const i1 = keys.indexOf(pool.vault1);
  if (i0 < 0 || i1 < 0) return null;
  const d0 = tokenDelta(tx, i0);
  const d1 = tokenDelta(tx, i1);
  if (!((d0 > 0n && d1 < 0n) || (d0 < 0n && d1 > 0n))) return null;
  const abs = (x) => (x < 0n ? -x : x);
  const amounts = { [pool.mint0]: abs(d0), [pool.mint1]: abs(d1) };
  return { leg: pickLeg(amounts), payer: keys[0] };
}

const EVENT_TAG = "e445a52e51cb9a1d"; // Anchor's self-CPI event instruction
const SWAP_EVENT = "40c6cde8260871e2";
const FEE_EVENT = "494f4e7fb8d50ddc";
// Jupiter's V2 instructions emit one SwapsEvent instead: a u32 hop count, then per hop the
// in mint, in amount, out mint, out amount and AMM (112 bytes), and no FeeEvent.
const SWAPS_EVENT = "982f4eebc0606e6a";
const SWAPS_HOP = 112;

/**
 * A Jupiter swap that paid our fee into `feeAccount`, read from Jupiter's own events:
 * FeeEvent (V1) or the fee account's own balance change (V2) says what our fee was; the
 * SwapEvents or the SwapsEvent give each hop. The leg is the swap's net USDC, USDT or SOL
 * across hops, with a fee taken from the input added back: what the trader put in or got
 * out before our fee. Null when no fee reached `feeAccount`; throws when one did with no hops.
 */
export function jupiterSwap(tx, feeAccount) {
  if (tx.meta.err) return null;
  const keys = keysOf(tx);
  // A route through our own pools is counted once, by the pool reader.
  if (keys.includes(VENUE_PROGRAM)) return null;
  let fee = null;
  const net = {};
  let hops = 0;
  let v2 = false;
  const hop = (inMint, inAmount, outMint, outAmount) => {
    net[inMint] = (net[inMint] ?? 0n) - inAmount;
    net[outMint] = (net[outMint] ?? 0n) + outAmount;
    hops++;
  };
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (ix.programId !== JUPITER_PROGRAM || typeof ix.data !== "string") continue;
      const d = unbase58(ix.data);
      if (d.length < 16 || d.subarray(0, 8).toString("hex") !== EVENT_TAG) continue;
      const kind = d.subarray(8, 16).toString("hex");
      if (kind === FEE_EVENT && d.length >= 88) {
        if (base58(d.subarray(16, 48)) === feeAccount) {
          fee = { mint: base58(d.subarray(48, 80)), amount: d.readBigUInt64LE(80) };
        }
      } else if (kind === SWAP_EVENT && d.length >= 128) {
        hop(base58(d.subarray(48, 80)), d.readBigUInt64LE(80), base58(d.subarray(88, 120)), d.readBigUInt64LE(120));
      } else if (kind === SWAPS_EVENT && d.length >= 20) {
        const count = d.readUInt32LE(16);
        if (d.length < 20 + count * SWAPS_HOP) {
          throw new Error(`a SwapsEvent shorter than its ${count} hops: ${tx.transaction.signatures?.[0] ?? "?"}`);
        }
        for (let h = 0; h < count; h++) {
          const o = 20 + h * SWAPS_HOP;
          hop(base58(d.subarray(o, o + 32)), d.readBigUInt64LE(o + 32), base58(d.subarray(o + 40, o + 72)), d.readBigUInt64LE(o + 72));
        }
        v2 = true;
      }
    }
  }
  if (!fee && v2) {
    const i = keys.indexOf(feeAccount);
    const paid = i < 0 ? 0n : tokenDelta(tx, i);
    const mint = (tx.meta.postTokenBalances ?? []).find((b) => b.accountIndex === i)?.mint;
    if (paid > 0n && mint) fee = { mint, amount: paid };
  }
  if (!fee) return null;
  if (hops === 0) throw new Error(`a Jupiter fee with no SwapEvent (new event shape?): ${tx.transaction.signatures?.[0] ?? "?"}`);
  const amounts = {};
  for (const m of LEG_MINTS) {
    const n = net[m] ?? 0n;
    amounts[m] = n < 0n ? -n + (fee.mint === m ? fee.amount : 0n) : n;
  }
  return { leg: pickLeg(amounts), payer: keys[0] };
}

/** A UniswapV2 Swap log's WETH leg (amountIn + amountOut on the WETH side), or null. */
export function evmSwapLeg(log, wethSide) {
  const d = log.data.slice(2);
  const word = (k) => BigInt("0x" + d.slice(64 * k, 64 * k + 64));
  const raw = wethSide === 0 ? word(0) + word(2) : wethSide === 1 ? word(1) + word(3) : null;
  return { raw, sender: "0x" + log.topics[1].slice(26).toLowerCase() };
}

// ── fetchers ─────────────────────────────────────────────────────────────────

async function postJson(fetchImpl, url, body, timeoutMs = 30_000) {
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r;
}

/** Solana JSON-RPC with backoff on 429 and 5xx. Throws on an RPC error. */
export function solanaRpc({ fetchImpl = globalThis.fetch, url = SOLANA_RPC, pauseMs = 250, wait = sleep } = {}) {
  return async function call(method, params) {
    let last = "";
    for (let i = 0; i < 8; i++) {
      if (pauseMs) await wait(pauseMs);
      let r;
      try {
        r = await postJson(fetchImpl, url, { jsonrpc: "2.0", id: 1, method, params });
      } catch (e) {
        last = e.message;
        await wait(2000 * (i + 1));
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        last = `HTTP ${r.status}`;
        await wait(2500 * (i + 1));
        continue;
      }
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
      return j.result;
    }
    throw new Error(`${method}: no answer after 8 tries (${last})`);
  };
}

/** Signatures newer than `until`, oldest first (getSignaturesForAddress pages newest first). */
export async function newSignatures(call, address, until) {
  const out = [];
  let before;
  for (;;) {
    const page = await call("getSignaturesForAddress", [
      address,
      { limit: 1000, commitment: "finalized", ...(until ? { until } : {}), ...(before ? { before } : {}) },
    ]);
    out.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out.reverse();
}

// Version 1 transactions are on mainnet (first in one of our pools 2026-11-05); a node
// refuses any transaction newer than the version asked for, so a newer one stays loud.
async function getTx(call, signature) {
  const tx = await call("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "finalized" },
  ]);
  if (!tx) throw new Error(`transaction ${signature} did not come back`);
  return tx;
}

/** Walk one address's new transactions; `onTx` decides what each one is. */
async function walk(call, address, until, onTx) {
  const sigs = await newSignatures(call, address, until);
  for (const s of sigs) {
    if (!s.err) onTx(await getTx(call, s.signature), s);
  }
  return sigs.length ? sigs[sigs.length - 1].signature : until ?? null;
}

/** Our pools, listed live from the program, and each one's new swaps. */
export async function readSolanaPools(call, cursor = {}) {
  const countedTo = new Date().toISOString();
  const accounts = await call("getProgramAccounts", [
    VENUE_PROGRAM,
    { encoding: "base64", commitment: "finalized", filters: [{ dataSize: POOL_SIZE }] },
  ]);
  const next = { ...cursor };
  const swaps = [];
  for (const a of accounts) {
    const pool = decodePool(a.pubkey, a.account.data[0]);
    next[pool.address] = await walk(call, pool.address, cursor[pool.address], (tx, s) => {
      const hit = poolSwap(tx, pool);
      if (hit) swaps.push({ ...hit, id: s.signature });
    });
  }
  return { swaps, cursor: next, countedTo };
}

/** Jupiter swaps that paid our fee, from each fee account's new transactions. */
export async function readJupiter(call, cursor = {}) {
  const countedTo = new Date().toISOString();
  const next = { ...cursor };
  const swaps = [];
  for (const account of JUPITER_FEE_ACCOUNTS) {
    next[account] = await walk(call, account, cursor[account], (tx, s) => {
      const hit = jupiterSwap(tx, account);
      if (hit) swaps.push({ ...hit, id: s.signature });
    });
  }
  return { swaps, cursor: next, countedTo };
}

// Waits before the next round: short after a dropped connection or a 5xx, long after a
// rate limit (GitHub's shared runners get throttled partway through a backfill).
const RETRY_WAITS_MS = [2000, 4000, 6000];
const LIMITED_WAITS_MS = [5000, 15000, 30000, 60000];
const isRateLimit = (status, text) => status === 429 || /rate.?limit|request limit|too many requests/i.test(text);

/**
 * EVM JSON-RPC over a list of endpoints: the first that answers wins. A refusal from every
 * endpoint (range too big, archive only) is final at once; a rate limit or an outage is
 * retried after a wait, longer for a rate limit. `pauseMs` spaces out calls.
 */
export function evmRpc({ fetchImpl = globalThis.fetch, rpcs, wait = sleep, pauseMs = 0 } = {}) {
  return async function call(method, params) {
    let last = "";
    for (let round = 0; ; round++) {
      if (pauseMs) await wait(pauseMs);
      let limited = false;
      let transient = false;
      for (const url of rpcs) {
        try {
          const r = await postJson(fetchImpl, url, { jsonrpc: "2.0", id: 1, method, params });
          const text = await r.text();
          let j = null;
          try {
            j = JSON.parse(text);
          } catch {
            // not JSON: judged by its status below
          }
          if (r.ok && j && !j.error) return j.result;
          const why = j?.error ? JSON.stringify(j.error) : `HTTP ${r.status}`;
          last = `${url} ${why.slice(0, 160)}`;
          if (isRateLimit(r.status, why)) limited = true;
          else if (r.status >= 500 || !j) transient = true;
        } catch (e) {
          last = `${url} ${e.message}`;
          transient = true;
        }
      }
      const waits = limited ? LIMITED_WAITS_MS : RETRY_WAITS_MS;
      if ((!limited && !transient) || round >= waits.length) break;
      await wait(waits[round]);
    }
    throw new Error(`${method}: ${last}`);
  };
}

/**
 * Logs with `topic` (a Swap log unless said) in [from, to]. Each window goes to the RPCs.
 * When they refuse one (old blocks), Blockscout reads up to the block it has indexed and
 * the RPCs take the rest; without a Blockscout answer the window shrinks to 100 blocks
 * (drpc's free limit). When even that fails, or the run's time is up, it returns what it
 * read so far: `through` is the last block read and `stopped` says why, so the caller can
 * save that much and resume.
 */
async function swapLogs(call, chain, addresses, from, to, { fetchImpl, deadline = Infinity, now = Date.now, topic = EVM_SWAP_TOPIC }) {
  const logs = [];
  let span = chain.logSpan ?? LOG_SPAN;
  let blockscoutDown = !chain.blockscout;
  while (from <= to) {
    if (now() > deadline) return { logs, through: from - 1, stopped: "out of time for this run" };
    const end = Math.min(to, from + span - 1);
    try {
      logs.push(
        ...(await call("eth_getLogs", [
          { address: addresses, topics: [topic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + end.toString(16) },
        ])),
      );
      from = end + 1;
      continue;
    } catch (e) {
      const got = blockscoutDown ? null : await fromBlockscout(chain.blockscout, addresses, from, to, fetchImpl, topic).catch(() => null);
      if (got) {
        logs.push(...got.logs);
        from = got.through + 1;
        continue;
      }
      blockscoutDown = true;
      if (span <= MIN_LOG_SPAN) return { logs, through: from - 1, stopped: e.message };
      span = Math.max(MIN_LOG_SPAN, Math.floor(span / 5));
    }
  }
  return { logs, through: to, stopped: null };
}

/** Every address's logs from Blockscout for [from, the block it has indexed], or null. */
async function fromBlockscout(base, addresses, from, to, fetchImpl, topic = EVM_SWAP_TOPIC) {
  const through = Math.min(to, await blockscoutIndexed(base, fetchImpl));
  if (through < from) return null;
  const logs = [];
  for (const a of addresses) logs.push(...(await blockscoutLogs(base, a, from, through, fetchImpl, topic)));
  return { logs, through };
}

async function blockscoutGet(url, fetchImpl) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`blockscout HTTP ${r.status}`);
  return r.json();
}

/** The newest block Blockscout has indexed. */
export async function blockscoutIndexed(base, fetchImpl) {
  const height = Number((await blockscoutGet(`${base}/api/v2/main-page/blocks`, fetchImpl))?.[0]?.height);
  if (!Number.isSafeInteger(height)) throw new Error("blockscout did not say what it has indexed");
  return height;
}

/**
 * Blockscout's getLogs, trusted only in its two exact shapes ("OK" with logs, or "No logs
 * found" with none) and only up to the block it has indexed: a rate-limited or lagging
 * answer must never read as a range with no swaps. Halves the range at its 1,000 cap.
 */
export async function blockscoutLogs(base, address, from, to, fetchImpl, topic = EVM_SWAP_TOPIC) {
  const indexed = await blockscoutIndexed(base, fetchImpl);
  if (!(indexed >= to)) throw new Error(`blockscout has indexed to ${indexed}, not ${to}`);
  const read = async (a, b) => {
    const j = await blockscoutGet(`${base}/api?module=logs&action=getLogs&address=${address}&topic0=${topic}&fromBlock=${a}&toBlock=${b}`, fetchImpl);
    const ok = j?.status === "1" && j.message === "OK" && Array.isArray(j.result);
    const none = j?.status === "0" && j.message === "No logs found" && Array.isArray(j.result) && j.result.length === 0;
    if (!ok && !none) throw new Error(`blockscout getLogs: ${JSON.stringify(j).slice(0, 120)}`);
    if (j.result.length < 1000) return j.result.map((l) => ({ ...l, address: l.address.toLowerCase() }));
    if (a === b) throw new Error(`more than 1,000 swaps in block ${a}`);
    const mid = Math.floor((a + b) / 2);
    return [...(await read(a, mid)), ...(await read(mid + 1, b))];
  };
  return read(from, to);
}

const ethCall = (call, to, data) => call("eth_call", [{ to, data }, "latest"]);
const addrWord = (hex) => "0x" + hex.slice(-40).toLowerCase();

/**
 * Every pair of every factory on the chain, with its two coins and its WETH side. The
 * cursor's pairs are kept and only new ones are read. A pair saved before 2026-11-13 names
 * no factory (it is the first one's) and no coins: a pair of those with no WETH side has
 * its coins read once more, since Robinhood's WETH was unset when its pair was first seen.
 */
export async function listPairs(call, chain, saved) {
  const weth = chain.weth?.toLowerCase() ?? null;
  const first = chain.factories[0].toLowerCase();
  const coins = async (address) => [addrWord(await ethCall(call, address, "0x0dfe1681")), addrWord(await ethCall(call, address, "0xd21220a7"))];
  const sideOf = (tokens) => (weth === null ? null : tokens.indexOf(weth) >= 0 ? tokens.indexOf(weth) : null);
  const out = [];
  for (const factory of chain.factories.map((f) => f.toLowerCase())) {
    const mine = [];
    for (const p of saved.filter((s) => (s.factory ?? first) === factory)) {
      const tokens = p.tokens ?? (p.wethSide === null ? await coins(p.address) : null);
      mine.push({ address: p.address, factory, ...(tokens ? { tokens } : {}), wethSide: tokens ? sideOf(tokens) : p.wethSide });
    }
    const total = Number(BigInt(await ethCall(call, factory, "0x574f2ba3")));
    for (let i = mine.length; i < total; i++) {
      const address = addrWord(await ethCall(call, factory, "0x1e3dd18b" + i.toString(16).padStart(64, "0")));
      const tokens = await coins(address);
      mine.push({ address, factory, tokens, wethSide: sideOf(tokens) });
    }
    out.push(...mine);
  }
  return out;
}

/** Swap logs as swaps: each with its WETH leg (none for a pair with no WETH side) and its sender. */
function toSwaps(logs, pairs) {
  const side = new Map(pairs.map((p) => [p.address, p.wethSide]));
  const out = [];
  for (const log of logs) {
    if (log.removed) continue;
    const { raw, sender } = evmSwapLeg(log, side.get(log.address.toLowerCase()));
    out.push({ leg: raw === null ? null : { mint: "WETH", raw }, payer: sender, id: `${log.transactionHash}:${log.logIndex}` });
  }
  return out;
}

/**
 * One chain's new Swap logs on every pair of our factories, up to its finalized block.
 * Pairs are listed at "latest", which is past the finalized block, so a pair born in
 * a window is known before its window is read. No pairs: the cursor jumps to the head.
 * A read that stops short returns its swaps, a cursor at the last block read, no
 * countedTo, and `incomplete` saying why.
 *
 * A saved pair that had no WETH side and has one now (Robinhood's, once its WETH was set)
 * had every swap up to the cursor counted with no dollars. Those swaps come back once as
 * `repriced`: the caller adds their dollars and takes them off the unpriced count, in the
 * same write that saves the pair's WETH side, so it happens once. Their old range is read
 * whole or the chain is not counted this run.
 */
export async function readEvmChain(call, chain, cursor, { fetchImpl = globalThis.fetch, deadline, now } = {}) {
  const head = await call("eth_getBlockByNumber", ["finalized", false]);
  const headBlock = Number(BigInt(head.number));
  const countedTo = new Date(Number(BigInt(head.timestamp)) * 1000).toISOString();
  const saved = cursor?.pairs ?? [];
  const pairs = await listPairs(call, chain, saved);
  let from = cursor ? cursor.block + 1 : chain.startBlock;
  if (pairs.length && from == null) throw new Error("this factory has pairs and no start block to read them from");
  const wasUnpriced = new Set(saved.filter((p) => p.wethSide === null && !p.tokens).map((p) => p.address));
  const repricedPairs = pairs.filter((p) => wasUnpriced.has(p.address) && p.wethSide !== null);
  let repriced = [];
  if (repricedPairs.length && cursor && chain.startBlock != null && chain.startBlock <= cursor.block) {
    const old = await swapLogs(call, chain, repricedPairs.map((p) => p.address), chain.startBlock, cursor.block, { fetchImpl, now });
    if (old.stopped) throw new Error(`the swaps to reprice could not all be read: ${old.stopped}`);
    repriced = toSwaps(old.logs, repricedPairs);
  }
  let swaps = [];
  let read = { logs: [], through: headBlock, stopped: null };
  if (pairs.length && from <= headBlock) {
    read = await swapLogs(call, chain, pairs.map((p) => p.address), from, headBlock, { fetchImpl, deadline, now });
    swaps = toSwaps(read.logs, pairs);
  }
  const more = repriced.length ? { repriced } : {};
  if (read.stopped) return { swaps, ...more, cursor: { block: read.through, pairs }, countedTo: null, incomplete: read.stopped };
  return { swaps, ...more, cursor: { block: headBlock, pairs }, countedTo };
}

/**
 * A LoanEmitted log's borrower and principal. Its data is (loanId, offerId[], loan, fee),
 * the loan a tuple with a dynamic tranche list, so its third word is where the loan starts;
 * the loan's first word is the borrower, its fourth the principal's coin and its fifth the
 * principal. Throws on a log too short to hold them.
 */
export function loanEmitted(log) {
  const d = log.data.slice(2);
  const word = (k) => {
    const hex = d.slice(64 * k, 64 * k + 64);
    if (hex.length !== 64) throw new Error(`a LoanEmitted log too short to read: ${log.transactionHash}`);
    return BigInt("0x" + hex);
  };
  const at = Number(word(2) / 32n);
  return {
    borrower: "0x" + word(at).toString(16).padStart(40, "0"),
    coin: "0x" + word(at + 3).toString(16).padStart(40, "0"),
    principal: word(at + 4),
  };
}

/**
 * New loans on NFT Lending since the cursor, up to the finalized block, each with its
 * principal as the WETH leg (a loan in any other coin has no leg). The same windows,
 * Blockscout fallback and resume as a chain's swaps.
 */
export async function readNftLoans(call, cursor, { fetchImpl = globalThis.fetch, deadline, now, lending = NFT_LENDING } = {}) {
  const head = await call("eth_getBlockByNumber", ["finalized", false]);
  const headBlock = Number(BigInt(head.number));
  const countedTo = new Date(Number(BigInt(head.timestamp)) * 1000).toISOString();
  const from = cursor ? cursor.block + 1 : lending.startBlock;
  const weth = lending.weth.toLowerCase();
  const swaps = [];
  let read = { logs: [], through: headBlock, stopped: null };
  if (from <= headBlock) {
    read = await swapLogs(call, lending, [lending.loan.toLowerCase()], from, headBlock, { fetchImpl, deadline, now, topic: LOAN_EMITTED_TOPIC });
    for (const log of read.logs) {
      if (log.removed || log.address.toLowerCase() !== lending.loan.toLowerCase() || log.topics?.[0] !== LOAN_EMITTED_TOPIC) continue;
      const loan = loanEmitted(log);
      swaps.push({ leg: loan.coin === weth ? { mint: "WETH", raw: loan.principal } : null, payer: loan.borrower, id: `${log.transactionHash}:${log.logIndex}` });
    }
  }
  if (read.stopped) return { swaps, cursor: { block: read.through }, countedTo: null, incomplete: read.stopped };
  return { swaps, cursor: { block: headBlock }, countedTo };
}
