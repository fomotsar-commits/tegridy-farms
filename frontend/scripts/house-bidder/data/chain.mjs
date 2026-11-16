/**
 * Chain reads for the house bidder (BUILD-SPEC 2.4 / 3.4.3), with viem from the frontend's own
 * dependencies. Read-only: nothing here can sign or send.
 *
 *  - snapshot(): ONE multicall pinned to a block (JBAC maxSupply/totalSupply/owner; GNSS
 *    totalSupply/owner/contractLocked; the house's WETH balance, WETH allowance to OpenSea's conduit,
 *    Seaport 1.6 counter and ETH balance; the block time), plus one eth_getStorageAt at the SAME
 *    block for GNSS slot 0xd (its "seed", which can mint; no view function returns it).
 *  - watch(): per new block, the logs since the last block it processed (Transfer + OwnershipTransferred
 *    on both collections, Seaport 1.6 OrderFulfilled with offerer = house), then the handlers, then a
 *    snapshot (admin changes between two snapshots). Nothing is emitted until every log read for the
 *    range succeeded, and a range that failed is read again next time, so a flaky RPC delays an event
 *    but never loses one; a snapshot that fails is reported and holds back no log event. Emitted
 *    events are also de-duplicated by (tx, log index). A WebSocket (`wsUrl`) only makes it react
 *    sooner; correctness comes from the block ranges, polled every 12 s without one.
 *  - receipt(): one transaction's block and success, or null while it is not mined (added to 2.4:
 *    the bot checks an approval the signer stopped waiting for).
 *  - Fills are decoded from OrderFulfilled plus the transaction's receipt: the NFT the house received,
 *    the WETH paid per unit, `seller` = who received the house's WETH (the event's `recipient`, which
 *    was the WETH receiver in all 172 real bid fills checked), `fulfiller` = tx.from (for an ERC-4337
 *    smart account that is the bundler, so the monitor should screen both).
 *
 * viem's getLogs has no raw `topics` field: a raw one is silently ignored and every log comes back
 * (learned live on 2026-11-16). Filters here always use `event` + indexed `args`.
 *
 * RPC URLs can carry keys, and viem puts the URL in its error text, so every error leaving this
 * module has the URLs replaced by `<rpc>`.
 *
 * Units: amounts and counters bigint; `block` and `time` (unix seconds) are numbers.
 */
import { createPublicClient, decodeEventLog, fallback, http, parseAbi, parseAbiItem, webSocket } from 'viem';
import { mainnet } from 'viem/chains';
import { GNSS_SEED_SLOT, MULTICALL3, NO_CONDUIT_KEY, OPENSEA_CONDUIT, OPENSEA_CONDUIT_KEY, SEAPORT_16, SECONDS_PER_SLOT, TOPICS, WETH, ZERO_ADDRESS } from './constants.mjs';
import { isAddress, isDecimalString, lowerAddress, makeLog } from './util.mjs';

export const READ_ABI = parseAbi([
  'function maxSupply() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function contractLocked() view returns (bool)',
  'function getCounter(address offerer) view returns (uint256 counter)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
]);
export const ORDER_FULFILLED = parseAbiItem(
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
);
export const NFT_TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
export const OWNERSHIP_TRANSFERRED = parseAbiItem('event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)');

const topicAddress = (t) => `0x${t.slice(26)}`.toLowerCase();
const lowerOrNull = (a) => (isAddress(a) ? a.toLowerCase() : null);

export class ChainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChainError';
    this.kind = 'rpc';
  }
}

/**
 * Decode one Seaport OrderFulfilled log as a house fill, or null when the offerer is not the house.
 * Pure: `receipt` is the transaction's receipt (for tx.from and the WETH/NFT transfer logs) and
 * `time` its block's unix seconds. Exported for the decode test on real logs.
 */
