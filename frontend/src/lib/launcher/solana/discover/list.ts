// Finding launches, from the chain only: no database, no program-wide scan.
//
// `getProgramAccounts` is not allowed through our RPC proxy (an unbounded scan), so
// launches cannot be enumerated. Instead this site's create transaction mentions a
// fixed address (`launchIndexAddress`), and `getSignaturesForAddress` on it returns
// those transactions, newest first.
//
// ⚠ ANYONE CAN MENTION THAT ADDRESS. It is public, and the launch program ignores
// extra accounts, so a launch made anywhere can appear here, and cheap transactions
// that merely mention it can push real launches down the list. So:
//   - a page must label this list "Recent launches. Listed automatically. Anyone can
//     appear here, and we have not checked them.", never "launches made on this site";
//   - every item is re-checked: only a SUCCESSFUL transaction whose TOP-LEVEL
//     instruction is `create_launch` on the configured program counts, and its curve
//     must exist, be owned by that program, and name the same creator;
//   - paging stops after a fixed number of pages, and the result says how many
//     entries were looked at, so an empty list reads "none in the latest N", never
//     "no launches";
//   - `HIDDEN_MINTS` is a committed list of mints never shown.
//
// Every row also carries what was bought in the launch transaction itself, by ANY
// wallet, because a creator can buy most of the curve at the opening price in the
// same transaction (directly, through another program, or from a second wallet) and
// sell into later buyers. It is read from the transaction's token balances, never
// from which instructions we recognise. "Could not read" is kept apart from 0.

import { Buffer } from 'buffer';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { IX_DISCRIMINATOR, curvePda, curveVaultPda, decodeBondingCurve, type BondingCurve } from '../curve/program';
import { effectiveReserves } from '../curve/math';
import { clipDetail, type CurveAccount, type CurveRpc, type Read } from '../curve/read';
import type { SolanaRpc } from '../curve/rpc';
import { associatedTokenAddress } from '../curve/ix';
import { launchIndexAddress } from '../write/config';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../write/metaplex';
import { decodeTokenMetadata, type TokenMetadata } from './metadata';
import type { CurveWriteConfig } from '../write/types';

/** Mints never listed, whatever the chain says. Add a mint here to hide it. */
export const HIDDEN_MINTS: ReadonlySet<string> = new Set<string>([]);

/** Signatures per page; the RPC's own maximum is 1,000, ours is small on purpose. */
export const LIST_PAGE_SIZE = 20;
/** Pages looked at before giving up and saying so. */
export const LIST_MAX_PAGES = 3;

export interface LaunchOrigin {
  signature: string;
  blockTime: number | null;
  creator: PublicKey;
  mint: PublicKey;
  /**
   * Tokens that left the curve in the launch transaction, to ANY wallet (the
   * creator's own buy, a buy through another program, or another wallet's buy
   * bundled into it). `0n` = the token balances were read and nothing left the
   * curve. `null` = the balances were missing or did not add up: could not read.
   */
  openingBuyTokens: bigint | null;
}

export interface LaunchListItem {
  mint: PublicKey;
  creator: PublicKey;
  signature: string;
  blockTime: number | null;
  openingBuyTokens: bigint | null;
  curve: Read<CurveAccount>;
  metadata: Read<TokenMetadata>;
}

export interface LaunchListPage {
  items: LaunchListItem[];
  /** Pass back as `before` for the next page; `null` = nothing older. */
  before: string | null;
  /** How many index entries were looked at, for "none in the latest N". */
  scanned: number;
  /** How many were hidden by `HIDDEN_MINTS`. */
  hidden: number;
}

// ── raw RPC shapes ───────────────────────────────────────────────────────────

interface SigInfo {
  signature: string;
  err: unknown;
  blockTime?: number | null;
}

