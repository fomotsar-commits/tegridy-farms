import { ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { decodeRpcAccount, type RawAccount } from '../lp/accounts';
import { SOL_QUOTE } from '../lp/quotes';
import type { KeeperIo } from './cycle';
import { tripFeeLamports } from './rule';

/**
 * Plain SOL for the robot's own costs. Fees, Jito tips and new accounts' rent are paid in plain
 * SOL while every trip's gain lands wrapped, so plain SOL only falls. Under `belowLamports`, one
 * transaction from the robot to itself moves `amountLamports` back: it closes the wrapped-SOL
 * account (all of it comes back plain), opens it again and wraps back all but the amount. The
 * same instructions as the `withdraw` (close) and `wrap` (open, send, sync) commands.
 */

/** Plain SOL is read for a top-up at most this often. */
export const TOP_UP_EVERY_MS = 60_000;
/** The compute a top-up is test-run with. It is sent with what the test run used and a fifth more. */
const SIM_UNITS = 200_000;
/** The most a top-up may cost in all, fee and any rent change (its fee is about 6,000 lamports). */
export const TOP_UP_MOST_COST = 50_000n;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface TopUpSettings {
  /** Plain SOL under this starts a top-up; 0: never (KEEPER_TOPUP_BELOW_SOL). */
  belowLamports: bigint;
  /** Wrapped SOL moved back to plain each time (KEEPER_TOPUP_SOL). */
  amountLamports: bigint;
  /** The most moved back in a UTC day, all top-ups together (KEEPER_MAX_DAILY_SOL). */
  dayLamports: bigint;
  microLamports: number;
}

/** The robot's plain SOL, and its wrapped SOL (null: no wrapped-SOL account) with that account's lamports. */
export interface Held {
  plain: bigint;
  wrapped: bigint | null;
  wrappedLamports: bigint;
}

export type TopUpResult =
  | { kind: 'enough'; plain: bigint }
  | { kind: 'skipped'; why: string }
  | { kind: 'refused'; why: string }
  | { kind: 'tested'; move: bigint }
  | { kind: 'sent'; move: bigint; moved: bigint; outcome: string; signature: string };

const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;

/** What a top-up would move now: null when plain SOL is not low (or top-ups are off), else the amount or why not. */
export function topUpNeed(held: Held, s: TopUpSettings, movedToday: bigint): { move: bigint } | { skip: string } | null {
  if (s.belowLamports <= 0n || held.plain >= s.belowLamports) return null;
  if (held.wrapped === null) return { skip: 'the robot holds no wrapped SOL to move: send it plain SOL' };
  if (held.wrapped <= s.amountLamports) return { skip: `the robot holds ${sol(held.wrapped)} wrapped, not more than the ${sol(s.amountLamports)} a top-up moves: send it plain SOL` };
  if (movedToday + s.amountLamports > s.dayLamports) return { skip: `${sol(movedToday)} moved to plain today; one more top-up would pass the day's ${sol(s.dayLamports)}: until tomorrow (UTC)` };
  return { move: s.amountLamports };
}

/** The top-up: close the wrapped-SOL account to the robot, open it again, wrap back `wrapped - move`. */
export function topUpInstructions(owner: PublicKey, wrapped: bigint, move: bigint, microLamports: number, units: number): TransactionInstruction[] {
  if (move <= 0n || move >= wrapped) throw new Error('a top-up moves some of the wrapped SOL, never none or all of it');
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    createCloseAccountInstruction(ata, owner, owner),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: wrapped - move }),
    createSyncNativeInstruction(ata),
  ];
}

/** Why a test run's result must not be sent, or null: the wrapped SOL falls by the amount at most, and plain SOL rises by it less the fee. */
export function topUpProblem(before: Held, after: Held, move: bigint): string | null {
  if (before.wrapped === null) return 'there was no wrapped SOL';
  if (after.wrapped === null) return 'it would leave the wrapped-SOL account closed';
  if (after.wrapped + move < before.wrapped) return 'it would take more than the top-up out of the wrapped SOL';
  if (after.plain + TOP_UP_MOST_COST < before.plain + move) return 'plain SOL would not rise by the top-up';
  if (after.plain + after.wrappedLamports + TOP_UP_MOST_COST < before.plain + before.wrappedLamports) return 'it would cost more than a fee';
  return null;
}

