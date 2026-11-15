import { VersionedTransaction, type Connection, type PublicKey } from '@solana/web3.js';
import { blockhashSeen, recentBlockhashOf, type NoteBlockhash } from '../blockhashWindow';
import { pollConfirm, type ConfirmOutcome } from '../confirm';
import { readSendThrow, signThrowCopy, isWalletDecline } from '../walletThrow';
import { sendSigned, signatureOf, stampBlockhash, type SendRefusal } from './islandBasketSol';
import { jupiterLastValidAtMost } from './jupiterNote';
import { HELD_NOT_SENT, lostAnswerCopy } from './walletCopy';

/**
 * A Jupiter swap from the wallet to the chain: the swap page's Buy, step 1 of "Add with one
 * coin", and a basket coin bought on its own (2026-11-15).
 *
 * WHY THE WALLET ONLY SIGNS. Until 11-15 the wallet signed AND sent. When its send did not
 * reach a block the page could not tell lost from slow (it never saw the final bytes), and
 * nobody sent it again: the owner's screenshots of 11-15 show two swaps the network never
 * saw, said as "We couldn't confirm" with Buy held for ten minutes. And a wallet's send
 * that threw, whatever the reason, was "may have been sent" with Buy held two minutes, the
 * wallet's own words in a toast. Now the wallet signs, the page sends: the network's own
 * check runs first (a refusal there is "not sent", in the network's words), then the same
 * bytes go again every 2 s until the chain answers (lib/solana/swap/islandBasketSol.ts
 * sendSigned, the basket's send since 10-24).
 *
 * THE BLOCKHASH. Jupiter's transaction arrives with about 116 of its 150 blocks left (read
 * 2026-11-15: ~25 s at today's block speed), and what the page checks before the wallet
 * takes some of that. A fresh one is put on right before the wallet: nothing is signed yet,
 * and a test run never checked the blockhash. Phantom swaps in its own when it adds its
 * guard (landed site swaps carry a blockhash 46 to 54 blocks old, 11-15), so the note's
 * proof is read from the SIGNED bytes, never from what was handed to the wallet: a proof
 * on a blockhash the transaction no longer carries would end the hold while it can still
 * land, and a second press would pay twice.
 *
 * A wallet that cannot sign alone still signs and sends, as before (`signAndSend`).
 */

/** Phantom's guard (Lighthouse): instructions it adds to a transaction it signs. */
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
/** Jupiter's "SlippageToleranceExceeded" (6001). */
const JUPITER_SLIPPAGE = /custom program error: 0x1771\b/;

export interface SwapNote {
  signature: string | null;
  lastValidBlockHeight: number | null;
  blockhash: NoteBlockhash | null;
  sentAt: number;
}

export interface WalletSwapDeps {
  rpc: Pick<Connection, 'getLatestBlockhashAndContext' | 'getBlockHeight' | 'sendRawTransaction' | 'getSignatureStatuses'> &
    Partial<Pick<Connection, 'isBlockhashValid'>>;
  /** The wallet that pays: a signed transaction from any other payer is not sent. */
  owner: PublicKey;
  /** The wallet signs and nothing leaves the page. Absent: the wallet cannot sign alone. */
  sign?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  /** The wallet signs AND sends: only for a wallet that cannot sign alone. */
  signAndSend: (tx: VersionedTransaction) => Promise<string>;
  /** Read again right before the wallet: a swap this wallet sent, in any tab, still holds it. */
  holdsNow(): boolean;
  /** Write this swap's note: by its signature, or null for a wallet answer that was lost. */
  hold(note: SwapNote): void;
  /** Is this note still there? A late read only completes a note that is, never brings back a released one. */
  stillHeld(note: { signature: string | null; sentAt: number }): boolean;
  release(signature: string): void;
  /** How a signature the wallet sent is watched; pollConfirm unless given. Not used when the page sends. */
  confirm?(signature: string): Promise<ConfirmOutcome['outcome']>;
  /** A signature exists and its note is written: the wait for the chain starts. */
  onSent?(signature: string): void;
}

