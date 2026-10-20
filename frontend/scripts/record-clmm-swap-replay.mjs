#!/usr/bin/env node
/**
 * Records real swaps on a live range-pool program with the venue's layout, each with the
 * pool exactly as it stood just before it, so the site's swap quote (src/lib/solana/clmm/
 * quote.ts) can be replayed against what the program really did. Prints one JSON document;
 * quoteLive.test.ts reads it from src/lib/solana/clmm/__fixtures__/ and never imports it.
 *
 * READ ONLY: getMultipleAccounts, getSignaturesForAddress and getTransaction. Nothing is
 * signed, simulated or sent. The program id and pools are arguments, never typed here.
 *
 *   node scripts/record-clmm-swap-replay.mjs <rpc-url> <program-id> <swaps-per-pool> <pool>... > src/lib/solana/clmm/__fixtures__/mainnet-swaps.json
 *
 * How "just before" is known: the pool, its fee tier, its far-band map and the bands near
 * its price are read in ONE call, at slot S. Then the pool's signatures are paged back to S.
 * The first later slot that holds a successful transaction touching the pool is taken only
 * if it holds exactly one, that one runs exactly one swap on this pool (swap or swap_v2)
 * and nothing else of the program on it, and its event names this pool. Then no write to
 * the pool can fall between the read and the swap. Anything else is skipped and read again.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';

const [RPC, PROGRAM_ARG, PER_POOL, ...POOLS] = process.argv.slice(2);
if (!RPC || !PROGRAM_ARG || !PER_POOL || POOLS.length === 0) {
  console.error('usage: record-clmm-swap-replay.mjs <rpc-url> <program-id> <swaps-per-pool> <pool>...');
  process.exit(2);
}
const PROGRAM = new PublicKey(PROGRAM_ARG);
const WANT = Number(PER_POOL);
const BANDS_EACH_SIDE = 8;
const GIVE_UP_AFTER_MS = Number(process.env.REPLAY_GIVE_UP_MINUTES || 40) * 60 * 1000;
const disc = (s) => createHash('sha256').update(s).digest().subarray(0, 8);
const IX_SWAP = disc('global:swap');
const IX_SWAP_V2 = disc('global:swap_v2');
const EV_SWAP = disc('event:SwapEvent');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58decode = (s) => {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Buffer.from(out);
};

let id = 0;
async function call(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) });
    } catch {
      console.error(`[replay] ${method} did not answer in time: retrying`);
      await sleep(2000);
      continue;
    }
    if (res.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`[replay] ${method} answered HTTP ${res.status}`);
    const body = await res.json();
    if (body.error || !('result' in body)) throw new Error(`[replay] ${method} did not answer${Number.isInteger(body.error?.code) ? `: error ${body.error.code}` : ''}`);
    return body.result;
  }
  throw new Error(`[replay] ${method} kept failing`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0].toBase58();
const i32be = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return b;
};
const gz = (value) => ({ owner: value.owner, lamports: value.lamports, gz: gzipSync(Buffer.from(value.data[0], 'base64'), { level: 9 }).toString('base64') });

/** The bands the pool's own map marks within BANDS_EACH_SIDE of its price. */
function nearBands(pool, data) {
  const spacing = data.readUInt16LE(235);
  const tick = data.readInt32LE(269);
  const span = 60 * spacing;
  const here = Math.floor(tick / span);
  const out = [];
  for (let bit = 0; bit < 1024; bit++) {
    const word = data.readBigUInt64LE(904 + 8 * (bit >> 6));
    if (((word >> BigInt(bit & 63)) & 1n) === 0n) continue;
    const start = (bit - 512) * span;
    if (Math.abs(start / span - here) <= BANDS_EACH_SIDE) out.push([start, pda([Buffer.from('tick_array'), new PublicKey(pool).toBuffer(), i32be(start)])]);
  }
  return out;
}

async function readAt(pool) {
  const first = await call('getMultipleAccounts', [[pool], { encoding: 'base64', commitment: 'confirmed' }]);
  const bands = nearBands(pool, Buffer.from(first.value[0].data[0], 'base64'));
  const head = Buffer.from(first.value[0].data[0], 'base64');
  const config = new PublicKey(head.subarray(9, 41)).toBase58();
  const extension = pda([Buffer.from('pool_tick_array_bitmap_extension'), new PublicKey(pool).toBuffer()]);
  const read = await call('getMultipleAccounts', [[pool, config, extension, ...bands.map((b) => b[1])], { encoding: 'base64', commitment: 'confirmed' }]);
  const poolData = Buffer.from(read.value[0].data[0], 'base64');
  // The map may have changed between the two reads: the bands must be the ones it marks now.
  if (JSON.stringify(nearBands(pool, poolData)) !== JSON.stringify(bands)) return null;
  for (const v of read.value) if (v && v.owner !== PROGRAM.toBase58()) throw new Error('[replay] an account is not the program’s');
  const accounts = { [pool]: { kind: 'pool', ...gz(read.value[0]) }, [config]: { kind: 'config', ...gz(read.value[1]) } };
  if (read.value[2]) accounts[extension] = { kind: 'extension', ...gz(read.value[2]) };
  bands.forEach(([, address], i) => {
    if (read.value[3 + i]) accounts[address] = { kind: 'tickArray', ...gz(read.value[3 + i]) };
  });
  return { slot: read.context.slot, accounts, vault0: new PublicKey(poolData.subarray(137, 169)).toBase58() };
}

