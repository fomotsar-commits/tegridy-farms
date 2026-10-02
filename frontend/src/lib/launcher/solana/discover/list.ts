// Finding launches, from the chain only: no database, no program-wide scan.
// `getProgramAccounts` is not allowed through our RPC proxy (an unbounded scan), so
// launches cannot be enumerated. Instead this site's create transaction mentions a
// fixed address (`launchIndexAddress`), and `getSignaturesForAddress` on it returns
// those transactions, newest first.

// ⚠ ANYONE CAN MENTION THAT ADDRESS: the launch program ignores extra accounts, so a
// launch made anywhere can appear here, and cheap transactions that merely mention it
// can push real launches down the list. So a page must say that anyone can appear in
// this list and that it cannot tell which makers came through the gate (LaunchList.tsx
// holds the words), never "launches made on this site".

// Every item is re-checked: only a SUCCESSFUL transaction whose TOP-LEVEL instruction
// is `create_launch` on the configured program counts, and its curve must exist, be
// owned by that program and name the same creator. Paging stops after a fixed number of
// pages and the result says how many entries were looked at, so an empty list reads
// "none in the latest N", never "no launches". `HIDDEN_MINTS` lists mints never shown.

// Every row also carries what was bought in the launch transaction itself, by ANY
// wallet and per wallet, the supply at birth, and the $BAYLA plant: a creator can buy
// most of the curve at the opening price in the same transaction and sell into later
// buyers. All of it is read from the transaction's token balances, never from which
// instructions we recognise. "Could not read" is kept apart from 0.

import { Buffer } from 'buffer';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  IX_DISCRIMINATOR,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  curvePda,
  curveVaultPda,
  decodeBondingCurve,
  type BondingCurve,
} from '../curve/program';
import { effectiveReserves } from '../curve/math';
import { clipDetail, type CurveAccount, type CurveRpc, type Read } from '../curve/read';
import type { SolanaRpc } from '../curve/rpc';
import { associatedTokenAddress } from '../curve/ix';
import { launchIndexAddress } from '../write/config';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../write/metaplex';
import { BAYLA_MINT, WORKSHOP_BAYLA_ACCOUNT } from '../write/plant';
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
  /**
   * The same tokens, per OWNER wallet (accounts with nothing new are left out), so the
   * maker's own create-buy can be told from other wallets'. `null` = could not read:
   * the balances are missing or do not add up, or one of them names no owner.
   */
  boughtByOwner: ReadonlyArray<{ owner: PublicKey; tokens: bigint }> | null;
  /**
   * The whole supply at birth: the sum of the mint's balances after this transaction,
   * the curve vault included (create_launch mints the supply in it). A share of today's
   * supply would grow with every later burn. `null` = could not read.
   */
  birthSupply: bigint | null;
  /**
   * The $BAYLA this transaction burned (before minus after, over every $BAYLA balance in
   * it) and sent to the island's Workshop account. `null` = could not read, including a
   * $BAYLA balance not under Token-2022 or more $BAYLA after than before.
   */
  plant: { burned: bigint; toWorkshop: bigint } | null;
  /**
   * Who received the platform reserve: the fee recipient named in this launch's own
   * `create_launch` (account 8, which the program pins to `global.fee_recipient` as it
   * was then). The config can be changed later, so this, not today's config, is who
   * was paid. `null` when the instruction does not carry it.
   */
  reserveRecipient: PublicKey | null;
}

export interface LaunchListItem {
  mint: PublicKey;
  creator: PublicKey;
  signature: string;
  blockTime: number | null;
  openingBuyTokens: bigint | null;
  boughtByOwner: LaunchOrigin['boughtByOwner'];
  birthSupply: bigint | null;
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
  /** The token program that owns the account. */
  programId?: string;
  uiTokenAmount?: { amount?: string };
}

interface RawTx {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
    /** Calls each top-level instruction made, as the RPC reports them (`data` in base58). */
    innerInstructions?: Array<{
      index: number;
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    }> | null;
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
  let treasuryToken: PublicKey | null = null;
  let reserveRecipient: PublicKey | null = null;
  let createIndex = -1;
  for (const [index, ix] of msg.compiledInstructions.entries()) {
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
      createIndex = index;
      // create_launch pays the platform reserve to the treasury's token account
      // (position 9 of 11) in this same instruction, and that account belongs to the
      // fee recipient at position 8. The reserve is not a buy.
      if (ix.accountKeyIndexes.length >= 11) {
        reserveRecipient = acct(8);
        treasuryToken = acct(9);
      }
      continue;
    }
  }
  if (!creator || !mint) return null;

  const vault = curveVaultPda(mint, programId);
  const reserve = treasuryToken ? reservePaid(t.meta, keys, createIndex, vault, treasuryToken) : 0n;
  const gains = gainedInLaunch(t.meta, keys, mint, vault, treasuryToken, reserve);
  const birthSupply = supplyAtBirth(t.meta, keys, mint, vault);
  return {
    signature,
    blockTime: typeof t.blockTime === 'number' ? t.blockTime : null,
    creator,
    mint,
    openingBuyTokens: gains ? gains.reduce((sum, g) => sum + g.gained, 0n) : null,
    boughtByOwner: byOwner(gains),
    birthSupply,
    // The birth supply needs the curve vault's balance, which every create reports: no
    // supply means an incomplete record, and the plant is not read from one either.
    plant: birthSupply === null ? null : plantMoved(t.meta, keys),
    reserveRecipient,
  };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 to bytes, or `null` for a character outside the alphabet. */
