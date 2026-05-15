import { verifyMessage, isAddress, getAddress, type Address } from 'viem';
import type { Storage } from './storage.js';

/**
 * Wallet-binding flow.
 *
 * 1. User runs `/bind` from Telegram — bot replies with a one-shot
 *    challenge containing the chat id and a 16-byte nonce.
 * 2. User signs the exact challenge in their wallet (e.g. via
 *    https://etherscan.io/verifiedSignatures or the Tegridy app's
 *    "sign for Telegram" button).
 * 3. User runs `/bind <address> <signature>` — bot verifies the
 *    signature recovers to <address> and saves the binding.
 *
 * No SIWE here — SIWE is meant for web sessions with replay/expiry
 * tracking; for "bind this Telegram chat to this address" a single
 * message + signature is enough.
 */

const NONCE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

/** Build the deterministic challenge message a user must sign. */
export function buildChallengeMessage(chatId: string, nonce: string): string {
  return [
    'Tegridy Farms Telegram bot binding',
    '',
    `Chat ID: ${chatId}`,
    `Nonce: ${nonce}`,
    '',
    'Sign this message to bind this wallet to your Telegram chat. This',
    'does NOT grant any approval or move funds.',
  ].join('\n');
}

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  // Node 20+ has crypto.getRandomValues globally.
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function startBind(storage: Storage, chatId: string): { nonce: string; message: string } {
  const nonce = makeNonce();
  storage.setPendingBind(chatId, nonce, NONCE_TTL_MS);
  return { nonce, message: buildChallengeMessage(chatId, nonce) };
}

export type BindResult =
  | { ok: true; address: Address }
  | { ok: false; reason: 'no-pending' | 'bad-address' | 'bad-signature' | 'mismatch' };

export async function completeBind(
  storage: Storage,
  chatId: string,
  rawAddress: string,
  signature: string,
): Promise<BindResult> {
  const pending = storage.getPendingBind(chatId);
  if (!pending) return { ok: false, reason: 'no-pending' };
  if (!isAddress(rawAddress)) return { ok: false, reason: 'bad-address' };
  const checksummed = getAddress(rawAddress);
  const expectedMessage = buildChallengeMessage(chatId, pending.nonce);
  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: checksummed,
      message: expectedMessage,
      signature: signature as `0x${string}`,
    });
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!valid) return { ok: false, reason: 'mismatch' };
  storage.bind(chatId, checksummed);
  return { ok: true, address: checksummed };
}