/** Every confirmed signature on the pool after `slot`, oldest first, or null while none is. */
async function signaturesAfter(pool, slot) {
  const all = [];
  let before;
  for (;;) {
    const page = await call('getSignaturesForAddress', [pool, { limit: 100, commitment: 'confirmed', ...(before ? { before } : {}) }]);
    if (page.length === 0) break;
    all.push(...page);
    if (page[page.length - 1].slot <= slot) break;
    before = page[page.length - 1].signature;
  }
  const after = all.filter((s) => s.slot > slot);
  return after.length ? after.reverse() : null;
}

const out = { recordedBy: 'frontend/scripts/record-clmm-swap-replay.mjs', recordedAt: new Date().toISOString(), rpcHost: new URL(RPC).host, program: PROGRAM.toBase58(), swaps: [] };

/**
 * One read, then the first write to the pool after it. Returns the swap to keep, null when
 * that write cannot be replayed (logged), or 'timeout' when no write came in time.
 */
async function attempt(pool, started) {
  const state = await readAt(pool);
  if (!state) {
    await sleep(1000);
    return null;
  }
  let sigs = null;
  let lastNote = Date.now();
  while (!sigs && Date.now() - started < GIVE_UP_AFTER_MS) {
    await sleep(2000);
    sigs = await signaturesAfter(pool, state.slot);
    if (!sigs && Date.now() - lastNote > 30_000) {
      console.error(`[replay] ${pool}: waiting for a swap after slot ${state.slot}`);
      lastNote = Date.now();
    }
  }
  if (!sigs) return 'timeout';
  const firstSlot = sigs[0].slot;
  const sameSlot = sigs.filter((s) => s.slot === firstSlot && s.err === null);
  const why = (w) => {
    console.error(`[replay] ${pool}: slot ${firstSlot} skipped: ${w}`);
    return null;
  };
  if (sameSlot.length !== 1) return why(`${sameSlot.length} successful transactions`);
  const tx = await call('getTransaction', [sameSlot[0].signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const ours = ixs.filter((ix) => keys[ix.programIdIndex] === PROGRAM.toBase58() && ix.accounts.some((a) => keys[a] === pool));
  if (ours.length !== 1) return why(`${ours.length} program instructions on the pool`);
  const data = b58decode(ours[0].data);
  const kind = data.subarray(0, 8).equals(IX_SWAP_V2) ? 'swap_v2' : data.subarray(0, 8).equals(IX_SWAP) ? 'swap' : null;
  if (!kind || keys[ours[0].accounts[2]] !== pool) return why('not a single-pool swap');
  const events = (tx.meta.logMessages ?? [])
    .filter((l) => l.startsWith('Program data: '))
    .map((l) => Buffer.from(l.slice('Program data: '.length), 'base64'))
    .filter((b) => b.subarray(0, 8).equals(EV_SWAP) && new PublicKey(b.subarray(8, 40)).toBase58() === pool);
  if (events.length !== 1) return why(`${events.length} swap events`);
  const accounts = ours[0].accounts.map((a) => keys[a]);
  return {
    pool,
    readSlot: state.slot,
    accounts: state.accounts,
    tx: {
      signature: sameSlot[0].signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      kind,
      data: data.toString('base64'),
      accounts,
      zeroForOne: accounts[5] === state.vault0,
      event: events[0].toString('base64'),
    },
  };
}

for (const pool of POOLS) {
  let got = 0;
  const started = Date.now();
  while (got < WANT && Date.now() - started < GIVE_UP_AFTER_MS) {
    let swap;
    try {
      swap = await attempt(pool, started);
    } catch (e) {
      // One failed read costs one attempt, never the swaps already found.
      console.error(`[replay] ${pool}: ${e instanceof Error ? e.message : e}; reading again`);
      await sleep(3000);
      continue;
    }
    if (swap === 'timeout') break;
    if (!swap) continue;
    out.swaps.push(swap);
    got++;
    console.error(`[replay] ${pool}: swap ${got}/${WANT} at slot ${swap.tx.slot} (read at ${swap.readSlot})`);
  }
  if (got < WANT) console.error(`[replay] ${pool}: only ${got} of ${WANT} swaps found in time`);
}

process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
