// Does the connected wallet sign SIMD-0385 version 1 transactions? Phantom's recipe
// (docs.phantom.com, "Send a Solana v1 transaction"): the connected account lists the
// `solana:signTransaction` feature and that feature lists version 1. The wallet is the
// Wallet Standard one behind wallet-adapter's StandardWalletAdapter; our vendored legacy
// adapters (lib/solanaWallets.ts) have none, so they stay on legacy transactions.

import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import type { PublicKey } from '@solana/web3.js';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { TxSigner } from '../launcher/solana/write/types';

type SignV1 = NonNullable<TxSigner['signV1']>;
type SignFeature = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

/** The Wallet Standard wallet behind an adapter, or null for a legacy adapter. */
function standardWalletOf(adapter: unknown): Wallet | null {
  if (!adapter || typeof adapter !== 'object') return null;
  const a = adapter as { standard?: unknown; wallet?: unknown };
  if (a.standard !== true || !a.wallet || typeof a.wallet !== 'object') return null;
  return a.wallet as Wallet;
}

function signFeatureOf(wallet: Wallet): SignFeature | null {
  const f = wallet.features[SolanaSignTransaction] as SignFeature | undefined;
  return f && Array.isArray(f.supportedTransactionVersions) && typeof f.signTransaction === 'function' ? f : null;
}

/** The connected account, when the feature lists version 1 and the account lists the feature. */
function signingAccount(wallet: Wallet, address: string): WalletAccount | null {
  const feature = signFeatureOf(wallet);
  if (!feature || !feature.supportedTransactionVersions.includes(1)) return null;
  const account = wallet.accounts.find((acc) => acc.address === address);
  return account && account.features.includes(SolanaSignTransaction) ? account : null;
}

/**
 * A signer of version 1 bytes for `publicKey`, or null when this wallet keeps the legacy
 * path. The wallet signs only; the write path sends (write/submit.ts).
 */
export function v1SignerOf(adapter: unknown, publicKey: PublicKey): SignV1 | null {
  const wallet = standardWalletOf(adapter);
  if (!wallet) return null;
  const address = publicKey.toBase58();
  if (!signingAccount(wallet, address)) return null;
  return async (bytes, chain) => {
    // Read again at signing time: the account may have changed since the page rendered.
    const account = signingAccount(wallet, address);
    const feature = signFeatureOf(wallet);
    if (!account || !feature || !wallet.accounts.includes(account)) throw new Error('Wallet account changed. Reconnect.');
    const [result] = await feature.signTransaction({ account, chain, transaction: bytes });
    if (!result) throw new Error('The wallet did not return a signed transaction.');
    return new Uint8Array(result.signedTransaction);
  };
}
