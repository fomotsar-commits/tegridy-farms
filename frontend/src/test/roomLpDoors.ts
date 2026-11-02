// The rule behind registry-onchain.yml's "Every room's LP door names its SOL pool" step.
//
// A Solana room shows an "Add SOL + <coin>" door on its first screen only when its entry
// in lib/bungalows.ts names a pool in `venueSolPool` (`bungalowLpDoor`). That field is
// written by hand, and a pool anyone opens on the venue's pool program gives no signal:
// RIZZ's SOL pool opened 2026-10-16 and BRAINLET's, BOBO's and SOY's 10-17 and 10-18, and
// their rooms had no door until someone read the chain by hand on 10-18.
//
// Two halves. `judgeRoomLpDoors` is the rule, pure, pinned on canned pools by
// roomLpDoors.test.ts. `readVenueSolPools` reads mainnet. roomLpDoors.onchain.test.ts runs
// both against the real BUNGALOWS, and only where ROOM_LP_DOORS_ONCHAIN=1 is set: the
// registry-onchain.yml job, daily and on a diff that touches the registry. So an RPC that
// does not answer reddens that job and never an unrelated merge.

import { base58 } from '@scure/base';
import { PublicKey } from '@solana/web3.js';
import type { Bungalow } from '../lib/bungalows';
import { REGISTERED_PROGRAM_ID as REGISTERED_LAUNCH_PROGRAM, poolStatePda } from '../lib/launcher/solana/curve/program';
import { ACCOUNT_POOL_STATE, POOL_STATE_LEN, POOL_STATE_OFFSETS, REGISTERED_PROGRAM_ID, decodePoolState, deriveAmmConfig } from '../lib/solana/cpswap/program';
import { LAUNCH_TIER_INDEX } from '../lib/solana/lp/poolFinder';
import { solOf } from '../lib/solana/cpswap/venue';
import { SOL_QUOTE, readPair } from '../lib/solana/lp/quotes';

/** One pool on the venue's pool program that pairs SOL with another coin. */
export interface SolPool {
  address: string;
  /** The other coin's mint. */
  tokenMint: string;
  /** Lamports in the pool's SOL vault; null when the vault did not read as a wrapped SOL account. */
  solLamports: bigint | null;
}

/** A Solana room with a coin, as the door rule sees it. */
export interface RoomDoor {
  id: string;
  symbol: string;
  mint: string;
  venueSolPool?: string;
}

/** Every Solana room with a coin. */
export function roomsWithCoins(bungalows: readonly Bungalow[]): RoomDoor[] {
  return bungalows.flatMap((b) => (b.chain === 'solana' && b.address ? [{ id: b.id, symbol: b.symbol, mint: b.address, venueSolPool: b.venueSolPool }] : []));
}

export interface DoorVerdict {
  /** Each one fails the check. */
  problems: string[];
  /** Said, not failed: a named pool that is not the deepest. Depth moves with every trade. */
  notes: string[];
  /** One line per room, for the job log. */
  lines: string[];
}

const solText = (lamports: bigint | null) => (lamports === null ? 'SOL vault unread' : `${solOf(lamports).toFixed(3)} SOL`);

/** Deepest first; a pool whose SOL vault was not read goes last, never first. */
function deepestFirst(a: SolPool, b: SolPool): number {
  if (a.solLamports !== b.solLamports) {
    if (a.solLamports === null) return 1;
    if (b.solLamports === null) return -1;
    return a.solLamports > b.solLamports ? -1 : 1;
  }
  return a.address < b.address ? -1 : 1;
}

/**
 * The rule. For every room: if the venue holds a SOL pool of its coin, `venueSolPool`
 * names one of them (the field asks for the deepest; naming another is a note); and a
 * pool it names is a SOL pool of its own coin on the venue's pool program.
 */
export function judgeRoomLpDoors(rooms: readonly RoomDoor[], pools: readonly SolPool[]): DoorVerdict {
  const problems: string[] = [];
  const notes: string[] = [];
  const lines: string[] = [];
  for (const room of rooms) {
    const who = `${room.symbol} (${room.id})`;
    const own = pools.filter((p) => p.tokenMint === room.mint).sort(deepestFirst);
    const named = room.venueSolPool;
    if (!named) {
      if (own.length === 0) {
        lines.push(`${who}: no SOL pool on the venue, no door`);
        continue;
      }
      const count = own.length === 1 ? 'a SOL pool' : `${own.length} SOL pools`;
      problems.push(
        `${who} has ${count} on the venue's pool program but names none in venueSolPool, so its "Add SOL + ${room.symbol}" door is missing. ` +
          `Name the deepest: ${own[0].address} (${solText(own[0].solLamports)}).`,
      );
      lines.push(`${who}: DOOR MISSING, ${count} unnamed`);
      continue;
    }
    const hit = own.find((p) => p.address === named);
    if (!hit) {
      const other = pools.find((p) => p.address === named);
      const what = other
        ? `a SOL pool of ${other.tokenMint}, not of ${room.symbol}'s ${room.mint}, so its "Add SOL + ${room.symbol}" door opens another coin's pool`
        : `not a SOL pool on the venue's pool program, so its "Add SOL + ${room.symbol}" door opens nothing`;
      const fix = own.length
        ? `${room.symbol}'s SOL pool${own.length === 1 ? '' : 's, deepest first'}: ${own.map((p) => p.address).join(', ')}.`
        : `${room.symbol} has no SOL pool there: remove the field.`;
      problems.push(`${who} names ${named}, which is ${what}. ${fix}`);
      lines.push(`${who}: WRONG POOL ${named}`);
      continue;
    }
    const deepest = own[0];
    if (deepest !== hit && deepest.solLamports !== null && (hit.solLamports === null || deepest.solLamports > hit.solLamports)) {
      notes.push(
        `${who} names ${named} (${solText(hit.solLamports)}), but ${deepest.address} holds more (${solText(deepest.solLamports)}); venueSolPool asks for the deepest.`,
      );
    }
    lines.push(`${who}: door opens ${named} (${solText(hit.solLamports)})${own.length > 1 ? `, ${deepest === hit ? 'the deepest' : 'one'} of ${own.length}` : ''}`);
  }
  return { problems, notes, lines };
}