export function decodeFill({ log, receipt, house, contracts, time }) {
  const h = lowerAddress(house, 'house');
  const { args } = decodeEventLog({ abi: [ORDER_FULFILLED], data: log.data, topics: log.topics });
  if (args.offerer.toLowerCase() !== h) return null;
  const slugByContract = new Map(Object.entries(contracts).map(([slug, a]) => [a.toLowerCase(), slug]));
  const offerWei = args.offer.filter((o) => o.itemType === 1 && o.token.toLowerCase() === WETH).reduce((s, o) => s + o.amount, 0n);
  const nftLines = args.consideration.filter((c) => (c.itemType === 2 || c.itemType === 3) && c.recipient.toLowerCase() === h);
  const units = nftLines.reduce((s, c) => s + c.amount, 0n);
  const nft = nftLines[0];
  const contract = nft ? nft.token.toLowerCase() : null;
  const tokenId = nft ? nft.identifier.toString() : null;
  const rlogs = receipt?.logs ?? [];
  // Who received the house's WETH in this transaction (Transfer has 3 topics for an ERC-20).
  const wethOut = rlogs
    .filter((l) => l.address?.toLowerCase() === WETH && l.topics?.[0] === TOPICS.Transfer && l.topics.length === 3 && topicAddress(l.topics[1]) === h)
    .map((l) => ({ to: topicAddress(l.topics[2]), value: BigInt(l.data) }));
  const recipient = args.recipient.toLowerCase();
  let seller = recipient !== ZERO_ADDRESS ? recipient : null;
  if (!seller) {
    // A matched-orders path may leave `recipient` empty: the seller is then the one WETH receiver
    // that is not a fee line of this order.
    const feeTo = new Set(args.consideration.map((c) => c.recipient.toLowerCase()));
    const others = [...new Set(wethOut.map((t) => t.to).filter((t) => !feeTo.has(t)))];
    seller = others.length === 1 ? others[0] : null;
  }
  // The NFT's previous owner: the ERC-721 Transfer of this token into the house in the same tx.
  const nftIn = nft
    ? rlogs.find((l) => l.address?.toLowerCase() === contract && l.topics?.[0] === TOPICS.Transfer && l.topics.length === 4 && topicAddress(l.topics[2]) === h && BigInt(l.topics[3]) === nft.identifier)
    : null;
  const fees = args.consideration
    .filter((c) => c.recipient.toLowerCase() !== h)
    .map((c) => ({ recipient: c.recipient.toLowerCase(), token: c.token.toLowerCase(), amount: c.amount }));
  return {
    txHash: log.transactionHash.toLowerCase(),
    block: Number(log.blockNumber),
    time,
    orderHash: args.orderHash.toLowerCase(),
    slug: contract ? slugByContract.get(contract) ?? null : null,
    tokenId,
    unitPriceWei: units > 0n ? offerWei / units : null,
    seller,
    fulfiller: lowerOrNull(receipt?.from),
    // Added to 2.4's Fill shape, for the fill monitor and de-duplication.
    logIndex: Number(log.logIndex),
    contract,
    units,
    offerWei,
    nftFrom: nftIn ? topicAddress(nftIn.topics[1]) : null,
    sellerGotWeth: seller ? wethOut.some((t) => t.to === seller) : false,
    zone: topicAddress(log.topics[2]),
    fees,
    // A house order whose fill did not deliver exactly one NFT to the house is not a bid fill the
    // bot understands; the risk engine should halt on it.
    anomaly: nftLines.length !== 1 || units !== 1n || !contract || !slugByContract.has(contract) ? 'not-one-known-nft' : null,
  };
}

/** The changes between two snapshots that the risk engine treats as admin or supply events. */
export function diffSnapshots(before, after) {
  const fields = [
    ['jbac.maxSupply', (s) => s.jbac.maxSupply],
    ['jbac.totalSupply', (s) => s.jbac.totalSupply],
    ['jbac.owner', (s) => s.jbac.owner],
    ['gnss.totalSupply', (s) => s.gnss.totalSupply],
    ['gnss.owner', (s) => s.gnss.owner],
    ['gnss.contractLocked', (s) => s.gnss.contractLocked],
    // The whole storage word, so a change to anything packed beside the address is seen too.
    ['gnss.seed', (s) => s.gnss.seedWord ?? s.gnss.seed],
  ];
  const changes = [];
  for (const [field, get] of fields) {
    const a = get(before);
    const b = get(after);
    if (a !== b) changes.push({ field, before: a, after: b, block: after.block });
  }
  return changes;
}