function asSigInfos(v: unknown): SigInfo[] {
  if (!Array.isArray(v)) throw new Error('getSignaturesForAddress: expected a list');
  return v.map((x) => {
    if (!x || typeof x !== 'object' || typeof (x as SigInfo).signature !== 'string') {
      throw new Error('getSignaturesForAddress: an entry has no signature');
    }
    return x as SigInfo;
  });
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

interface RawTx {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
  transaction?: [string, string] | unknown;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pull the launch out of a fetched transaction, or `null` when it is not a
 * successful, top-level `create_launch` on `programId` (for `wantMint`, if given).
 */
export function parseLaunchTransaction(
  raw: unknown,
  signature: string,
  programId: PublicKey,
  wantMint?: PublicKey,
): LaunchOrigin | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as RawTx;
  if (!t.meta || t.meta.err !== null) return null;
  const enc = t.transaction;
  if (!Array.isArray(enc) || typeof enc[0] !== 'string') return null;

  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(Buffer.from(enc[0], 'base64'));
  } catch {
    return null;
  }
  const msg = vtx.message;
  const loaded = t.meta.loadedAddresses ?? {};
  let keys: PublicKey[];
  try {
    keys = [
      ...msg.staticAccountKeys,
      ...(loaded.writable ?? []).map((k) => new PublicKey(k)),
      ...(loaded.readonly ?? []).map((k) => new PublicKey(k)),
    ];
  } catch {
    return null;
  }

  let creator: PublicKey | null = null;
  let mint: PublicKey | null = null;
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (!prog || !prog.equals(programId)) continue;
    const data = ix.data;
    const acct = (i: number) => {
      const k = keys[ix.accountKeyIndexes[i] ?? -1];
      return k ?? null;
    };
    if (!creator && sameBytes(data, IX_DISCRIMINATOR.createLaunch)) {
      const c = acct(0);
      const m = acct(2);
      if (!c || !m) return null;
      if (wantMint && !m.equals(wantMint)) continue;
      creator = c;
      mint = m;
      continue;
    }
  }
  if (!creator || !mint) return null;

  const openingBuyTokens = boughtInLaunch(t.meta, keys, mint, programId);
  return { signature, blockTime: typeof t.blockTime === 'number' ? t.blockTime : null, creator, mint, openingBuyTokens };
}

/**
 * Tokens of `mint` that reached any account other than the curve's own vault in
 * this transaction: the sum of every other account's increase. `null` when the
 * balances are missing, when the curve vault is not among them (create_launch
 * always fills it, so its absence means the record is incomplete), or when an
 * amount does not parse.
 */
function boughtInLaunch(
  meta: NonNullable<RawTx['meta']>,
  keys: PublicKey[],
  mint: PublicKey,
  programId: PublicKey,
): bigint | null {
  const post = meta.postTokenBalances;
  const pre = meta.preTokenBalances;
  if (!Array.isArray(post) || !Array.isArray(pre)) return null;
  const m58 = mint.toBase58();
  const vault = curveVaultPda(mint, programId);
  const amount = (b: TokenBalance): bigint => {
    const a = b.uiTokenAmount?.amount;
    if (typeof a !== 'string' || !/^\d+$/.test(a)) throw new Error('amount');
    return BigInt(a);
  };
  try {
    let sawVault = false;
    let total = 0n;
    for (const b of post) {
      if (!b || b.mint !== m58) continue;
      const k = keys[b.accountIndex];
      if (!k) return null;
      if (k.equals(vault)) {
        sawVault = true;
        continue;
      }
      const before = pre.find((x) => x && x.mint === m58 && x.accountIndex === b.accountIndex);
      const delta = amount(b) - (before ? amount(before) : 0n);
      if (delta > 0n) total += delta;
    }
    return sawVault ? total : null;
  } catch {
    return null;
  }
}

