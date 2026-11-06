// @vitest-environment node
//
// The send step with KEEPER_JITO: which trips go to Jito, the tip they carry and the floor it
// raises, and how a confirmed trip and a lost race are counted. The chain is made up here; the
// step itself (test run, verdict, build, send, read-back) runs as it does live.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, type VersionedTransaction } from '@solana/web3.js';
import { SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../lp/quotes';
import { DEFAULT_SETTINGS, sendChecked, type KeeperIo, type Trip, type TripRecord } from './cycle';
import { DEFAULT_LIMITS } from './plan';
import { floorOfCheck } from './lighthouse';
import { JITO_KEEP_LAMPORTS, JITO_TIP_ACCOUNTS } from './jito';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
const key = () => Keypair.generate().publicKey;
const token = (amount: bigint) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
};
const wallet = (lamports: bigint) => ({ data: ['', 'base64'], owner: SYSTEM, lamports: Number(lamports), executable: false, rentEpoch: 0 });

const HELD = 1_000_000_000n; // the coin account before the trip
const GAIN = 1_000_000n; // what the test run shows it gain
const FLOOR = 100_000n;
const LAMPORTS = 50_000_000n;

/** A trip in `coin`, on a chain whose test run gains GAIN and whose read-back after the send says `after`. */
function rig(coin: QuoteCoin, after: { coin: bigint; lamports: bigint }, solAfterTest = LAMPORTS) {
  const owner = key();
  const accounts = { coinAta: key(), tokenAta: key(), otherAta: key(), tokenMint: key(), tokenProgram: new PublicKey(TOKEN_PROGRAM), coinMint: new PublicKey(coin.mint) };
  let balanceReads = 0;
  const rpc = vi.fn(async (method: string) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: key().toBase58() } };
    if (method === 'simulateTransaction') return { value: { err: null, unitsConsumed: 200_000, accounts: [token(HELD + GAIN), token(0n), token(0n), wallet(solAfterTest)] } };
    if (method === 'getMultipleAccounts') {
      const reads = balanceReads++;
      return { value: reads === 0 ? [token(HELD), null, token(0n), wallet(LAMPORTS)] : [token(after.coin), null, token(0n), wallet(after.lamports)] };
    }
    throw new Error(`unexpected ${method}`);
  });
  const trip: Trip = {
    name: 'T',
    kind: 'jupiter',
    pool: 'POOL',
    coin,
    coinIn: 10_000_000n,
    accounts,
    before: { coin: HELD, token: 0n, tokenExists: false, other: 0n, otherExists: true, lamports: LAMPORTS },
    legs: [new TransactionInstruction({ programId: key(), keys: [], data: Buffer.from([1]) })],
    lookupTables: [],
    floor: FLOOR,
    verdict: () => null,
    says: (g) => `gains ${g}`,
  };
  const records: TripRecord[] = [];
  const reverted = vi.fn();
  const sent: VersionedTransaction[] = [];
  const io = {
    rpc,
    owner,
    log: vi.fn(),
    record: (r: TripRecord) => records.push(r),
    bans: { banned: () => null, reverted },
  } as unknown as KeeperIo;
  const instructionsOf = (tx: VersionedTransaction) => TransactionMessage.decompile(tx.message).instructions;
  return { io, trip, owner, accounts, records, reverted, sent, instructionsOf };
}

const settings = (jito: boolean) => ({ ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, raydiumPrograms: [], jito });