function heldOf(o: RawAccount | null, w: RawAccount | null): Held {
  if (w && (w.owner !== TOKEN_PROGRAM || w.data.length < 72)) throw new Error('the robot’s wrapped-SOL address holds something other than a token account');
  const wrapped = w ? new DataView(w.data.buffer, w.data.byteOffset, w.data.byteLength).getBigUint64(64, true) : null;
  return { plain: BigInt(o?.lamports ?? 0), wrapped, wrappedLamports: BigInt(w?.lamports ?? 0) };
}

/** Read at 'confirmed', the commitment the test run uses. */
async function readHeld(rpc: SolanaRpc, addresses: string[]): Promise<Held> {
  const r = (await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])) as { value?: unknown[] };
  if (!Array.isArray(r?.value) || r.value.length !== addresses.length) throw new Error('the robot’s SOL was not read');
  const [o, w] = r.value.map((v, i) => (v === null ? null : decodeRpcAccount('getMultipleAccounts', addresses[i]!, v)));
  return heldOf(o ?? null, w ?? null);
}

/**
 * Read plain SOL and, when it is low, test-run a top-up; live (`io.send`), send it, read back what
 * it cost and log it in the earnings log as kind 'top-up'. `movedToday`: wrapped SOL moved back
 * to plain this UTC day so far. A send `io.send` refuses (the stop file, the day's cap) throws.
 */
export async function topUp(io: Pick<KeeperIo, 'rpc' | 'owner' | 'send' | 'record' | 'log'>, s: TopUpSettings, movedToday: bigint): Promise<TopUpResult> {
  const owner = io.owner;
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
  const addresses = [owner.toBase58(), ata.toBase58()];
  const before = await readHeld(io.rpc, addresses);
  const need = topUpNeed(before, s, movedToday);
  if (need === null) return { kind: 'enough', plain: before.plain };
  if ('skip' in need) return { kind: 'skipped', why: need.skip };
  const wrapped = before.wrapped!;
  const build = async (units: number) => {
    const { blockhash } = ((await io.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])) as { value: { blockhash: string } }).value;
    const instructions = topUpInstructions(owner, wrapped, need.move, s.microLamports, units);
    return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message());
  };

  const sim = (await io.rpc('simulateTransaction', [
    Buffer.from((await build(SIM_UNITS)).serialize()).toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } },
  ])) as { value: { err: unknown; logs?: string[] | null; unitsConsumed?: number; accounts?: (unknown | null)[] | null } };
  if (sim.value.err) {
    const last = sim.value.logs?.at(-1);
    return { kind: 'refused', why: `test run refused (${JSON.stringify(sim.value.err)})${last ? `: ${last}` : ''}` };
  }
  // An account the answer leaves out reads as empty, which the check then refuses.
  const got = sim.value.accounts ?? [];
  const after = heldOf(got[0] ? decodeRpcAccount('simulateTransaction', addresses[0]!, got[0]) : null, got[1] ? decodeRpcAccount('simulateTransaction', addresses[1]!, got[1]) : null);
  const problem = topUpProblem(before, after, need.move);
  if (problem) return { kind: 'refused', why: `test run not sent, ${problem}` };
  if (!io.send) return { kind: 'tested', move: need.move };

  const units = Math.ceil((sim.value.unitsConsumed ?? SIM_UNITS) * 1.2) + 10_000;
  const r = await io.send(await build(units));
  io.log(`Plain SOL ${sol(before.plain)}, under ${sol(s.belowLamports)}: moved ${sol(need.move)} of the wrapped SOL to plain, sent ${r.signature}: ${r.outcome}`);
  // Unknown or unread: counted as its fee. Read back: what the robot's SOL, wrapped and plain, fell by.
  let spent = BigInt(tripFeeLamports(s.microLamports, units));
  if (r.outcome !== 'unknown') {
    try {
      const now = await readHeld(io.rpc, addresses);
      const fell = before.plain + before.wrappedLamports - (now.plain + now.wrappedLamports);
      spent = fell < 0n ? 0n : fell > TOP_UP_MOST_COST ? TOP_UP_MOST_COST : fell;
    } catch {
      // the fee stands
    }
  }
  try {
    io.record?.({ at: new Date().toISOString(), kind: 'top-up', pool: ata.toBase58(), name: 'plain SOL top-up', coin: SOL_QUOTE, coinIn: need.move, gained: 0n, lamportsSpent: spent, signature: r.signature, outcome: r.outcome });
  } catch (e) {
    io.log(`The top-up went out but was not logged: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A refused one moved nothing; an unknown one counts as moved, towards the day's most.
  return { kind: 'sent', move: need.move, moved: r.outcome === 'reverted' ? 0n : need.move, outcome: r.outcome, signature: r.signature };
}
