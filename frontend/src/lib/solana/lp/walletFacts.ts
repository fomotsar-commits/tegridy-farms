import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { associatedTokenAddress } from '../../launcher/solana/curve/ix';
import { getMultipleAccounts, type RawAccount } from './accounts';
import { TOKEN_PROGRAM, WSOL_MINT } from './tokenSafety';

/**
 * What the add and remove panels need to know about the wallet, in one read: its SOL,
 * its token account for the pool's token, its wrapped-SOL account and whether it
 * already has a pool-share account, plus the two rents the "most you can add" sum
 * needs. For the panels' hints and Max buttons only: every number that rides a
 * transaction is read again when Review is pressed (write/liquidity.ts).
 *
 * An unread wallet is `unread`, never a balance of 0: a panel then shows no Max.
 */

export type WalletFacts =
  | {
      kind: 'ok';
      lamports: bigint;
      /** The associated account under the pool's token program; null when there is none. */
      token: { address: string; amount: bigint } | null;
      wsol: { exists: boolean; amount: bigint };
      lpAccountExists: boolean;
      rents: { walletFloor: bigint; tokenAccount165: bigint };
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

/** A token account's amount, or a throw when the account is not one (an unread, never a 0). */
function tokenAmount(a: RawAccount, program: string, mint: string, what: string): bigint {
  if (a.owner !== program || a.data.length < 165) throw new Error(`your ${what} account is not a token account`);
  if (new PublicKey(a.data.subarray(0, 32)).toBase58() !== mint) throw new Error(`your ${what} account holds a different token`);
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

export async function readWalletFacts(
  rpc: SolanaRpc,
  a: { owner: string; tokenMint: string; tokenProgram: string; lpMint: string | null },
): Promise<WalletFacts> {
  try {
    const owner = new PublicKey(a.owner);
    const tokenAddress = associatedTokenAddress(new PublicKey(a.tokenMint), owner, new PublicKey(a.tokenProgram)).toBase58();
    const wsolAddress = associatedTokenAddress(new PublicKey(WSOL_MINT), owner).toBase58();
    const keys = [a.owner, tokenAddress, wsolAddress, ...(a.lpMint ? [associatedTokenAddress(new PublicKey(a.lpMint), owner).toBase58()] : [])];
    const [accounts, walletFloor, tokenAccount165] = await Promise.all([getMultipleAccounts(rpc, keys), rent(rpc, 0), rent(rpc, 165)]);
    const [wallet, tok, wsol, lp] = accounts;
    return {
      kind: 'ok',
      lamports: BigInt(wallet?.lamports ?? 0),
      token: tok ? { address: tokenAddress, amount: tokenAmount(tok, a.tokenProgram, a.tokenMint, 'token') } : null,
      wsol: wsol ? { exists: true, amount: tokenAmount(wsol, TOKEN_PROGRAM, WSOL_MINT, 'wrapped-SOL') } : { exists: false, amount: 0n },
      lpAccountExists: !!lp,
      rents: { walletFloor, tokenAccount165 },
    };
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
}