export function fromBase58(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const v = BASE58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    out.push(0);
  }
  return Uint8Array.from(out.reverse());
}

/** SPL Token `Transfer` (instruction 3): tag byte, then the amount as a little-endian u64. */
const TOKEN_TRANSFER = 3;

/** The platform reserve this launch paid, read from create_launch's own call to the
 *  token program: the transfer from the curve vault to the treasury's token account.
 *  Only calls made BY our create_launch are looked at, so nothing else in the
 *  transaction can pose as it. `0n` when create_launch made no such transfer (the
 *  program skips it for a zero reserve); `null` when the RPC did not report the calls. */
function reservePaid(
  meta: NonNullable<RawTx['meta']>,
  keys: PublicKey[],
  createIndex: number,
  vault: PublicKey,
  treasuryToken: PublicKey,
): bigint | null {
  if (!Array.isArray(meta.innerInstructions)) return null;
  // create_launch always calls the token program (it mints the supply), so a
  // missing entry means the record is incomplete, not that nothing was paid.
  const own = meta.innerInstructions.find((x) => x && x.index === createIndex);
  if (!own || !Array.isArray(own.instructions)) return null;
  let paid = 0n;
  for (const ix of own.instructions) {
    if (!ix || !keys[ix.programIdIndex]?.equals(TOKEN_PROGRAM_ID) || !Array.isArray(ix.accounts)) continue;
    const data = typeof ix.data === 'string' ? fromBase58(ix.data) : null;
    if (!data) return null;
    if (data.length !== 9 || data[0] !== TOKEN_TRANSFER) continue;
    const from = keys[ix.accounts[0] ?? -1];
    const to = keys[ix.accounts[1] ?? -1];
    if (!from || !to || !from.equals(vault) || !to.equals(treasuryToken)) continue;
    paid += new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
  }
  return paid;
}

/** A balance's amount in base units; throws on anything but a plain integer. */
function rawAmount(b: TokenBalance): bigint {
  const a = b.uiTokenAmount?.amount;
  if (typeof a !== 'string' || !/^\d+$/.test(a)) throw new Error('amount');
  return BigInt(a);
}

/** What each account of `mint` but the curve's own vault gained in this transaction, less
 *  the platform reserve (`reserve`, paid inside create_launch, not a buy) on the treasury's
 *  token account, which also holds a buy when the treasury's own wallet launches and buys.
 *  `null` when the balances are missing, when the curve vault is not among them
 *  (create_launch always fills it, so the record is incomplete), when an amount does not
 *  parse, or when the reserve could not be read. */
function gainedInLaunch(
  meta: NonNullable<RawTx['meta']>,
  keys: PublicKey[],
  mint: PublicKey,
  vault: PublicKey,
  treasuryToken: PublicKey | null,
  reserve: bigint | null,
): Array<{ owner: string | undefined; gained: bigint }> | null {
  const post = meta.postTokenBalances;
  const pre = meta.preTokenBalances;
  if (!Array.isArray(post) || !Array.isArray(pre)) return null;
  const m58 = mint.toBase58();
  try {
    let sawVault = false;
    const out: Array<{ owner: string | undefined; gained: bigint }> = [];
    for (const b of post) {
      if (!b || b.mint !== m58) continue;
      const k = keys[b.accountIndex];
      if (!k) return null;
      if (k.equals(vault)) {
        sawVault = true;
        continue;
      }
      const before = pre.find((x) => x && x.mint === m58 && x.accountIndex === b.accountIndex);
      let delta = rawAmount(b) - (before ? rawAmount(before) : 0n);
      if (treasuryToken && k.equals(treasuryToken)) {
        if (reserve === null) return null;
        delta -= reserve;
        // Less than the reserve arrived: the record does not add up.
        if (delta < 0n) return null;
      }
      out.push({ owner: b.owner, gained: delta > 0n ? delta : 0n });
    }
    return sawVault ? out : null;
  } catch {
    return null;
  }
}