describe('sendChecked with KEEPER_JITO', () => {
  it.each([
    ['30% of the test run’s gain', FLOOR, (GAIN * 30n) / 100n, LAMPORTS],
    ['cut so the trip still keeps its floor', 800_000n, GAIN - 800_000n, LAMPORTS],
    ['cut to the plain SOL the wallet can spare', FLOOR, 70_000n, JITO_KEEP_LAMPORTS + 70_000n],
  ])('sends a SOL trip to Jito with a tip of %s, and the floor raised by it', async (_, floor, tip, solAfterTest) => {
    const r = rig(SOL_QUOTE, { coin: HELD + GAIN, lamports: LAMPORTS - tip - 5_000n }, solAfterTest);
    r.trip.floor = floor;
    const send = vi.fn();
    r.io.send = send;
    r.io.sendJito = vi.fn(async (tx: VersionedTransaction) => {
      r.sent.push(tx);
      return { signature: 'sig', outcome: 'confirmed' as const };
    });
    expect(await sendChecked(r.io, settings(true), r.trip)).toBe('sent');
    expect(send).not.toHaveBeenCalled();
    const ixs = r.instructionsOf(r.sent[0]!);
    const tipIx = ixs.at(-2)!;
    expect(tipIx.programId.toBase58()).toBe(SYSTEM);
    expect(JITO_TIP_ACCOUNTS).toContain(tipIx.keys[1]!.pubkey.toBase58());
    expect(tipIx.keys[0]!.pubkey.equals(r.owner)).toBe(true);
    expect(new DataView(tipIx.data.buffer, tipIx.data.byteOffset).getBigUint64(4, true)).toBe(tip);
    expect(floorOfCheck(ixs.at(-1)!)).toEqual({ account: r.accounts.coinAta, min: HELD + floor + tip });
    // The tip came out of the gain: the log shows the gain after it, and the day's fees without it.
    expect(r.records[0]).toMatchObject({ outcome: 'confirmed', gained: GAIN - tip, lamportsSpent: 5_000n });
  });

  it('calls a race Jito never landed lost, at no cost, and no reason to ban the pool', async () => {
    const r = rig(SOL_QUOTE, { coin: HELD, lamports: LAMPORTS });
    r.io.send = vi.fn();
    r.io.sendJito = vi.fn(async () => ({ signature: 'sig', outcome: 'lost' as const }));
    expect(await sendChecked(r.io, settings(true), r.trip)).toBe('race-lost');
    expect(r.records).toEqual([expect.objectContaining({ outcome: 'lost', gained: 0n, lamportsSpent: 0n })]);
    expect(r.reverted).not.toHaveBeenCalled();
  });

  it('sends a USDC trip the usual way, with no tip: the tip is paid in SOL', async () => {
    const r = rig(USDC_QUOTE, { coin: HELD + GAIN, lamports: LAMPORTS - 5_000n });
    r.io.sendJito = vi.fn();
    r.io.send = vi.fn(async (tx: VersionedTransaction) => {
      r.sent.push(tx);
      return { signature: 'sig', outcome: 'confirmed' as const };
    });
    expect(await sendChecked(r.io, settings(true), r.trip)).toBe('sent');
    expect(r.io.sendJito).not.toHaveBeenCalled();
    const ixs = r.instructionsOf(r.sent[0]!);
    expect(ixs.some((ix) => ix.programId.toBase58() === SYSTEM)).toBe(false);
    expect(floorOfCheck(ixs.at(-1)!)!.min).toBe(HELD + FLOOR);
  });

  it('sends the usual way, with no tip, when KEEPER_JITO is off', async () => {
    const r = rig(SOL_QUOTE, { coin: HELD + GAIN, lamports: LAMPORTS - 5_000n });
    r.io.sendJito = vi.fn();
    r.io.send = vi.fn(async (tx: VersionedTransaction) => {
      r.sent.push(tx);
      return { signature: 'sig', outcome: 'confirmed' as const };
    });
    expect(await sendChecked(r.io, settings(false), r.trip)).toBe('sent');
    expect(r.io.sendJito).not.toHaveBeenCalled();
    expect(floorOfCheck(r.instructionsOf(r.sent[0]!).at(-1)!)!.min).toBe(HELD + FLOOR);
    expect(r.records[0]).toMatchObject({ gained: GAIN, lamportsSpent: 5_000n });
  });
});
