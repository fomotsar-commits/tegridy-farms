// What a Solana wallet's throw means, read one way on every write this site sends
// (owner, 2026-10-13: one wallet behaviour, one wording). No imports but the words, so
// a page can say it without loading a send path.
//
// An adapter rethrows a wallet's failure wrapped (WalletSignTransactionError or
// WalletSendTransactionError, the wallet's own error under `.error`), and its name is
// never a decline. Trust declines with code 4001 and the message "4001", or a bare string.

import { DECLINED_IN_WALLET } from './swap/walletCopy';

/** The throw and the wallet errors under it, to a fixed depth. */
function walletErrors(e: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let cur = e, i = 0; cur != null && i < 4; i++) {
    chain.push(cur);
    cur = typeof cur === 'object' ? ((cur as { error?: unknown; cause?: unknown }).error ?? (cur as { cause?: unknown }).cause) : null;
  }
  return chain;
}

const namesIn = (e: unknown): string[] =>
  walletErrors(e)
    .map((x) => (typeof x === 'object' ? (x as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string');

/** The person said no in their wallet, by its words or by code 4001. */
export function isWalletDecline(e: unknown): boolean {
  return walletErrors(e).some((x) => {
    const o = (typeof x === 'object' ? x : { code: x, message: x }) as { name?: unknown; message?: unknown; code?: unknown };
    if (o.code === 4001 || o.code === '4001') return true;
    return /reject|declin|denied|cancel/i.test(`${String(o.name ?? '')} ${String(o.message ?? '')}`);
  });
}

// The adapter's own refusals: thrown BEFORE the wallet is asked, with a name and no
// words (wallet-adapter-base errors.js, StandardWalletAdapter's signTransaction,
// wallet-adapter-react's sendTransaction with no wallet chosen).
const NEVER_ASKED = new Map([
  ['WalletNotSelectedError', 'no wallet is chosen on this page, so none was asked'],
  ['WalletNotConnectedError', 'this page is no longer connected to it, so it was never asked'],
  ['WalletConfigError', 'it does not offer transaction signing to this page, so it was never asked'],
  ['WalletAccountError', 'the account it shared does not allow transaction signing, so it was never asked'],
]);
/**
 * The adapter's sentence for a wallet that cannot take this transaction's version, thrown
 * before signing with nothing under it (wallet-adapter-base signer.js). A bare send error
 * is not read this way: a wallet that answered with no value after sending throws the same.
 */
const VERSION_REFUSED = /^Sending (versioned transactions|transaction version \S+) isn't supported by this wallet$/;
function refusedVersion(e: unknown): boolean {
  const o = (typeof e === 'object' && e !== null ? e : {}) as { name?: unknown; message?: unknown; error?: unknown };
  return o.name === 'WalletSendTransactionError' && o.error == null && typeof o.message === 'string' && VERSION_REFUSED.test(o.message);
}
/** Names that say nothing about why: a bare Error, and the wrappers every failure wears. */
const PLAIN_NAMES = new Set(['Error', 'WalletSignTransactionError', 'WalletSendTransactionError']);

/** One line, cut short: what clipDetail does to a string, without its module. */
function oneLine(s: string, max = 180): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Why a wallet stopped, for inside "(...)": its own words, else its error code, else
 * what the error's name tells. Only a string or a number is printed, never an object.
 */
export function walletReason(e: unknown): string {
  const chain = walletErrors(e);
  for (const x of chain) {
    const s = typeof x === 'object' ? (x as { message?: unknown }).message : x;
    if ((typeof s !== 'string' && typeof s !== 'number') || !String(s).trim()) continue;
    // The sentence around it already ends "Nothing was sent."
    const words = oneLine(String(s)).replace(/[.\s]*Nothing was sent\.?$/i, '');
    // An adapter that wrapped an object as its message made it "[object Object]".
    if (!words || /^\[object \w+\]$/.test(words)) continue;
    return /^-?\d+$/.test(words) ? `error code ${words}` : words;
  }
  const fields = chain.filter((x): x is { name?: unknown; code?: unknown } => typeof x === 'object');
  for (const { code } of fields) {
    if (Number.isInteger(code) || (typeof code === 'string' && /^-?\d+$/.test(code))) return `error code ${String(code)}`;
  }
  const names = namesIn(e);
  for (const n of names) {
    const said = NEVER_ASKED.get(n);
    if (said) return said;
  }
  const name = names.find((n) => /^[A-Za-z]\w{2,60}$/.test(n) && !PLAIN_NAMES.has(n));
  return name ? `it gave no reason, only the name ${name}` : 'it gave no reason';
}

export const notSignedCopy = (reason: string) => `Your wallet did not sign this (${reason}). Nothing was sent.`;

/** A throw from signing alone (the page broadcasts): nothing left the page, whatever it says. */
export function signThrowCopy(e: unknown): string {
  return isWalletDecline(e) ? DECLINED_IN_WALLET : notSignedCopy(walletReason(e));
}

/**
 * A throw from a wallet's sendTransaction, which signs AND sends. Only two throws prove
 * nothing was sent: the adapter's own refusals before the wallet is asked (by name, or a
 * version it cannot take), and a sign step that failed (WalletSignTransactionError). Any
 * other can come after the wallet signed, so it may be out: `unsure`, never "failed".
 */
export type SendThrow =
  | { kind: 'declined'; message: string }
  | { kind: 'not-signed'; message: string }
  /** `byWallet`: the adapter's send wrapper is on it, so it came from the wallet's sign-and-send. */
  | { kind: 'unsure'; reason: string; byWallet: boolean };

export function readSendThrow(e: unknown): SendThrow {
  if (isWalletDecline(e)) return { kind: 'declined', message: DECLINED_IN_WALLET };
  const names = namesIn(e);
  if (refusedVersion(e) || names.some((n) => NEVER_ASKED.has(n) || n === 'WalletSignTransactionError')) {
    return { kind: 'not-signed', message: notSignedCopy(walletReason(e)) };
  }
  return { kind: 'unsure', reason: walletReason(e), byWallet: names.includes('WalletSendTransactionError') };
}