export interface WalletSwapArgs {
  /** "≈12 BAYLA with 0.1 SOL": completes "whether it sent ___". */
  words: string;
  /** The slippage the swap was built with, for a refusal on it. */
  slippageBps: number;
  timeoutMs: number;
}

export type WalletSwapEnd =
  /**
   * Nothing reached the network. `stage`: 'wallet' (it said no or did not sign, or a note
   * held it before it was asked) or 'network' (signed, and refused at the first send).
   */
  | { kind: 'not-sent'; stage: 'wallet' | 'network'; declined: boolean; message: string }
  /** Only when the wallet sends: it stopped without a signature after it may have sent. Held by a note with none. */
  | { kind: 'lost'; message: string }
  | { kind: 'sent'; signature: string; outcome: ConfirmOutcome['outcome'] };

const WALLET_DID_NOT_SIGN = 'Your wallet did not sign it. Nothing was sent.';

/**
 * The network's refusal at the first send, in words: whose check refused it, and why when it
 * said. Nothing reached the chain, so nothing was spent, and every line says so.
 */
export function refusedFirstCopy(reason: SendRefusal, signed: VersionedTransaction, slippageBps: number): string {
  const message = reason?.message ?? '';
  const logs = reason?.logs ?? [];
  if (/Blockhash not found/i.test(message)) return 'It took too long to approve in your wallet, so it ran out of time. Nothing was sent. Press again for a fresh price.';
  // Which instruction failed, read from the signed transaction itself: the wallet's added ones included.
  const at = /Error processing Instruction (\d+)/.exec(message);
  const ix = at ? signed.message.compiledInstructions[Number(at[1])] : undefined;
  const program = ix ? signed.message.staticAccountKeys[ix.programIdIndex]?.toBase58() : undefined;
  const lighthouseFailed = program === LIGHTHOUSE_PROGRAM || logs.some((l) => l.startsWith(`Program ${LIGHTHOUSE_PROGRAM} failed`));
  if (lighthouseFailed) {
    return 'Your wallet’s own safety check stopped it: the swap no longer matches what your wallet checked, usually because the price moved. Nothing was sent. Press again for a fresh price.';
  }
  if (JUPITER_SLIPPAGE.test(message)) {
    return `The price moved past your ${(slippageBps / 100).toFixed(2)}% slippage. Nothing was sent. Press again for a fresh price.`;
  }
  if (/insufficient (funds|lamports)/i.test(`${message} ${logs.join(' ')}`)) {
    return 'Not enough SOL for this swap and its network fee. Nothing was sent.';
  }
  const said = message.replace(/^Transaction simulation failed:\s*/i, '').replace(/\s+/g, ' ').trim();
  const clipped = said.length > 160 ? `${said.slice(0, 160)}…` : said;
  return `The network refused it before sending it (${clipped || 'it gave no reason'}). Nothing was sent.`;
}

