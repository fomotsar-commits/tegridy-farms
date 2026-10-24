// The plant (island ruling 2, 2026-10-01): every launch made here pays 100,000 $BAYLA
// in its own create transaction, 50,000 burned and 50,000 to the island's Workshop.
// $BAYLA is a Token-2022 mint (6 decimals, no transfer fee, no hook, no freeze), so the
// plant is two plain Token-2022 instructions the maker signs, after create_launch.
// The launch program never sees $BAYLA: like the heat door, only this site carries it.

import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { createBurnCheckedInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { BAYLA_MINT as BAYLA_MINT_ADDRESS } from '../../../bungalows';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../curve/program';
import { clipDetail, type Read } from '../curve/read';
import type { WriteRpc } from './types';

/** $BAYLA, a Token-2022 mint. */
export const BAYLA_MINT = new PublicKey(BAYLA_MINT_ADDRESS);
export const BAYLA_DECIMALS = 6;

/** The island's Workshop: the wallet that created $BAYLA (the island's receipts name it). */
export const WORKSHOP_WALLET = new PublicKey('G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu');
/** Its $BAYLA account (the Token-2022 associated account). It exists, so the plant creates nothing. */
export const WORKSHOP_BAYLA_ACCOUNT = new PublicKey('9i7vMCBcTSs3CsEZNcNDmH5Lh8yuH6aqYULNHWfxatwT');

/** 100,000 $BAYLA, in base units. */
export const PLANT_TOTAL_RAW = 100_000_000_000n;
/** Half burned... */
export const PLANT_BURN_RAW = 50_000_000_000n;
/** ...and half to the Workshop. */
export const PLANT_WORKSHOP_RAW = 50_000_000_000n;

/** Token-2022 instruction tags (the same numbers as the legacy program's). */
export const TOKEN_IX_TRANSFER_CHECKED = 12;
export const TOKEN_IX_BURN_CHECKED = 15;

/**
 * An owner's $BAYLA account: the associated account under TOKEN-2022. Never
 * `curve/ix.ts associatedTokenAddress`, which derives under the legacy program and,
 * for $BAYLA, names an account that does not exist.
 */
export function baylaAccountOf(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_2022_PROGRAM_ID.toBytes(), BAYLA_MINT.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** The plant, in order: burn 50,000 from the maker's $BAYLA account, then send 50,000 to the Workshop. */
export function plantInstructions(maker: PublicKey): [TransactionInstruction, TransactionInstruction] {
  const from = baylaAccountOf(maker);
  return [
    createBurnCheckedInstruction(from, BAYLA_MINT, maker, PLANT_BURN_RAW, BAYLA_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(
      from,
      BAYLA_MINT,
      WORKSHOP_BAYLA_ACCOUNT,
      maker,
      PLANT_WORKSHOP_RAW,
      BAYLA_DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
}

const TOKEN_ACCOUNT_BASE = 165;
const ACCOUNT_TYPE_ACCOUNT = 2;
const STATE_INITIALIZED = 1;

/**
 * The amount in a Token-2022 $BAYLA account owned by `owner`, or null when the
 * account is anything else. The base layout is the legacy one (mint 0, owner 32,
 * amount 64, state 108); an account with extensions has its type at byte 165, where
 * 2 is a token account and 1 would be a mint.
 */
function baylaAmount(info: { owner: PublicKey; data: Uint8Array }, owner: PublicKey): bigint | null {
  const d = info.data;
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID) || d.length < TOKEN_ACCOUNT_BASE) return null;
  if (d.length > TOKEN_ACCOUNT_BASE && d[TOKEN_ACCOUNT_BASE] !== ACCOUNT_TYPE_ACCOUNT) return null;
  if (!new PublicKey(d.subarray(0, 32)).equals(BAYLA_MINT) || !new PublicKey(d.subarray(32, 64)).equals(owner)) return null;
  if (d[108] !== STATE_INITIALIZED) return null;
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true);
}

export interface PlantBalance {
  /** The maker's $BAYLA account, which the plant spends from. */
  account: PublicKey;
  /** What it holds, in base units. 0 when it does not exist. */
  amount: bigint;
  accountExists: boolean;
}

/**
 * What the maker's own $BAYLA account holds now. Only that account: the plant spends
 * from it, so $BAYLA held in any other account does not count. A failed read is
 * `unreadable`, never 0.
 */
export async function readPlantBalance(rpc: Pick<WriteRpc, 'getAccountInfo'>, owner: PublicKey): Promise<Read<PlantBalance>> {
  const account = baylaAccountOf(owner);
  try {
    const info = await rpc.getAccountInfo(account, 'confirmed');
    if (!info) return { kind: 'ok', value: { account, amount: 0n, accountExists: false } };
    const amount = baylaAmount(info, owner);
    if (amount === null) return { kind: 'undecodable', reason: 'malformed' };
    return { kind: 'ok', value: { account, amount, accountExists: true } };
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
}

/** The Workshop's $BAYLA account, checked to be exactly that: Token-2022, $BAYLA, owned by the Workshop. */
export async function readWorkshopAccount(rpc: Pick<WriteRpc, 'getAccountInfo'>): Promise<Read<{ amount: bigint }>> {
  try {
    const info = await rpc.getAccountInfo(WORKSHOP_BAYLA_ACCOUNT, 'confirmed');
    if (!info) return { kind: 'absent' };
    const amount = baylaAmount(info, WORKSHOP_WALLET);
    if (amount === null) return { kind: 'undecodable', reason: 'malformed' };
    return { kind: 'ok', value: { amount } };
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
}
