// ONE Solana write with no review screen, the way Phantom asks for it: a claim, a stake, an
// exit on a staking card, and each claim of Claim all.
//
// Phantom's answer on ticket #467471 (2026-11-16), on top of its 11-05 answer (version 1
// with explicit limits, lib/solana/v1Send.ts) and its "Domain and transaction warnings" page:
//  1. one transaction per wallet approval, asked with signTransaction, and sent by us
//     through our RPC with preflight on. Never several on one prompt, never the wallet's send.
//  2. the wallet's SOL checked against the network fee and any account rent BEFORE the
//     wallet is asked; short, and the wallet is not asked at all.
//  3. a final test run (signature checks off) that fails, or cannot complete, stops it
//     before the wallet is asked. It once went on untested; a claim Streamflow's program
//     can no longer pay (its error 6000, an arithmetic overflow) was even sent on purpose,
//     so the chain could say so. Phantom's own test run then failed and warned.
//
// A wallet that lists version 1 gets version 1 (v1SignerOf). Any other gets version 0, or
// legacy for a wallet that lists no version 0 (Phantom: "offer a v0 option", e.g. Ledger).
import { Transaction, TransactionMessage, VersionedTransaction, type Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { base58 } from '@scure/base';
import { holdReload } from '../reloadHold';
import { sendSigned, signatureOf, type WatchDeps } from './sendSigned';
import { v1SignerOf } from './v1Signer';
import { acceptSignedV1, laggedRun, prepareV1, testRun, type TestRun } from './v1Send';
import { isWalletDecline, signThrowCopy } from './walletThrow';
import type { ConfirmOutcome } from './confirm';

/** A system account holding no data must keep at least this, or nothing (Solana's rent-exempt minimum for 0 bytes). */
export const RENT_EXEMPT_EMPTY_LAMPORTS = 890_880n;
/**
 * Room for the priority fee a wallet may add as it signs: Phantom sets its own on any app
 * transaction that names none (docs.phantom.com, "Solana priority fees"), and these name
 * none. 0.0001 SOL.
 */
export const WALLET_FEE_ROOM_LAMPORTS = 100_000n;
/**
 * Room a wallet's own guards take as it signs: Phantom's Lighthouse assertions came to 325
 * bytes on a ladder claim landed 2026-11-23 (`2csQUSTN…`, 797 bytes against our 472). A
 * transaction that packs several claims leaves this much under Solana's size limit.
 */
export const WALLET_GUARD_ROOM_BYTES = 325;
const LAMPORTS_PER_SIGNATURE = 5_000n;

export const WRITE_COPY = {
  unreachable: 'The Solana network could not be reached just now, so your wallet was not asked. Nothing was sent.',
  noAnswer: 'The test run before your wallet could not finish just now, so your wallet was not asked. Nothing was sent. Try again in a moment.',
  tooLarge: 'This transaction is too large for Solana, so your wallet was not asked. Nothing was sent.',
  notSigned: 'Your wallet did not sign it. Nothing was sent.',
  balanceUnread: 'Your SOL balance could not be read just now, so your wallet was not asked. Nothing was sent. Try again in a moment.',
  notReadable: 'This transaction could not be read, so your wallet was not asked. Nothing was sent.',
} as const;

/** SOL with up to 6 decimals: a need rounded UP, a holding cut DOWN, so neither is ever overstated in the reader's favour. */
export function solWords(lamports: bigint, round: 'up' | 'down'): string {
  const step = 1_000n; // 6 decimals
  const units = round === 'up' ? (lamports + step - 1n) / step : lamports / step;
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export const solShortCopy = (need: bigint, have: bigint) =>
  `Not enough SOL: this needs about ${solWords(need, 'up')} SOL in your wallet for the network fee and account rent, and it holds ${solWords(have, 'down')} SOL. Your wallet was not asked. Nothing was sent.`;

/**
 * What the wallet must hold for this, or null when it holds enough. `before`: its SOL now.
 * `after`: its SOL after the final test run (rent for any account the write opens, and
 * anything it pays, are already out), or null when the node did not say. `fee`: the network
 * fee the message names. On top: room for the wallet's own priority fee, and the wallet
 * left either empty or at its rent-exempt minimum (Solana refuses anything between).
 */
export function solShortfall(before: bigint, after: bigint | null, fee: bigint): { need: bigint; have: bigint } | null {
  const spent = after !== null && after < before ? before - after : 0n;
  const need = spent + fee + WALLET_FEE_ROOM_LAMPORTS + RENT_EXEMPT_EMPTY_LAMPORTS;
  return before >= need ? null : { need, have: before };
}

/** Base fee: 5,000 lamports for each signature the instructions require (the payer's included). */
function baseFee(owner: PublicKey, ixs: readonly TransactionInstruction[]): bigint {
  const signers = new Set<string>([owner.toBase58()]);
  for (const ix of ixs) for (const k of ix.keys) if (k.isSigner) signers.add(k.pubkey.toBase58());
  return BigInt(signers.size) * LAMPORTS_PER_SIGNATURE;
}

export type WriteConn = Pick<
  Connection,
  'getLatestBlockhash' | 'getBalance' | 'simulateTransaction' | 'sendRawTransaction' | 'getSignatureStatuses'
>;

export type WriteVersion = 1 | 0 | 'legacy';

export type WriteEnd =
  /**
   * Nothing left the page. `stage`: 'test' (the final test run refused it: `logs` and
   * `run` say why, the caller's `refused` words are in `reason`), 'check' (it could not be
   * tested or the SOL check could not run, or it is too large), 'sol' (not enough SOL),
   * 'wallet' (declined, or not signed), 'network' (signed, refused by the first send's
   * preflight: `logs` when the node gave them).
   */
  | { kind: 'not-sent'; stage: 'test' | 'check' | 'sol' | 'wallet' | 'network'; reason: string; declined?: boolean; logs?: readonly string[]; run?: TestRun }
  | { kind: 'sent'; signature: string; outcome: ConfirmOutcome['outcome']; slot: number | null; version: WriteVersion };

export interface WriteOpts {
  /** A refused final test run ('test'), or a first send its preflight refused ('send'), in this write's own words. */
  refused: (run: TestRun, where: 'test' | 'send') => string;
  /** How long the send is watched. */
  timeoutMs?: number;
  /** Version 1 is signed for this chain. */
  chain?: 'solana:mainnet' | 'solana:devnet';
  deps?: WatchDeps;
}

/** What the adapter signs alone: version 0 when it lists it, legacy when it lists none. */
function plainVersionOf(wallet: SignerWalletAdapter): 0 | 'legacy' {
  const v = (wallet as { supportedTransactionVersions?: ReadonlySet<unknown> | null }).supportedTransactionVersions;
  return v && typeof v.has === 'function' && v.has(0) ? 0 : 'legacy';
}

function unsignedBytes(tx: VersionedTransaction | Transaction): Uint8Array {
  return tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/**
 * Build, test-run, check the SOL, have the wallet SIGN this one transaction, and send it
 * ourselves with preflight on; then watch it. Never throws.
 */
export async function sendOneWrite(
  conn: WriteConn,
  wallet: SignerWalletAdapter,
  owner: PublicKey,
  instructions: readonly TransactionInstruction[],
  opts: WriteOpts,
): Promise<WriteEnd> {
  const chain = opts.chain ?? 'solana:mainnet';
  const testRefused = (run: TestRun): WriteEnd => ({ kind: 'not-sent', stage: 'test', reason: opts.refused(run, 'test'), logs: run.logs, run });
  const check = (reason: string): WriteEnd => ({ kind: 'not-sent', stage: 'check', reason });

  let lifetime: { blockhash: string; lastValidBlockHeight: number };
  let before: bigint;
  try {
    const [bh, bal] = await Promise.all([conn.getLatestBlockhash('confirmed'), conn.getBalance(owner, 'confirmed')]);
    lifetime = bh;
    if (typeof bal !== 'number' || !Number.isSafeInteger(bal) || bal < 0) return check(WRITE_COPY.balanceUnread);
    before = BigInt(bal);
  } catch {
    return check(WRITE_COPY.unreachable);
  }
  const fee = baseFee(owner, instructions);

  // The unsigned transaction, tested as it will be signed.
  const signV1 = v1SignerOf(wallet, owner);
  let version: WriteVersion;
  let ours: Uint8Array;
  let plain: VersionedTransaction | Transaction | null = null;
  let finalRun: TestRun;
  if (signV1) {
    version = 1;
    const prepared = await prepareV1(conn, owner, instructions, lifetime);
    if ('noAnswer' in prepared) return check(WRITE_COPY.noAnswer);
    if ('tooLarge' in prepared) return check(WRITE_COPY.tooLarge);
    if ('refusedRun' in prepared) return testRefused(prepared.refusedRun);
    ours = prepared.bytes;
    finalRun = prepared.finalRun;
  } else {
    version = plainVersionOf(wallet);
    try {
      if (version === 0) {
        plain = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: lifetime.blockhash, instructions: [...instructions] }).compileToV0Message());
      } else {
        plain = new Transaction({ feePayer: owner, blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight });
        plain.add(...instructions);
      }
      ours = unsignedBytes(plain);
    } catch {
      return check(WRITE_COPY.tooLarge);
    }
    try {
      finalRun = await testRun(conn, ours, owner);
    } catch {
      return check(WRITE_COPY.noAnswer);
    }
    if (laggedRun(finalRun)) return check(WRITE_COPY.noAnswer);
    if (!finalRun.ok) return testRefused(finalRun);
  }

  const sign: Sign = signV1
    ? async () => acceptSignedV1(conn, ours, await signV1(ours, chain), owner)
    : async () => readSigned(await wallet.signTransaction(plain!), owner) ?? { refusal: WRITE_COPY.notSigned };
  return gateSignSend(conn, before, fee, finalRun, sign, version, opts);
}