/** The wallet signs, the page sends and watches. Never throws. */
export async function sendWalletSwap(d: WalletSwapDeps, tx: VersionedTransaction, a: WalletSwapArgs): Promise<WalletSwapEnd> {
  const fresh = await (async () => {
    try {
      return (await d.rpc.getLatestBlockhashAndContext('confirmed')) ?? null;
    } catch {
      return null;
    }
  })();
  if (fresh) stampBlockhash([tx], fresh.value.blockhash);
  // A swap this wallet sent in another tab meanwhile holds this one. Nothing is awaited from here to the wallet.
  if (d.holdsNow()) return { kind: 'not-sent', stage: 'wallet', declined: false, message: HELD_NOT_SENT };
  if (!d.sign) return viaWalletSend(d, tx, a);

  let got: VersionedTransaction;
  try {
    got = await d.sign(tx);
  } catch (e) {
    // Signing alone: whatever the wallet says, nothing left the page.
    return { kind: 'not-sent', stage: 'wallet', declined: isWalletDecline(e), message: signThrowCopy(e) };
  }
  let signed: VersionedTransaction;
  let signature: string | null;
  let raw: Uint8Array;
  try {
    // Read back from its bytes: a wallet bundling its own web3.js returns a lookalike class.
    signed = VersionedTransaction.deserialize(got.serialize());
    signature = signatureOf(signed);
    if (!signed.message.staticAccountKeys[0]?.equals(d.owner)) signature = null;
    // The bytes that go out, made before any note is written: nothing below can throw.
    raw = signed.serialize();
  } catch {
    return { kind: 'not-sent', stage: 'wallet', declined: false, message: WALLET_DID_NOT_SIGN };
  }
  if (!signature) return { kind: 'not-sent', stage: 'wallet', declined: false, message: WALLET_DID_NOT_SIGN };

  // When it can no longer land, from the blockhash it CARRIES. Ours, untouched: known exactly.
  // The wallet's own: seen valid by a read that lands after the note, with Jupiter's bound
  // (a read of the height now, + 300) meanwhile, so the hold never ends while it can land.
  const carried = recentBlockhashOf(signed);
  const ours = fresh !== null && carried === fresh.value.blockhash;
  const sentAt = Date.now();
  const note: SwapNote = {
    signature,
    lastValidBlockHeight: ours ? fresh.value.lastValidBlockHeight : null,
    blockhash: ours ? { hash: fresh.value.blockhash, validAt: fresh.context.slot } : null,
    sentAt,
  };
  // The note exists before the first byte leaves: from here it may land even if the page goes.
  d.hold(note);
  if (!ours) {
    void Promise.all([
      jupiterLastValidAtMost(() => d.rpc.getBlockHeight('confirmed')),
      blockhashSeen(d.rpc, carried),
    ]).then(([at, bh]) => {
      if ((at === null && bh === null) || !d.stillHeld(note)) return;
      d.hold({ ...note, lastValidBlockHeight: at, blockhash: bh });
    });
  }
  d.onSent?.(signature);

  const r = await sendSigned(d.rpc, raw, signature, a.timeoutMs);
  if (r.kind === 'not-sent') {
    d.release(signature);
    return { kind: 'not-sent', stage: 'network', declined: false, message: refusedFirstCopy(r.reason ?? null, signed, a.slippageBps) };
  }
  // Landed or refused: the chain answered. Unread: the note stays and holds.
  if (r.outcome !== 'unknown') d.release(signature);
  return { kind: 'sent', signature, outcome: r.outcome };
}

/**
 * A wallet that cannot sign alone signs and sends, as every swap did before 11-15. It may
 * swap in its own blockhash, so the note's only bound is Jupiter's (height now + 300): a
 * proof on the blockhash handed to it would prove nothing about the one it sent.
 */
async function viaWalletSend(d: WalletSwapDeps, tx: VersionedTransaction, a: WalletSwapArgs): Promise<WalletSwapEnd> {
  const lastValid: { at: number | null } = { at: null };
  const heightRead = jupiterLastValidAtMost(() => d.rpc.getBlockHeight('confirmed')).then((h) => (lastValid.at = h));
  const sentAt = Date.now();
  const note = (signature: string | null) => {
    const write = () => d.hold({ signature, lastValidBlockHeight: signature ? lastValid.at : null, blockhash: null, sentAt });
    write();
    const had = lastValid.at;
    // A read that lands after the note: the note learns when the swap can no longer land.
    void heightRead.then(() => {
      if (signature !== null && had === null && lastValid.at !== null && d.stillHeld({ signature, sentAt })) write();
    });
  };
  let signature: string;
  try {
    signature = await d.signAndSend(tx);
  } catch (e) {
    const t = readSendThrow(e);
    if (t.kind !== 'unsure') return { kind: 'not-sent', stage: 'wallet', declined: t.kind === 'declined', message: t.message };
    // It may be out with no signature to look up: held until its blockhash can no longer land (D1).
    note(null);
    return { kind: 'lost', message: lostAnswerCopy(t.reason, `it sent ${a.words}`) };
  }
  note(signature);
  d.onSent?.(signature);
  const outcome = d.confirm ? await d.confirm(signature) : (await pollConfirm(d.rpc, signature, a.timeoutMs)).outcome;
  if (outcome !== 'unknown') d.release(signature);
  return { kind: 'sent', signature, outcome };
}
