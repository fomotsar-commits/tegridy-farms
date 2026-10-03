import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { associatedTokenAddress } from '../../launcher/solana/curve/ix';
import { opened } from '../../launcher/solana/write/wsol';
import { getMultipleAccounts, type RawAccount } from './accounts';
import { NEVER_REFUNDED_ACCOUNT_SIZES } from './poolFinder';
import { SOL_QUOTE, type QuoteCoin } from './quotes';
import { tokenAccountSize } from './tokenAccountSize';
import { TOKEN_PROGRAM, WSOL_MINT } from './tokenSafety';

/**
 * What the add and remove panels need to know about the wallet, in one read: its SOL,
 * its token account for the pool's token, its wrapped-SOL account and whether it
 * already has a pool-share account, plus the two rents the "most you can add" sum
 * needs. For the panels' hints and Max buttons only: every number that rides a
 * transaction is read again when Review is pressed (write/liquidity.ts).
 *
 * An unread wallet is `unread`, never a balance of 0: a panel then shows no Max.
 *
 * Opening a pool (`opening: true`) also needs what the new pool's own accounts keep in
 * deposits for good (the pool, its price record, its share token and its two vaults):
 * `rents.neverRefunded`, from the same per-size rent reads. Without `opening` the answer
 * is exactly what it always was.
 *
 * THE PAIRING COIN (`quote`, default SOL: quotes.ts). SOL goes through the wrapped-SOL
 * account, so a SOL pool reads the keys it always read and `coin` is null. USDC and
 * BAYLA wrap nothing: the wrapped-SOL account is not read at all, and in its place the
 * wallet's own account for the coin is, under the COIN'S OWN token program, with the
 * coin's mint in the same call. The mint is there to size that account (165 bytes for
 * USDC, 170 for BAYLA) and to check it is the coin this site knows: a balance printed in
 * the wrong decimals would be wrong by a factor of thousands.
 */

export type WalletFacts =
  | {
      kind: 'ok';
      lamports: bigint;
      /** The associated account under the pool's token program; null when there is none. */
      token: { address: string; amount: bigint } | null;
      /** Read for a SOL pool only. For any other coin it is not read, and says `exists: false`. */
      wsol: { exists: boolean; amount: bigint };
      /**
       * The wallet's associated account for the pairing coin, under the coin's own token
       * program; null for SOL. `exists: false` with an amount of 0 is a real answer: the
       * chain said there is no account there. `address` is where it is, or would be opened.
       */
      coin: { address: string; exists: boolean; amount: bigint } | null;
      lpAccountExists: boolean;
      /**
       * `neverRefunded` only when asked with `opening`. `coinAccount` only for a coin that
       * is not SOL: the deposit an account for that coin holds, at its real size.
       */
      rents: { walletFloor: bigint; tokenAccount165: bigint; neverRefunded?: bigint; coinAccount?: bigint };
    }
  | { kind: 'unread'; detail: string };

/** Rent per account size, kept for the session: it does not change between reads. */
const rentCache = new Map<number, Promise<bigint>>();

function rent(rpc: SolanaRpc, size: number): Promise<bigint> {
  let r = rentCache.get(size);
  if (!r) {
    r = rpc('getMinimumBalanceForRentExemption', [size]).then((v) => {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error('getMinimumBalanceForRentExemption: expected a positive number');
      return BigInt(v);
    });
    // A failed read is not kept: the next read asks again.
    r.catch(() => rentCache.delete(size));
    rentCache.set(size, r);
  }
  return r;
}

/**
 * A token account's amount, or a throw when the account is not one (an unread, never a 0).
 * With `wallet`, the account must also still belong to that wallet: an account handed to
 * someone else holds nothing this wallet can spend.
 */