/**
 * A transaction someone else built for this wallet (Jupiter's DCA and limit orders), the
 * same way: its own bytes test-run as they are, the SOL checked, the wallet asked only to
 * SIGN, and our own send. Its blockhash is left alone: another party may have signed it.
 */
export async function sendBuiltTx(
  conn: WriteConn,
  sign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  owner: PublicKey,
  tx: VersionedTransaction,
  opts: WriteOpts,
): Promise<WriteEnd> {
  const gate = await testBeforeWallet(conn, owner, tx, opts.refused);
  if (!gate.ok) return gate.end;
  return gateSignSend(conn, gate.before, gate.fee, gate.run, async () => readSigned(await sign(tx), owner) ?? { refusal: WRITE_COPY.notSigned }, 0, opts);
}

/**
 * The final test run of a built transaction's own bytes (as they are: its blockhash is
 * left alone), with the payer's SOL read before it. `ok` with what the SOL check needs, or
 * the not-sent ending: paid by another wallet, a read or run that did not answer, or a run
 * that refused it. The SOL check itself is `solShortfall`.
 */
export async function testBeforeWallet(
  conn: Pick<WriteConn, 'getBalance' | 'simulateTransaction'>,
  owner: PublicKey,
  tx: VersionedTransaction,
  refused: WriteOpts['refused'],
): Promise<{ ok: true; before: bigint; fee: bigint; run: TestRun } | { ok: false; end: Extract<WriteEnd, { kind: 'not-sent' }> }> {
  const check = (reason: string) => ({ ok: false as const, end: { kind: 'not-sent' as const, stage: 'check' as const, reason } });
  let fee: bigint;
  try {
    if (!tx.message.staticAccountKeys[0]?.equals(owner)) return check('This transaction is paid by another wallet, so your wallet was not asked. Nothing was sent.');
    fee = BigInt(tx.message.header.numRequiredSignatures) * LAMPORTS_PER_SIGNATURE;
  } catch {
    return check(WRITE_COPY.notReadable);
  }
  let before: bigint;
  try {
    const bal = await conn.getBalance(owner, 'confirmed');
    if (typeof bal !== 'number' || !Number.isSafeInteger(bal) || bal < 0) return check(WRITE_COPY.balanceUnread);
    before = BigInt(bal);
  } catch {
    return check(WRITE_COPY.unreachable);
  }
  let run: TestRun;
  try {
    run = await testRun(conn, tx.serialize(), owner);
  } catch {
    return check(WRITE_COPY.noAnswer);
  }
  if (laggedRun(run)) return check(WRITE_COPY.noAnswer);
  if (!run.ok) return { ok: false, end: { kind: 'not-sent', stage: 'test', reason: refused(run, 'test'), logs: run.logs, run } };
  return { ok: true, before, fee, run };
}