/** The gains grouped by the wallet that owns each account. A balance with no owner, or an
 *  owner that is not an address, makes the whole read `null`: never a guess at whose it was. */
function byOwner(gains: Array<{ owner: string | undefined; gained: bigint }> | null): LaunchOrigin['boughtByOwner'] {
  if (!gains) return null;
  const totals = new Map<string, bigint>();
  for (const g of gains) {
    if (typeof g.owner !== 'string') return null;
    if (g.gained > 0n) totals.set(g.owner, (totals.get(g.owner) ?? 0n) + g.gained);
  }
  try {
    return [...totals].map(([owner, tokens]) => ({ owner: new PublicKey(owner), tokens }));
  } catch {
    return null;
  }
}

/** The sum of `mint`'s balances after this transaction, the curve vault included. `null`
 *  when the balances are missing, the vault is not among them, or an amount does not parse. */
function supplyAtBirth(meta: NonNullable<RawTx['meta']>, keys: PublicKey[], mint: PublicKey, vault: PublicKey): bigint | null {
  const post = meta.postTokenBalances;
  if (!Array.isArray(post)) return null;
  const m58 = mint.toBase58();
  try {
    let sawVault = false;
    let total = 0n;
    for (const b of post) {
      if (!b || b.mint !== m58) continue;
      const k = keys[b.accountIndex];
      if (!k) return null;
      if (k.equals(vault)) sawVault = true;
      total += rawAmount(b);
    }
    return sawVault && total > 0n ? total : null;
  } catch {
    return null;
  }
}

/** The plant, read from the balances. $BAYLA has no transfer fee, so it leaves a
 *  transaction's accounts only by a burn: burned = before minus after over every $BAYLA
 *  balance. The Workshop's account is the constant Token-2022 one, never a legacy-Token
 *  derivation. A $BAYLA balance not under Token-2022, or less before than after, is `null`. */
function plantMoved(meta: NonNullable<RawTx['meta']>, keys: PublicKey[]): LaunchOrigin['plant'] {
  const post = meta.postTokenBalances;
  const pre = meta.preTokenBalances;
  if (!Array.isArray(post) || !Array.isArray(pre)) return null;
  const bayla = BAYLA_MINT.toBase58();
  const token2022 = TOKEN_2022_PROGRAM_ID.toBase58();
  const sum = (list: TokenBalance[]) => {
    let total = 0n;
    let workshop = 0n;
    for (const b of list) {
      if (!b || b.mint !== bayla) continue;
      if (b.programId !== token2022) throw new Error('not a Token-2022 balance');
      const k = keys[b.accountIndex];
      if (!k) throw new Error('account');
      const a = rawAmount(b);
      total += a;
      if (k.equals(WORKSHOP_BAYLA_ACCOUNT)) workshop += a;
    }
    return { total, workshop };
  };
  try {
    const before = sum(pre);
    const after = sum(post);
    const burned = before.total - after.total;
    if (burned < 0n) return null;
    return { burned, toWorkshop: after.workshop - before.workshop };
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
      boughtByOwner: o.boughtByOwner,
      birthSupply: o.birthSupply,
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
      const ok = sigs.filter((s) => s.err === null || s.err === undefined);
      const txs = await Promise.all(ok.map((s) => fetchTx(rpc, s.signature)));
      const txOf = new Map(ok.map((s, i) => [s.signature, txs[i]] as const));
      // The cursor moves one entry at a time, and only past entries actually looked
      // at. Once the list is full, the rest of this page is left for the next load:
      // jumping to the page's end would skip those launches for good.
      let full = false;
      for (const s of sigs) {
        if (origins.length >= limit) {
          full = true;
          break;
        }
        scanned++;
        before = s.signature;
        if (!txOf.has(s.signature)) continue;
        const o = parseLaunchTransaction(txOf.get(s.signature), s.signature, cfg.programId);
        if (!o || !keep(o) || seen.has(o.mint.toBase58())) continue;
        seen.add(o.mint.toBase58());
        if (HIDDEN_MINTS.has(o.mint.toBase58())) {
          hidden++;
          continue;
        }
        origins.push(o);
      }
      if (full) break;
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

/** The transaction that created a launch, found from the chain: first through the token
 *  details account, which only the launch transaction normally touches; then through the
 *  curve account's oldest signature (only when its whole history fits in one page, so
 *  "oldest" is really oldest). Anyone can mention the details account cheaply, so too much
 *  history there moves on to the curve; only when both fail is it "could not read". */
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
    if (viaMeta?.kind === 'ok') return viaMeta;
    const viaCurve = await tryAddress(curvePda(mint, cfg.programId), 1000);
    if (viaCurve) return viaCurve;
    return viaMeta ?? { kind: 'absent' };
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