function tokenAmount(a: RawAccount, program: string, mint: string, what: string, wallet?: string): bigint {
  if (a.owner !== program || a.data.length < 165) throw new Error(`your ${what} account is not a token account`);
  if (new PublicKey(a.data.subarray(0, 32)).toBase58() !== mint) throw new Error(`your ${what} account holds a different token`);
  if (wallet !== undefined && new PublicKey(a.data.subarray(32, 64)).toBase58() !== wallet) throw new Error(`your ${what} account belongs to another wallet`);
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

/**
 * The size of the wallet's account for a pairing coin, from the coin's own mint as just
 * read. A throw (an unread) when that mint is missing, sits under another token program
 * than the coin's, has other decimals, or cannot be sized.
 */
function coinAccountSize(mint: RawAccount | null, quote: QuoteCoin): number {
  if (!mint) throw new Error(`${quote.symbol}'s own token was not found`);
  if (mint.owner !== quote.program) throw new Error(`${quote.symbol}'s own token sits under another token program`);
  // SPL mint layout: decimals is the byte at offset 44 (an account too short to be a mint has none).
  if (mint.data[44] !== quote.decimals) throw new Error(`${quote.symbol}'s own token does not have ${quote.symbol}'s decimals`);
  const size = tokenAccountSize(mint);
  if (typeof size === 'string') throw new Error(`an account for ${quote.symbol} could not be sized (${size})`);
  return size;
}

export async function readWalletFacts(
  rpc: SolanaRpc,
  a: { owner: string; tokenMint: string; tokenProgram: string; lpMint: string | null; opening?: true; quote?: QuoteCoin },
): Promise<WalletFacts> {
  try {
    const quote = a.quote ?? SOL_QUOTE;
    const owner = new PublicKey(a.owner);
    const tokenAddress = associatedTokenAddress(new PublicKey(a.tokenMint), owner, new PublicKey(a.tokenProgram)).toBase58();
    // SOL: the wrapped-SOL account, the same address as ever. Any other coin: the wallet's
    // account for it, under the coin's own program.
    const quoteAddress = associatedTokenAddress(new PublicKey(quote.mint), owner, new PublicKey(quote.program)).toBase58();
    const lpAddress = a.lpMint ? associatedTokenAddress(new PublicKey(a.lpMint), owner).toBase58() : null;
    // The coin's own mint goes last, so the keys before it are the ones a SOL pool reads.
    const keys = [a.owner, tokenAddress, quoteAddress, ...(lpAddress ? [lpAddress] : []), ...(quote.native ? [] : [quote.mint])];
    const [accounts, walletFloor, tokenAccount165, neverRefunded] = await Promise.all([
      getMultipleAccounts(rpc, keys),
      rent(rpc, 0),
      rent(rpc, 165),
      a.opening ? Promise.all(NEVER_REFUNDED_ACCOUNT_SIZES.map((n) => rent(rpc, n))).then((r) => r.reduce((sum, v) => sum + v, 0n)) : null,
    ]);
    const wallet = accounts[0];
    // An address that only holds SOL someone sent it is no account yet (`opened`).
    const tok = opened(accounts[1]);
    const held = opened(accounts[2]);
    const lp = lpAddress ? opened(accounts[3]) : null;

    const token = tok ? { address: tokenAddress, amount: tokenAmount(tok, a.tokenProgram, a.tokenMint, 'token') } : null;
    let wsol: { exists: boolean; amount: bigint } = { exists: false, amount: 0n };
    let coin: { address: string; exists: boolean; amount: bigint } | null = null;
    let coinAccount: bigint | null = null;
    if (quote.native) {
      if (held) wsol = { exists: true, amount: tokenAmount(held, TOKEN_PROGRAM, WSOL_MINT, 'wrapped-SOL') };
    } else {
      // Sized from the mint, so asked after it: kept per size like every other rent, and
      // 165 (USDC) is the one already asked above.
      coinAccount = await rent(rpc, coinAccountSize(accounts[keys.length - 1] ?? null, quote));
      coin = held
        ? { address: quoteAddress, exists: true, amount: tokenAmount(held, quote.program, quote.mint, quote.symbol, a.owner) }
        : { address: quoteAddress, exists: false, amount: 0n };
    }
    return {
      kind: 'ok',
      lamports: BigInt(wallet?.lamports ?? 0),
      token,
      wsol,
      coin,
      lpAccountExists: !!lp,
      rents: {
        walletFloor,
        tokenAccount165,
        ...(neverRefunded === null ? {} : { neverRefunded }),
        ...(coinAccount === null ? {} : { coinAccount }),
      },
    };
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
}