/** The wallet's signature, read back and held to the rules: the bytes to send, or why not. */
type Sign = () => Promise<{ raw: Uint8Array; signature: string } | { refusal: string }>;

/** After a final test run that passed: the SOL check, the wallet's signature, our send, the watch. */
async function gateSignSend(
  conn: WriteConn,
  before: bigint,
  fee: bigint,
  finalRun: TestRun,
  sign: Sign,
  version: WriteVersion,
  opts: WriteOpts,
): Promise<WriteEnd> {
  // The SOL check, on the run's own reading of what this takes out of the wallet.
  const short = solShortfall(before, finalRun.payerLamportsAfter ?? null, fee);
  if (short) return { kind: 'not-sent', stage: 'sol', reason: solShortCopy(short.need, short.have) };

  // Until this write is answered the page does not reload itself (lib/staleBuild.ts).
  const release = holdReload();
  try {
    let raw: Uint8Array;
    let signature: string;
    try {
      const signed = await sign();
      if ('refusal' in signed) return { kind: 'not-sent', stage: 'wallet', reason: signed.refusal };
      ({ raw, signature } = signed);
    } catch (e) {
      // Signing alone: whatever the wallet says, nothing left the page.
      return { kind: 'not-sent', stage: 'wallet', reason: signThrowCopy(e), declined: isWalletDecline(e) };
    }
    const sent = await sendSigned(conn, raw, signature, opts.timeoutMs ?? 60_000, opts.deps);
    if (sent.kind === 'not-sent') {
      const logs = sent.reason?.logs ?? [];
      const said = opts.refused({ ok: false, err: sent.reason?.message ?? null, logs: [...logs] }, 'send');
      return { kind: 'not-sent', stage: 'network', reason: /Blockhash not found/i.test(sent.reason?.message ?? '') ? sent.why : said, logs };
    }
    return { kind: 'sent', signature, outcome: sent.outcome, slot: sent.slot ?? null, version };
  } finally {
    release();
  }
}

/**
 * The bytes to send and their signature, read back from what the wallet returned: from its
 * bytes (a wallet bundling its own web3.js returns a lookalike class), paid by `owner`, and
 * signed. Null otherwise.
 */
function readSigned(got: VersionedTransaction | Transaction, owner: PublicKey): { raw: Uint8Array; signature: string } | null {
  try {
    if ('version' in got) {
      const tx = VersionedTransaction.deserialize(got.serialize());
      if (!tx.message.staticAccountKeys[0]?.equals(owner)) return null;
      const signature = signatureOf(tx);
      return signature ? { raw: tx.serialize(), signature } : null;
    }
    const tx = Transaction.from(got.serialize({ requireAllSignatures: false, verifySignatures: false }));
    if (!tx.feePayer?.equals(owner)) return null;
    const sig = tx.signatures.find((s) => s.publicKey.equals(owner))?.signature;
    if (!sig || !sig.some((b) => b !== 0)) return null;
    return { raw: tx.serialize(), signature: base58.encode(sig) };
  } catch {
    return null;
  }
}
