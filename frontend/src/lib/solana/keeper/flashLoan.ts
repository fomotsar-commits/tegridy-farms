import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { SOL_QUOTE } from '../lp/quotes';

/**
 * A loan of SOL inside the trip's own transaction, from Kamino Lend's main market, so a trip is
 * sized to the gap and the owner's cap rather than to the keeper's float: borrow first, swap,
 * repay with the fee, and the Lighthouse check last holds the keeper's SOL to what it held plus
 * the floor. A trip that cannot repay, or would end under its floor, is undone whole, loan and
 * all, and costs only its network fee. SOL only: the one reserve read from a real trip.
 *
 * Copied byte for byte from a real mainnet trip: 3QKvzHwNSLAoY7ij4uEZqqjr7BLtitFbzFv8KhERFFDzQtYwP3UNxKs3pS21mTvX8UGpQeP4njaJL7ZkBPvFzsCa
 * (slot 465,859,742, 2026-11-05 21:38Z; wallet Cn8LrZZnFD6qpyUY5uxJqTYKJ131U1dQLspEJqsxBn34 closing
 * a gap in our BAYLA/SOL pool). Both instructions' data and their twelve accounts, in order, are
 * pinned by flashLoan.test.ts. Kamino kept 1,727 lamports on 172,726,224 borrowed: 0.001%.
 */

export const KAMINO_LEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const KAMINO_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
export const KAMINO_MARKET_AUTHORITY = new PublicKey('9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo');
export const KAMINO_SOL_RESERVE = new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q');
export const KAMINO_SOL_SUPPLY = new PublicKey('GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U');
export const KAMINO_SOL_FEE_RECEIVER = new PublicKey('3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph');

/**
 * A lookup table holding six of those accounts (the same trip used it; read 2026-11-06), so the
 * loan fits beside a Jupiter route in one transaction. A table's entries cannot be changed; if it
 * is ever closed, a loan trip fails to build and is skipped.
 */
export const KAMINO_LOOKUP_TABLE = 'FGMSBiyVE8TvZcdQnZETAAKw28tkQJ2ccZy6pyp95URb';

/** `flash_borrow_reserve_liquidity` and `flash_repay_reserve_liquidity`, as the real trip's data begins. */
export const FLASH_BORROW = Uint8Array.from([0x87, 0xe7, 0x34, 0xa7, 0x07, 0x34, 0xd4, 0xc1]);
export const FLASH_REPAY = Uint8Array.from([0xb9, 0x75, 0x00, 0xcb, 0x60, 0xf5, 0xb4, 0xba]);

/** Kamino's fee on a SOL flash loan, parts per million (1,727 lamports on 172,726,224). */
export const FLASH_FEE_PPM = 10n;

/** The fee on `amount`, rounded up: never less than Kamino keeps, so the floor never counts short. */
export const flashFee = (amount: bigint): bigint => (amount * FLASH_FEE_PPM + 999_999n) / 1_000_000n;

/** The twelve accounts both instructions name, in the real trip's order; the two referrer slots are unset (Kamino's own id). */
function loanKeys(owner: PublicKey, solAta: PublicKey) {
  const k = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isSigner, isWritable });
  return [
    k(owner, false, true),
    k(KAMINO_MARKET_AUTHORITY),
    k(KAMINO_MARKET),
    k(KAMINO_SOL_RESERVE, true),
    k(new PublicKey(SOL_QUOTE.mint)),
    k(KAMINO_SOL_SUPPLY, true),
    k(solAta, true),
    k(KAMINO_SOL_FEE_RECEIVER, true),
    k(KAMINO_LEND),
    k(KAMINO_LEND),
    k(SYSVAR_INSTRUCTIONS_PUBKEY),
    k(TOKEN_PROGRAM_ID),
  ];
}

const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

/** Borrow `amount` lamports of wrapped SOL into the keeper's SOL account. */
export function flashBorrowIx(owner: PublicKey, solAta: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({ programId: KAMINO_LEND, keys: loanKeys(owner, solAta), data: Buffer.from([...FLASH_BORROW, ...u64(amount)]) });
}

/** Repay `amount` (Kamino takes the fee on top) from the keeper's SOL account; `borrowAt` is the borrow's place in the transaction. */
export function flashRepayIx(owner: PublicKey, solAta: PublicKey, amount: bigint, borrowAt: number): TransactionInstruction {
  if (!Number.isInteger(borrowAt) || borrowAt < 0 || borrowAt > 255) throw new Error('the borrow’s place does not fit a byte');
  return new TransactionInstruction({ programId: KAMINO_LEND, keys: loanKeys(owner, solAta), data: Buffer.from([...FLASH_REPAY, ...u64(amount), borrowAt]) });
}

/** What a trip of `want` borrows: the part the keeper does not hold, and only in SOL; 0 without loans. */
export function loanFor(coinMint: string, want: bigint, held: bigint, enabled: boolean): bigint {
  if (!enabled || coinMint !== SOL_QUOTE.mint || want <= held) return 0n;
  return want - held;
}
