// Polyfill MUST load before any @solana/* import — keep this first.
import '../../../lib/solanaPolyfill';
import { useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { v1SignerOf } from '../../../lib/solana/v1Signer';
import type { TxSigner } from './ports';

export type CurveSignerState =
  | { kind: 'disconnected'; connecting: boolean }
  /** Connected, but the wallet offers no signTransaction. We never fall back to its own send path. */
  | { kind: 'cannot-sign'; address: string; walletName: string | null }
  | {
      kind: 'ready';
      signer: TxSigner;
      address: string;
      /** For the picture upload's signed request. `null` when the wallet cannot sign messages. */
      signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
    };

/**
 * The connected wallet as a `TxSigner`, or why there is none.
 *
 * The wallet only signs. A wallet's own send method broadcasts through its own RPC and
 * its own idea of the chain, so the write layer signs here and sends through our proxy
 * itself. A wallet that advertises SIMD-0385 version 1 also gets `signV1`, the Wallet
 * Standard feature that signs raw bytes (lib/solana/v1Signer.ts); the write layer then
 * builds version 1 messages for it, and legacy ones for every other wallet.
 */
export function useCurveSigner(): CurveSignerState {
  const { publicKey, signTransaction, signMessage, connecting, wallet } = useWallet();
  return useMemo<CurveSignerState>(() => {
    if (!publicKey) return { kind: 'disconnected', connecting };
    if (!signTransaction) {
      return { kind: 'cannot-sign', address: publicKey.toBase58(), walletName: wallet?.adapter.name ?? null };
    }
    const signV1 = v1SignerOf(wallet?.adapter, publicKey);
    return {
      kind: 'ready',
      signer: { publicKey, signTransaction, ...(signV1 ? { signV1 } : {}) },
      address: publicKey.toBase58(),
      signMessage: signMessage ?? null,
    };
  }, [publicKey, signTransaction, signMessage, connecting, wallet]);
}