/** Which operator a listing's maker must have approved for Seaport to move the NFT. */
function operatorFor(listing) {
  const key = listing.conduitKey == null ? OPENSEA_CONDUIT_KEY : String(listing.conduitKey).toLowerCase();
  if (key === OPENSEA_CONDUIT_KEY) return OPENSEA_CONDUIT;
  // No conduit: Seaport itself pulls the NFT.
  if (key === NO_CONDUIT_KEY) return lowerOrNull(listing.protocol) ?? SEAPORT_16;
  return null;
}

const defaultTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/**
 * @param {object} o
 * @param {string[]} o.httpUrls one or more HTTP RPC URLs (tried in order by viem's fallback)
 * @param {string} [o.wsUrl] a WebSocket RPC for new-block notifications
 * @param {string} o.house the house wallet
 * @param {{ junglebay: string, gnssart: string }} o.contracts collection addresses by slug
 * @param {() => number} [o.now] a millisecond clock
 * @param {*} [o.log]
 * @param {object} [o.viemImpl] { client } (a ready public client, as tests pass) or replacements for
 *   viem's { createPublicClient, http, webSocket, fallback }
 */
export function createChain({ httpUrls, wsUrl, house, contracts, now = Date.now, log, viemImpl, pollMs = 12_000, logChunk = 10_000, timers = defaultTimers } = {}) {
  const h = lowerAddress(house, 'house');
  if (!contracts || !isAddress(contracts.junglebay) || !isAddress(contracts.gnssart)) throw new TypeError('contracts must give the junglebay and gnssart addresses');
  const c = { junglebay: contracts.junglebay.toLowerCase(), gnssart: contracts.gnssart.toLowerCase() };
  const out = makeLog(log);
  const urls = [...(Array.isArray(httpUrls) ? httpUrls : []), ...(wsUrl ? [wsUrl] : [])].filter((u) => typeof u === 'string' && u);
  const scrub = (s) => urls.reduce((t, u) => t.split(u).join('<rpc>'), String(s ?? ''));
  const fail = (what, e) => new ChainError(`${what}: ${scrub(e?.shortMessage ?? e?.message ?? e)}`);

  let client;
  let wsClient = null;
  if (viemImpl?.client) {
    client = viemImpl.client;
    wsClient = viemImpl.wsClient ?? null;
  } else {
    if (!Array.isArray(httpUrls) || !httpUrls.length) throw new TypeError('httpUrls must list at least one RPC URL');
    const v = { createPublicClient, http, webSocket, fallback, ...viemImpl };
    const transports = httpUrls.map((u) => v.http(u, { timeout: 15_000, retryCount: 1 }));
    client = v.createPublicClient({ chain: mainnet, transport: transports.length > 1 ? v.fallback(transports) : transports[0] });
    if (wsUrl) wsClient = v.createPublicClient({ chain: mainnet, transport: v.webSocket(wsUrl, { reconnect: true }) });
  }

  // Remembered between calls: once a provider refused a range, later scans start at the size it took.
  let chunk = Math.max(1, Math.floor(logChunk));
  const RANGE_ERROR = /range|exceed|limit|too (many|large|big)|more than|10,?000|block count/i;

  async function getLogsRange(filter, fromBlock, toBlock) {
    const logs = [];
    let start = fromBlock;
    while (start <= toBlock) {
      const end = Math.min(toBlock, start + chunk - 1);
      try {
        logs.push(...(await client.getLogs({ ...filter, fromBlock: BigInt(start), toBlock: BigInt(end) })));
        start = end + 1;
      } catch (e) {
        if (chunk > 1 && RANGE_ERROR.test(String(e?.details ?? '') + String(e?.shortMessage ?? '') + String(e?.message ?? ''))) {
          chunk = Math.max(1, Math.floor(chunk / 2));
          continue;
        }
        throw e;
      }
    }
    return logs;
  }

  const blockTimes = new Map();
  async function blockTime(blockNumber, hint) {
    const n = Number(blockNumber);
    if (hint != null) return Number(hint);
    if (blockTimes.has(n)) return blockTimes.get(n);
    const b = await client.getBlock({ blockNumber: BigInt(n) });
    const t = Number(b.timestamp);
    if (blockTimes.size > 5_000) blockTimes.clear();
    blockTimes.set(n, t);
    return t;
  }

  async function head() {
    const b = await client.getBlock();
    return { number: Number(b.number), time: Number(b.timestamp) };
  }

  /** How far back `seconds` reach: blocks are at least 12 s apart, so this covers at least that. */
  const blocksSince = (seconds) => Math.ceil(Math.max(0, seconds) / SECONDS_PER_SLOT) + 1;

  async function snapshot({ blockNumber } = {}) {
    try {
      const block = blockNumber == null ? await client.getBlockNumber() : BigInt(blockNumber);
      const contractsToRead = [
        { address: c.junglebay, abi: READ_ABI, functionName: 'maxSupply' },
        { address: c.junglebay, abi: READ_ABI, functionName: 'totalSupply' },
        { address: c.junglebay, abi: READ_ABI, functionName: 'owner' },
        { address: c.gnssart, abi: READ_ABI, functionName: 'totalSupply' },
        { address: c.gnssart, abi: READ_ABI, functionName: 'owner' },
        { address: c.gnssart, abi: READ_ABI, functionName: 'contractLocked' },
        { address: WETH, abi: READ_ABI, functionName: 'balanceOf', args: [h] },
        { address: WETH, abi: READ_ABI, functionName: 'allowance', args: [h, OPENSEA_CONDUIT] },
        { address: SEAPORT_16, abi: READ_ABI, functionName: 'getCounter', args: [h] },
        { address: MULTICALL3, abi: READ_ABI, functionName: 'getEthBalance', args: [h] },
        { address: MULTICALL3, abi: READ_ABI, functionName: 'getCurrentBlockTimestamp' },
      ];
      // allowFailure false: a snapshot with a hole could hide exactly the change it exists to see.
      const [r, seedWord] = await Promise.all([
        client.multicall({ contracts: contractsToRead, allowFailure: false, blockNumber: block, batchSize: 0 }),
        client.getStorageAt({ address: c.gnssart, slot: GNSS_SEED_SLOT, blockNumber: block }),
      ]);
      const word = (seedWord && seedWord !== '0x' ? seedWord : `0x${'0'.repeat(64)}`).toLowerCase();
      return {
        block: Number(block),
        time: Number(r[10]),
        house: { weth: r[6], allowance: r[7], counter: r[8], eth: r[9] },
        jbac: { maxSupply: r[0], totalSupply: r[1], owner: r[2].toLowerCase() },
        gnss: { totalSupply: r[3], owner: r[4].toLowerCase(), contractLocked: r[5], seed: `0x${word.slice(26)}`, seedWord: word },
      };
    } catch (e) {
      throw fail('chain snapshot failed', e);
    }
  }

  async function fillsFromLogs(logs) {
    const fills = [];
    for (const l of logs) {
      const receipt = await client.getTransactionReceipt({ hash: l.transactionHash });
      const time = await blockTime(l.blockNumber, l.blockTimestamp);
      const f = decodeFill({ log: l, receipt, house: h, contracts: c, time });
      if (f) fills.push(f);
    }
    return fills;
  }

  function watch(handlers = {}) {
    const call = (name, arg) => {
      const fn = handlers[name];
      if (typeof fn !== 'function') return;
      try {
        fn(arg);
      } catch (e) {
        out.error(`chain handler ${name} threw: ${scrub(e?.message ?? e)}`);
      }
    };
    let stopped = false;
    let busy = false;
    let lastBlock = null;
    let prevSnap = null;
    const emitted = new Set();
    const once = (key) => {
      if (emitted.has(key)) return false;
      if (emitted.size > 10_000) emitted.clear();
      emitted.add(key);
      return true;
    };

    async function tick() {
      if (busy || stopped) return;
      busy = true;
      try {
        const latest = Number(await client.getBlockNumber());
        // Start at the current block: history is houseFills()'s job (BUILD-SPEC 2.4 re-seed).
        if (lastBlock == null) lastBlock = latest - 1;
        if (latest <= lastBlock) return;
        const from = lastBlock + 1;
        const [nftLogs, fillLogs] = await Promise.all([
          getLogsRange({ address: [c.junglebay, c.gnssart], events: [NFT_TRANSFER, OWNERSHIP_TRANSFERRED] }, from, latest),
          getLogsRange({ address: SEAPORT_16, event: ORDER_FULFILLED, args: { offerer: h } }, from, latest),
        ]);
        const fills = await fillsFromLogs(fillLogs);
        // Every log read for the range succeeded: only now is anything emitted. The snapshot is
        // read after, on its own: a snapshot that keeps failing must not keep back a mint, a
        // house fill or an owner change (the bot would bid on, blind to them).
        const slugOf = (a) => (a.toLowerCase() === c.junglebay ? 'junglebay' : 'gnssart');
        for (const l of nftLogs) {
          const key = `${l.transactionHash}:${l.logIndex}`;
          if (l.topics[0] === TOPICS.Transfer && l.topics.length === 4) {
            const sender = topicAddress(l.topics[1]);
            const to = topicAddress(l.topics[2]);
            const tokenId = BigInt(l.topics[3]).toString();
            const base = { slug: slugOf(l.address), tokenId, txHash: l.transactionHash.toLowerCase(), block: Number(l.blockNumber), logIndex: Number(l.logIndex) };
            if (sender === ZERO_ADDRESS && once(`mint:${key}`)) call('onMint', { ...base, to });
            // Added to 2.4: any NFT moving in or out of the house (an unsolicited NFT is an inventory change too).
            if ((sender === h || to === h) && once(`house:${key}`)) call('onHouseTransfer', { ...base, from: sender, to });
          } else if (l.topics[0] === TOPICS.OwnershipTransferred && once(`owner:${key}`)) {
            call('onOwnerChange', { slug: slugOf(l.address), from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), txHash: l.transactionHash.toLowerCase(), block: Number(l.blockNumber) });
          }
        }
        for (const f of fills) if (once(`fill:${f.txHash}:${f.logIndex}`)) call('onFill', f);
        lastBlock = latest;
        // A failure here is reported below (onError); the next good snapshot is compared with
        // the last good one, so an admin change in between is still seen.
        const snap = await snapshot({ blockNumber: latest });
        if (prevSnap) for (const change of diffSnapshots(prevSnap, snap)) call('onAdmin', change);
        prevSnap = snap;
        call('onSnapshot', snap);
      } catch (e) {
        const err = e instanceof ChainError ? e : fail('chain watch read failed', e);
        out.warn(err.message);
        call('onError', err);
      } finally {
        busy = false;
      }
    }

    let unwatch = null;
    const interval = timers.setInterval(() => void tick(), wsClient ? 60_000 : pollMs);
    if (wsClient) {
      // New heads only wake the tick sooner; the 60 s interval above is the safety net.
      unwatch = wsClient.watchBlockNumber({ onBlockNumber: () => void tick(), onError: (e) => out.warn(`chain websocket: ${scrub(e?.message ?? e)}`) });
    }
    // Added to 2.4: `ready` settles when the first pass is done; `tick` forces a pass now.
    const ready = tick();
    return {
      stop() {
        stopped = true;
        timers.clearInterval(interval);
        if (typeof unwatch === 'function') unwatch();
      },
      tick,
      ready,
    };
  }

  return {
    snapshot,
    watch,

    /**
     * For each listing: is the maker still the owner, and has the maker approved the operator its
     * order pulls through (OpenSea's conduit, or Seaport itself for a zero conduit key)? One
     * multicall. A failed read is "not fillable", never assumed fine. `blockNumber` pins the read
     * (used to rebuild the fixture day's book).
     */
    async listingFillable(listings, { blockNumber } = {}) {
      const result = new Map();
      const calls = [];
      const index = [];
      for (const l of listings ?? []) {
        if (!l?.orderHash) continue;
        const contract = lowerOrNull(l.contract) ?? (l.slug ? c[l.slug] ?? null : null);
        if (!contract || (contract !== c.junglebay && contract !== c.gnssart)) {
          result.set(l.orderHash, { fillable: false, reason: 'unknown-collection' });
          continue;
        }
        const operator = operatorFor(l);
        if (!operator) {
          result.set(l.orderHash, { fillable: false, reason: 'unknown-conduit' });
          continue;
        }
        const maker = lowerOrNull(l.maker);
        const tokenId = typeof l.tokenId === 'bigint' ? l.tokenId : isDecimalString(String(l.tokenId)) ? BigInt(l.tokenId) : null;
        if (!maker || tokenId == null) {
          result.set(l.orderHash, { fillable: false, reason: 'bad-listing' });
          continue;
        }
        index.push({ orderHash: l.orderHash, maker });
        calls.push(
          { address: contract, abi: READ_ABI, functionName: 'ownerOf', args: [tokenId] },
          { address: contract, abi: READ_ABI, functionName: 'isApprovedForAll', args: [maker, operator] },
        );
      }
      if (!calls.length) return result;
      let r;
      try {
        r = await client.multicall({ contracts: calls, allowFailure: true, batchSize: 0, ...(blockNumber == null ? {} : { blockNumber: BigInt(blockNumber) }) });
      } catch (e) {
        throw fail('listing fillability read failed', e);
      }
      index.forEach((x, i) => {
        const owner = r[2 * i];
        const approved = r[2 * i + 1];
        if (owner?.status !== 'success' || approved?.status !== 'success') result.set(x.orderHash, { fillable: false, reason: 'read-failed' });
        else if (String(owner.result).toLowerCase() !== x.maker) result.set(x.orderHash, { fillable: false, reason: 'not-owner' });
        else if (approved.result !== true) result.set(x.orderHash, { fillable: false, reason: 'not-approved' });
        else result.set(x.orderHash, { fillable: true });
      });
      return result;
    },

    /** Every transfer of one token in the last `sinceDays`, oldest first. */
    async tokenProvenance(slug, tokenId, { sinceDays = 90 } = {}) {
      const contract = c[slug];
      if (!contract) throw new TypeError(`unknown collection "${slug}"`);
      const id = typeof tokenId === 'bigint' ? tokenId : BigInt(String(tokenId));
      try {
        const top = await head();
        const from = Math.max(0, top.number - blocksSince(sinceDays * 86_400));
        const logs = await getLogsRange({ address: contract, event: NFT_TRANSFER, args: { tokenId: id } }, from, top.number);
        const since = Math.floor(now() / 1000) - sinceDays * 86_400;
        const rows = [];
        for (const l of logs) {
          const time = await blockTime(l.blockNumber, l.blockTimestamp);
          if (time < since) continue;
          rows.push({ from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), txHash: l.transactionHash.toLowerCase(), time, block: Number(l.blockNumber), logIndex: Number(l.logIndex) });
        }
        return rows.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      } catch (e) {
        throw e instanceof ChainError ? e : fail('token provenance read failed', e);
      }
    },

    /**
     * Added to 2.4: a transaction's receipt as { blockNumber, success }, or null while it is not
     * mined. The bot reads it for an approval the signer stopped waiting for (it can land later).
     */
    async receipt(txHash) {
      const hash = String(txHash ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new TypeError('a transaction hash is 0x and 64 hex characters');
      try {
        const r = await client.getTransactionReceipt({ hash });
        return r ? { blockNumber: Number(r.blockNumber), success: r.status === 'success' } : null;
      } catch (e) {
        if (e?.name === 'TransactionReceiptNotFoundError') return null;
        throw fail('receipt read failed', e);
      }
    },

    /** eth_getCode; "0x" for an account with no code. An EIP-7702 delegation reads 0xef0100 + address. */
    async code(address) {
      const a = lowerAddress(address, 'address');
      try {
        return ((await client.getCode({ address: a })) ?? '0x').toLowerCase();
      } catch (e) {
        throw fail('code read failed', e);
      }
    },

    /** Every fill of a house order since `sinceSec`, oldest first (to re-seed on start). */
    async houseFills({ sinceSec } = {}) {
      if (!Number.isSafeInteger(sinceSec) || sinceSec < 0) throw new TypeError('sinceSec must be whole unix seconds');
      try {
        const top = await head();
        const from = Math.max(0, top.number - blocksSince(top.time - sinceSec));
        const logs = await getLogsRange({ address: SEAPORT_16, event: ORDER_FULFILLED, args: { offerer: h } }, from, top.number);
        const fills = (await fillsFromLogs(logs)).filter((f) => f.time >= sinceSec);
        return fills.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      } catch (e) {
        throw e instanceof ChainError ? e : fail('house fills read failed', e);
      }
    },
  };
}