/** One JSON-RPC call: its `result`, or a throw. Never an empty answer standing in for one. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/** A JSON-RPC client for `url` that tries each call up to `tries` times: the public endpoint rate-limits. */
export function jsonRpc(url: string, tries = 3, fetchImpl: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    let last: unknown = new Error(`${method} was not sent`);
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000 * i));
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`${method} answered HTTP ${res.status}`);
        const body = (await res.json()) as { result?: unknown; error?: { code?: unknown } } | null;
        if (!body || body.error || !('result' in body)) throw new Error(`${method} did not answer${body?.error ? `: error ${String(body.error.code)}` : ''}`);
        return body.result;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
}

const WSOL = SOL_QUOTE.mint;
const POOL_DISCRIMINATOR = base58.encode(ACCOUNT_POOL_STATE);

const base64Data = (account: unknown): Uint8Array | null => {
  const data = (account as { data?: unknown } | null)?.data;
  return Array.isArray(data) && typeof data[0] === 'string' ? Buffer.from(data[0], 'base64') : null;
};

/** The amount in a classic token account of wrapped SOL, or null when the account is not one. */
function wsolAmount(account: unknown): bigint | null {
  if ((account as { owner?: unknown } | null)?.owner !== SOL_QUOTE.program) return null;
  const d = base64Data(account);
  if (!d || d.length !== 165 || base58.encode(d.subarray(0, 32)) !== WSOL) return null;
  return Buffer.from(d).readBigUInt64LE(64);
}

/**
 * Every pool on the venue's pool program that pairs SOL with another coin, with the SOL
 * each holds. Wrapped SOL can sit in either mint slot (token0 < token1 by bytes), so both
 * are scanned. Throws when any read failed or answered something that is not a SOL pool:
 * a list it could not read is never "no pools". A pool on the launch tier that is not the
 * launch pool is left out: the site never uses one (poolFinder.ts), so it is never a door.
 */
export async function readVenueSolPools(rpc: Rpc, program = REGISTERED_PROGRAM_ID.toBase58(), launchProgram = REGISTERED_LAUNCH_PROGRAM): Promise<SolPool[]> {
  const launchTier = deriveAmmConfig(new PublicKey(program), LAUNCH_TIER_INDEX).toBase58();
  const scans = await Promise.all(
    [POOL_STATE_OFFSETS.token0Mint, POOL_STATE_OFFSETS.token1Mint].map((offset) =>
      rpc('getProgramAccounts', [
        program,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          filters: [{ dataSize: POOL_STATE_LEN }, { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR } }, { memcmp: { offset, bytes: WSOL } }],
        },
      ]),
    ),
  );
  const found = new Map<string, { tokenMint: string; vault: string }>();
  for (const scan of scans) {
    if (!Array.isArray(scan)) throw new Error('getProgramAccounts answered no list');
    for (const item of scan as { pubkey?: unknown; account?: unknown }[]) {
      const address = typeof item?.pubkey === 'string' ? item.pubkey : '(no address)';
      const data = base64Data(item?.account);
      const pool = data && decodePoolState(address, data);
      const pair = pool && readPair(pool.token0Mint, pool.token1Mint);
      if (!pool || !pair || pair.quote.mint !== WSOL) throw new Error(`${address} matched the scan but is not a SOL pool`);
      if (pool.ammConfig === launchTier && address !== poolStatePda(new PublicKey(pair.tokenMint), launchProgram).toBase58()) continue;
      found.set(address, { tokenMint: pair.tokenMint, vault: pair.quoteIsToken0 ? pool.token0Vault : pool.token1Vault });
    }
  }
  const entries = [...found];
  const pools: SolPool[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    const answer = await rpc('getMultipleAccounts', [chunk.map(([, p]) => p.vault), { encoding: 'base64', commitment: 'confirmed' }]);
    const value = (answer as { value?: unknown } | null)?.value;
    if (!Array.isArray(value) || value.length !== chunk.length) throw new Error('getMultipleAccounts did not answer every SOL vault');
    chunk.forEach(([address, p], j) => pools.push({ address, tokenMint: p.tokenMint, solLamports: wsolAmount(value[j]) }));
  }
  return pools;
}
