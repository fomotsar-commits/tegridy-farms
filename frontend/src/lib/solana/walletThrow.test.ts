// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  WalletAccountError,
  WalletConfigError,
  WalletNotConnectedError,
  WalletSendTransactionError,
  WalletSignTransactionError,
} from '@solana/wallet-adapter-base';
import { WalletNotSelectedError } from '@solana/wallet-adapter-react';
import { DECLINED_IN_WALLET } from './swap/walletCopy';
import { JUPITER_WINDOW_BLOCKS, jupiterLastValidAtMost } from './swap/jupiterNote';
import { notSignedCopy, readSendThrow } from './walletThrow';

// The parity table's four columns, as a wallet's sendTransaction throws them: one reading.
describe('readSendThrow: a throw from a wallet that signs AND sends', () => {
  it.each([
    ['Phantom’s decline', new WalletSendTransactionError('User rejected the request.', { code: 4001, message: 'User rejected the request.' })],
    ['Solflare’s decline', new WalletSendTransactionError('Transaction cancelled', new Error('Transaction cancelled'))],
    ['Trust’s code-only decline', new WalletSendTransactionError('4001', Object.assign(new Error('4001'), { code: 4001 }))],
    ['a decline that is an object with no message', new WalletSendTransactionError(undefined, { code: 4001 })],
  ])('%s is a cancel', (_, thrown) => {
    expect(readSendThrow(thrown)).toEqual({ kind: 'declined', message: DECLINED_IN_WALLET });
  });

  it.each([
    ['not connected', new WalletNotConnectedError(), 'this page is no longer connected to it, so it was never asked'],
    ['no signing offered', new WalletConfigError(), 'it does not offer transaction signing to this page, so it was never asked'],
    ['an account that cannot sign', new WalletAccountError(), 'the account it shared does not allow transaction signing, so it was never asked'],
    ['a sign step that failed, in its words', new WalletSignTransactionError('Wallet is locked', new Error('Wallet is locked')), 'Wallet is locked'],
  ])('a wallet that never signed (%s) gets its reason, and nothing was sent', (_, thrown, reason) => {
    expect(readSendThrow(thrown)).toEqual({ kind: 'not-signed', message: notSignedCopy(reason) });
  });

  // Thrown by the adapter before the wallet is asked (wallet-adapter-base signer.js,
  // wallet-adapter-react WalletProviderBase.js): nothing was signed, so nothing was sent.
  it.each([
    ['a wallet that cannot take a versioned transaction (every Jupiter swap is one)', new WalletSendTransactionError("Sending versioned transactions isn't supported by this wallet"), "Sending versioned transactions isn't supported by this wallet"],
    ['a wallet that cannot take this version', new WalletSendTransactionError("Sending transaction version 0 isn't supported by this wallet"), "Sending transaction version 0 isn't supported by this wallet"],
    ['no wallet chosen on the page', new WalletNotSelectedError(), 'no wallet is chosen on this page, so none was asked'],
  ])('the adapter refused before asking the wallet (%s): nothing was sent', (_, thrown, reason) => {
    expect(readSendThrow(thrown)).toEqual({ kind: 'not-signed', message: notSignedCopy(reason) });
  });

  it('a send error with nothing under it stays unsure: a wallet that answered with no value after it may have sent throws the same', () => {
    // StandardWalletAdapter's other-network refusal is `new WalletSendTransactionError()`; a wallet
    // that rejects with undefined is wrapped as `new WalletSendTransactionError(undefined, undefined)`.
    expect(readSendThrow(new WalletSendTransactionError())).toMatchObject({ kind: 'unsure', byWallet: true });
    // The adapter's sentence over an error the wallet raised is not the adapter's own refusal.
    expect(readSendThrow(new WalletSendTransactionError("Sending versioned transactions isn't supported by this wallet", new Error('x')))).toMatchObject({ kind: 'unsure' });
  });

  it('a send that failed after the wallet may have signed is unsure, with the wallet’s words', () => {
    expect(readSendThrow(new WalletSendTransactionError('failed to send transaction: fetch failed', new TypeError('fetch failed')))).toEqual({
      kind: 'unsure',
      reason: 'failed to send transaction: fetch failed',
      byWallet: true,
    });
    // A code that is not 4001 is a code, not a cancel.
    expect(readSendThrow(new WalletSendTransactionError('4100', Object.assign(new Error('4100'), { code: 4100 })))).toMatchObject({ kind: 'unsure', reason: 'error code 4100' });
    // Not the wallet's at all.
    expect(readSendThrow(new Error('Quote unavailable (502)'))).toMatchObject({ kind: 'unsure', byWallet: false });
  });
});

describe('jupiterLastValidAtMost', () => {
  it('is the height read plus two blockhash windows, and null when the height could not be read', async () => {
    expect(await jupiterLastValidAtMost(async () => 1_000)).toBe(1_000 + JUPITER_WINDOW_BLOCKS);
    expect(JUPITER_WINDOW_BLOCKS).toBeGreaterThanOrEqual(150);
    expect(await jupiterLastValidAtMost(async () => { throw new Error('RPC 503'); })).toBeNull();
    expect(await jupiterLastValidAtMost(async () => Number.NaN)).toBeNull();
  });
});
