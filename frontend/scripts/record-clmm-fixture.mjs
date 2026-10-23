#!/usr/bin/env node
/**
 * Records real accounts of a live range-pool program with the same layout as the venue's
 * own (solana/tegridy-clmm), so the site's range client (src/lib/solana/clmm/) is proven
 * against accounts it did not make. Prints one JSON document; the unit tests read it from
 * src/lib/solana/clmm/__fixtures__/ and never import it, so nothing recorded reaches the
 * site's bundle.
 *
 * READ ONLY. Plain JSON-RPC reads with no key: getMultipleAccounts and getProgramAccounts.
 * Nothing is signed, simulated or sent, to that program or any other. The program id and
 * pools are arguments, never typed here: the live program today is Raydium's, whose ids
 * must not appear in the site's code.
 *
 *   node scripts/record-clmm-fixture.mjs <rpc-url> <program-id> <pool>... > src/lib/solana/clmm/__fixtures__/mainnet-accounts.json
 *
 * Per pool, at one slot (one getMultipleAccounts call): the pool, its fee tier, its price
 * history, its far-band map, and every used band in full (only the ones near the price
 * when there are more than twelve). Then, from
 * getProgramAccounts slices: every band the pool owns (start index and count of used
 * prices only), and every position in full when there are twelve or fewer (else the four
 * largest). The pool's two coin vaults ride the first read. Account data is gzipped, then
 * base64.
 *
 * It prints only what it has checked: every account owned by the program, each of the
 * size its kind has. Anything else stops it before a byte is printed.
 */
import { gzipSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';

const [RPC, PROGRAM_ARG, ...POOLS] = process.argv.slice(2);
if (!RPC || !PROGRAM_ARG || POOLS.length === 0) {
  console.error('usage: record-clmm-fixture.mjs <rpc-url> <program-id> <pool>...');
  process.exit(2);
}
const PROGRAM = new PublicKey(PROGRAM_ARG);
const SIZE = { pool: 1544, config: 117, observation: 4483, extension: 1832, tickArray: 10240, position: 281 };
const FULL_BANDS_EACH_SIDE = 4;
const ALL_BANDS_IN_FULL_UP_TO = 12;
const MAX_POSITIONS = 4;
const ALL_POSITIONS_UP_TO = 12;
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

let id = 0;
async function call(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`[record] ${method} answered HTTP ${res.status}`);
    const body = await res.json();
    if (body.error || !('result' in body)) throw new Error(`[record] ${method} did not answer${Number.isInteger(body.error?.code) ? `: error ${body.error.code}` : ''}`);
    return body.result;
  }
  throw new Error(`[record] ${method} kept answering 429`);
}

const fail = (what) => {
  throw new Error(`[record] refusing to record: ${what}`);
};
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0].toBase58();
const i32be = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return b;
};
const tickArrayPda = (pool, start) => pda([Buffer.from('tick_array'), new PublicKey(pool).toBuffer(), i32be(start)]);
const startIndex = (tick, spacing) => {
  const n = 60 * spacing;
  let s = Math.trunc(tick / n);
  if (tick < 0 && tick % n !== 0) s -= 1;
  return s * n;
};

/** One account as recorded: owner and size checked, data gzipped. A vault is a token account. */
function keep(value, kind, address) {
  if (!value) fail(`${kind} ${address} does not exist`);
  if (value.data?.[1] !== 'base64') fail(`${kind} ${address} did not come back as base64`);
  const data = Buffer.from(value.data[0], 'base64');
  if (kind === 'vault') {
    if (!TOKEN_PROGRAMS.has(value.owner)) fail(`vault ${address} is not a token account`);
    if (data.length < 165) fail(`vault ${address} is ${data.length} bytes`);
  } else {
    if (value.owner !== PROGRAM.toBase58()) fail(`${kind} ${address} is not owned by the program`);
    if (data.length !== SIZE[kind]) fail(`${kind} ${address} is ${data.length} bytes, not ${SIZE[kind]}`);
  }
  return { kind, owner: value.owner, lamports: value.lamports, gz: gzipSync(data, { level: 9 }).toString('base64') };
}

const out = {
  recordedBy: 'frontend/scripts/record-clmm-fixture.mjs',
  recordedAt: new Date().toISOString(),
  rpcHost: new URL(RPC).host,
  program: PROGRAM.toBase58(),
  pools: [],
};