async function fetchTx(rpc: SolanaRpc, signature: string): Promise<unknown> {
  return rpc('getTransaction', [
    signature,
    { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
}

interface RawAccount {
  data?: [string, string] | unknown;
  owner?: string;
  lamports?: number;
}

/** `getMultipleAccounts` → per key: account | null, or throws on a malformed answer. */
async function multipleAccounts(rpc: SolanaRpc, keys: PublicKey[]): Promise<Array<{ data: Uint8Array; owner: PublicKey; lamports: bigint } | null>> {
  if (keys.length === 0) return [];
  const r = await rpc('getMultipleAccounts', [keys.map((k) => k.toBase58()), { encoding: 'base64', commitment: 'confirmed' }]);
  if (!r || typeof r !== 'object' || !Array.isArray((r as { value?: unknown }).value)) {
    throw new Error('getMultipleAccounts: the response carried no value list');
  }
  const list = (r as { value: unknown[] }).value;
  if (list.length !== keys.length) throw new Error('getMultipleAccounts: wrong number of accounts');
  return list.map((v) => {
    if (v === null || v === undefined) return null;
    const a = v as RawAccount;
    const d = Array.isArray(a.data) ? a.data[0] : undefined;
    if (typeof d !== 'string' || typeof a.owner !== 'string' || typeof a.lamports !== 'number') {
      throw new Error('getMultipleAccounts: an account is malformed');
    }
    return { data: Uint8Array.from(Buffer.from(d, 'base64')), owner: new PublicKey(a.owner), lamports: BigInt(a.lamports) };
  });
}

/** Curves and metadata for a set of launches, two calls in total. */
async function enrich(rpc: SolanaRpc, cfg: CurveWriteConfig, origins: LaunchOrigin[]): Promise<LaunchListItem[]> {
  const curveKeys = origins.map((o) => curvePda(o.mint, cfg.programId));
  const metaKeys = origins.map((o) => metadataPda(o.mint));
  let curves: Awaited<ReturnType<typeof multipleAccounts>> | null = null;
  let metas: Awaited<ReturnType<typeof multipleAccounts>> | null = null;
  let curveErr = '';
  let metaErr = '';
  try {
    curves = await multipleAccounts(rpc, curveKeys);
  } catch (e) {
    curveErr = clipDetail(e);
  }
  try {
    metas = await multipleAccounts(rpc, metaKeys);
  } catch (e) {
    metaErr = clipDetail(e);
  }
  return origins.map((o, i): LaunchListItem => {
    let curve: Read<CurveAccount>;
    if (!curves) curve = { kind: 'unreadable', detail: curveErr };
    else {
      const a = curves[i];
      if (!a) curve = { kind: 'absent' };
      else if (!a.owner.equals(cfg.programId)) curve = { kind: 'undecodable', reason: 'wrong-discriminator' };
      else {
        const d = decodeBondingCurve(a.data);
        if (!d.ok) curve = { kind: 'undecodable', reason: d.reason };
        else if (!d.value.mint.equals(o.mint) || !d.value.creator.equals(o.creator)) {
          curve = { kind: 'undecodable', reason: 'malformed' };
        } else curve = { kind: 'ok', value: { address: curveKeys[i]!, curve: d.value, lamports: a.lamports } };
      }
    }
    let metadata: Read<TokenMetadata>;
    if (!metas) metadata = { kind: 'unreadable', detail: metaErr };
    else {
      const a = metas[i];
      if (!a) metadata = { kind: 'absent' };
      else if (!a.owner.equals(METAPLEX_TOKEN_METADATA_ID)) {
        metadata = { kind: 'undecodable', reason: 'wrong-discriminator' };
      } else {
        const d = decodeTokenMetadata(a.data, o.mint, metaKeys[i]);
        metadata = d.ok ? { kind: 'ok', value: d.value } : { kind: 'undecodable', reason: d.reason };
      }
    }
    return {
      mint: o.mint,
      creator: o.creator,
      signature: o.signature,
      blockTime: o.blockTime,
      openingBuyTokens: o.openingBuyTokens,
      curve,
      metadata,
    };
  });
}

/**
 * Walk `address`'s signatures newest first, keep successful top-level
 * `create_launch` transactions that pass `keep`, up to `limit`.
 */
async function scan(
  rpc: SolanaRpc,
  cfg: CurveWriteConfig,
  address: PublicKey,
  opts: { limit?: number; before?: string; maxPages?: number },
  keep: (o: LaunchOrigin) => boolean,
): Promise<Read<LaunchListPage>> {
  const limit = Math.max(1, Math.min(opts.limit ?? LIST_PAGE_SIZE, LIST_PAGE_SIZE));
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? LIST_MAX_PAGES, LIST_MAX_PAGES));
  const origins: LaunchOrigin[] = [];
  const seen = new Set<string>();
  let before = opts.before;
  let scanned = 0;
  let hidden = 0;
  let exhausted = false;

  try {
    for (let page = 0; page < maxPages && origins.length < limit; page++) {
      const sigs = asSigInfos(
        await rpc('getSignaturesForAddress', [
          address.toBase58(),
          { limit: LIST_PAGE_SIZE, commitment: 'confirmed', ...(before ? { before } : {}) },
        ]),
      );
      if (sigs.length === 0) {
        exhausted = true;
        break;
      }
      scanned += sigs.length;
      before = sigs[sigs.length - 1]!.signature;
      const ok = sigs.filter((s) => s.err === null || s.err === undefined);
      const txs = await Promise.all(ok.map((s) => fetchTx(rpc, s.signature)));
      for (let i = 0; i < ok.length && origins.length < limit; i++) {
        const o = parseLaunchTransaction(txs[i], ok[i]!.signature, cfg.programId);
        if (!o || !keep(o) || seen.has(o.mint.toBase58())) continue;
        seen.add(o.mint.toBase58());
        if (HIDDEN_MINTS.has(o.mint.toBase58())) {
          hidden++;
          continue;
        }
        origins.push(o);
      }
      if (sigs.length < LIST_PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }

  const items = await enrich(rpc, cfg, origins);
  return { kind: 'ok', value: { items, before: exhausted ? null : (before ?? null), scanned, hidden } };
}

/** Launches whose create transaction mentions the index address. See the header for what that does NOT prove. */
export function listRecentLaunches(
  rpc: SolanaRpc,
  cfg: CurveWriteConfig,
  opts: { limit?: number; before?: string; maxPages?: number } = {},
): Promise<Read<LaunchListPage>> {
  return scan(rpc, cfg, launchIndexAddress(cfg.programId), opts, () => true);
}

/** Launches the given wallet created, from that wallet's own recent transactions. */
export function listLaunchesByCreator(
  rpc: SolanaRpc,
  cfg: CurveWriteConfig,
  creator: PublicKey,
  opts: { limit?: number; before?: string; maxPages?: number } = {},
): Promise<Read<LaunchListPage>> {
  return scan(rpc, cfg, creator, opts, (o) => o.creator.equals(creator));
}

/**
 * The transaction that created a launch, found from the chain.
 *
 * First through the token details account, which only the launch transaction
 * normally touches; then through the curve account's oldest signature (only when
 * its whole history fits in one page, so "oldest" is really oldest).
 */
export async function readLaunchOrigin(rpc: SolanaRpc, cfg: CurveWriteConfig, mint: PublicKey): Promise<Read<LaunchOrigin>> {
  const tryAddress = async (address: PublicKey, limit: number): Promise<Read<LaunchOrigin> | null> => {
    const sigs = asSigInfos(await rpc('getSignaturesForAddress', [address.toBase58(), { limit, commitment: 'confirmed' }]));
    if (sigs.length === 0) return null;
    if (sigs.length >= limit) return { kind: 'unreadable', detail: 'this launch has too much history to find its first transaction' };
    // Oldest first: the launch transaction is the earliest successful one.
    for (let i = sigs.length - 1; i >= 0; i--) {
      const s = sigs[i]!;
      if (s.err !== null && s.err !== undefined) continue;
      const o = parseLaunchTransaction(await fetchTx(rpc, s.signature), s.signature, cfg.programId, mint);
      if (o) return { kind: 'ok', value: o };
    }
    return null;
  };
  try {
    const viaMeta = await tryAddress(metadataPda(mint), 20);
    if (viaMeta) return viaMeta;
    const viaCurve = await tryAddress(curvePda(mint, cfg.programId), 1000);
    if (viaCurve) return viaCurve;
    return { kind: 'absent' };
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
}

/** What the creator holds NOW in their main token account for this mint. Absent account = holds 0 there. */
export async function readCreatorHolding(
  rpc: CurveRpc,
  mint: PublicKey,
  creator: PublicKey,
): Promise<Read<{ amount: bigint; accountExists: boolean }>> {
  try {
    const a = await rpc.getAccountInfo(associatedTokenAddress(mint, creator));
    if (!a) return { kind: 'ok', value: { amount: 0n, accountExists: false } };
    if (a.data.length < 72) return { kind: 'undecodable', reason: 'bad-length' };
    const amount = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
    return { kind: 'ok', value: { amount, accountExists: true } };
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
}

/** `part / whole` in bps, or null when there is no whole. For "creator holds X%". */
export function shareBps(part: bigint, whole: bigint): bigint | null {
  if (whole <= 0n || part < 0n) return null;
  return (part * 10_000n) / whole;
}

/**
 * FULLY DILUTED value in lamports: spot price × total supply. Label it that way. It
 * counts every token, including the platform reserve and the tokens still unsold on
 * the curve, so it is NOT money anyone has put in. `null` when there is no price.
 */
export function fullyDilutedValueLamports(c: BondingCurve, tokenTotalSupply: bigint): bigint | null {
  const eff = effectiveReserves(c);
  if (!eff.ok || eff.value.tokens === 0n) return null;
  return (eff.value.sol * tokenTotalSupply) / eff.value.tokens;
}