for (const pool of POOLS) {
  const poolKey = new PublicKey(pool);
  const head = await call('getMultipleAccounts', [[pool], { encoding: 'base64', commitment: 'confirmed' }]);
  const poolData = Buffer.from(head.value[0]?.data?.[0] ?? '', 'base64');
  if (poolData.length !== SIZE.pool) fail(`${pool} is not a pool`);
  const config = new PublicKey(poolData.subarray(9, 41)).toBase58();
  const vault0 = new PublicKey(poolData.subarray(137, 169)).toBase58();
  const vault1 = new PublicKey(poolData.subarray(169, 201)).toBase58();
  const observation = new PublicKey(poolData.subarray(201, 233)).toBase58();
  const spacing = poolData.readUInt16LE(235);
  const tick = poolData.readInt32LE(269);
  const extension = pda([Buffer.from('pool_tick_array_bitmap_extension'), poolKey.toBuffer()]);

  // Every band the pool owns, from two slices: its start index and its count of used prices.
  const filters = [{ dataSize: SIZE.tickArray }, { memcmp: { offset: 8, bytes: pool } }];
  const starts = await call('getProgramAccounts', [PROGRAM.toBase58(), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 40, length: 4 }, filters }]);
  const counts = await call('getProgramAccounts', [PROGRAM.toBase58(), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 10124, length: 1 }, filters }]);
  const countOf = new Map(counts.map((a) => [a.pubkey, Buffer.from(a.account.data[0], 'base64')[0]]));
  const tickArrays = starts
    .map((a) => [a.pubkey, Buffer.from(a.account.data[0], 'base64').readInt32LE(0), countOf.get(a.pubkey)])
    .sort((x, y) => x[1] - y[1]);
  for (const [address, start, count] of tickArrays) {
    if (!Number.isInteger(count)) fail(`band ${address} has no count`);
    if (tickArrayPda(pool, start) !== address) fail(`band ${address} is not at the address its start ${start} derives`);
  }

  // Every position when there are few (so their sum can be held against the pool), else the
  // four largest. Read in the same call as the pool below, so they share its slot.
  const positionKeys = await call('getProgramAccounts', [PROGRAM.toBase58(), {
    encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 81, length: 16 },
    filters: [{ dataSize: SIZE.position }, { memcmp: { offset: 41, bytes: pool } }],
  }]);
  const liquidityOf = (a) => {
    const b = Buffer.from(a.account.data[0], 'base64');
    return b.readBigUInt64LE(0) + (b.readBigUInt64LE(8) << 64n);
  };
  const allPositions = positionKeys.length <= ALL_POSITIONS_UP_TO;
  const chosen = (allPositions ? positionKeys : positionKeys.filter((a) => liquidityOf(a) > 0n))
    .sort((x, y) => (liquidityOf(y) > liquidityOf(x) ? 1 : liquidityOf(y) < liquidityOf(x) ? -1 : x.pubkey < y.pubkey ? -1 : 1))
    .slice(0, allPositions ? ALL_POSITIONS_UP_TO : MAX_POSITIONS)
    .map((a) => a.pubkey);

  // The pool, its vaults, the used bands and the positions, in ONE call so all share a slot.
  const here = startIndex(tick, spacing);
  const used = tickArrays.filter(([, , count]) => count > 0);
  const all = used.length <= ALL_BANDS_IN_FULL_UP_TO;
  const near = used
    .filter(([, start]) => all || Math.abs(start - here) <= FULL_BANDS_EACH_SIDE * 60 * spacing)
    .map(([address]) => address);
  const together = [pool, config, observation, extension, vault0, vault1, ...near, ...chosen];
  if (together.length > 100) fail('more than 100 accounts in one read');
  const read = await call('getMultipleAccounts', [together, { encoding: 'base64', commitment: 'confirmed' }]);
  const accounts = {};
  accounts[pool] = keep(read.value[0], 'pool', pool);
  accounts[config] = keep(read.value[1], 'config', config);
  accounts[observation] = keep(read.value[2], 'observation', observation);
  if (read.value[3]) accounts[extension] = keep(read.value[3], 'extension', extension);
  accounts[vault0] = keep(read.value[4], 'vault', vault0);
  accounts[vault1] = keep(read.value[5], 'vault', vault1);
  near.forEach((address, i) => {
    accounts[address] = keep(read.value[6 + i], 'tickArray', address);
  });
  chosen.forEach((address, i) => {
    accounts[address] = keep(read.value[6 + near.length + i], 'position', address);
  });

  out.pools.push({ pool, slot: read.context.slot, allBandsInFull: all, allPositions, positionsInPool: positionKeys.length, tickArrays, accounts });
  console.error(`[record] ${pool}: slot ${read.context.slot}, ${tickArrays.length} bands (${near.length} in full), ${chosen.length} of ${positionKeys.length} positions`);
}

process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
