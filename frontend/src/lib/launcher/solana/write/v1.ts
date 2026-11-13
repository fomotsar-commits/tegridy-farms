// A version 1 transaction (SIMD-0385), for a wallet that advertises one. The budget is
// the message's CONFIG, not instructions: the compute-unit limit, the loaded-accounts-
// data limit (unset would mean 0, and the transaction would fail) and the whole priority
// fee in lamports. Built with @solana/kit from the same web3.js instructions every kind
// already produces; web3.js 1.98 can neither build nor read this format, so kit does
// both ends here, and nothing else in the write path imports it.

import { ed25519 } from '@noble/curves/ed25519';
import { PublicKey, TransactionInstruction, type Keypair } from '@solana/web3.js';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
  type Transaction as KitTransaction,
} from '@solana/kit';
import type { TxConfig } from './types';

/** The byte a version 1 message starts with on the wire. */
export const V1_VERSION_BYTE = 129;

/** Solana's size limit for a version 1 transaction (a legacy one: 1,232). */
export const V1_TX_SIZE_LIMIT = 4_096;

/**
 * 64 MiB: what a legacy transaction may load by default. The sizing run asks for it,
 * and so does a final message when the node did not say how much it loaded.
 */
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/** Loaded account data is charged in 32 KiB pages. */
const LOADED_DATA_PAGE = 32 * 1024;

/** The bytes the sizing run loaded plus a quarter, in whole pages; the legacy default when the node did not say. Never 0. */
export function loadedDataLimitFromSimulation(loaded: number | undefined): number {
  if (typeof loaded !== 'number' || !Number.isFinite(loaded) || loaded <= 0) return MAX_LOADED_ACCOUNTS_DATA_SIZE;
  const pages = Math.max(1, Math.ceil((loaded * 1.25) / LOADED_DATA_PAGE));
  return Math.min(pages * LOADED_DATA_PAGE, MAX_LOADED_ACCOUNTS_DATA_SIZE);
}

const roleOf = (k: { isSigner: boolean; isWritable: boolean }): AccountRole =>
  k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;

function toKit(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({ address: address(k.pubkey.toBase58()), role: roleOf(k) })),
    data: new Uint8Array(ix.data),
  };
}

function fromKit(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.READONLY_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.WRITABLE,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array(0)),
  });
}

/**
 * The unsigned wire bytes of a version 1 message: fee payer, blockhash, config, then
 * `body` as given. No ComputeBudget instruction is added: the runtime ignores one here.
 */
export function assembleV1(payer: PublicKey, blockhash: string, lastValidBlockHeight: number, config: TxConfig, body: readonly TransactionInstruction[]): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(address(payer.toBase58()), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, m),
    (m) => setTransactionMessageConfig(config, m),
    (m) => appendTransactionMessageInstructions(body.map(toKit), m),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

/** A version 1 wire read back: what the checks compare. */
export interface V1Wire {
  payer: PublicKey;
  /** Empty when the lifetime is not a blockhash. */
  blockhash: string;
  /** A field the message does not set reads as 0: that is what the runtime makes of it. */
  config: TxConfig;
  instructions: TransactionInstruction[];
  /** Every account that must sign, the payer first. */
  signers: PublicKey[];
  messageBytes: Uint8Array;
  /** Signature bytes by signer address; null where that signer has not signed. */
  signatures: ReadonlyMap<string, Uint8Array | null>;
}

/** Throws when the bytes are not a version 1 transaction. */
export function decodeV1(wire: Uint8Array): V1Wire {
  const tx = getTransactionDecoder().decode(wire);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (compiled.version !== 1) throw new Error(`not a version 1 transaction (version ${String(compiled.version)})`);
  const message = decompileTransactionMessage(compiled);
  const c = message.config;
  return {
    payer: new PublicKey(message.feePayer.address),
    blockhash: 'blockhash' in message.lifetimeConstraint ? String(message.lifetimeConstraint.blockhash) : '',
    config: {
      computeUnitLimit: c?.computeUnitLimit ?? 0,
      loadedAccountsDataSizeLimit: c?.loadedAccountsDataSizeLimit ?? 0,
      priorityFeeLamports: c?.priorityFeeLamports ?? 0n,
    },
    instructions: message.instructions.map(fromKit),
    signers: compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts).map((a) => new PublicKey(a)),
    messageBytes: new Uint8Array(tx.messageBytes),
    signatures: new Map(Object.entries(tx.signatures).map(([who, sig]) => [who, sig ? new Uint8Array(sig) : null])),
  };
}

/** Our own keypairs (the mint on create, the pool on lp-create) sign the message AFTER the wallet. */
export function signV1WithKeypairs(wire: Uint8Array, keypairs: readonly Keypair[]): Uint8Array {
  if (keypairs.length === 0) return wire;
  const tx = getTransactionDecoder().decode(wire);
  const signatures: Record<string, Uint8Array | null> = { ...(tx.signatures as Record<string, Uint8Array | null>) };
  for (const kp of keypairs) {
    const who = kp.publicKey.toBase58();
    if (!(who in signatures)) throw new Error(`${who} is not a signer of this transaction`);
    signatures[who] = ed25519.sign(new Uint8Array(tx.messageBytes), kp.secretKey.slice(0, 32));
  }
  return new Uint8Array(getTransactionEncoder().encode({ messageBytes: tx.messageBytes, signatures } as unknown as KitTransaction));
}

/** Every required signer has signed the message, and each signature checks out. */
export function verifyV1Signatures(w: V1Wire): boolean {
  for (const s of w.signers) {
    const sig = w.signatures.get(s.toBase58());
    if (!sig || sig.length !== 64) return false;
    try {
      if (!ed25519.verify(sig, w.messageBytes, s.toBytes())) return false;
    } catch {
      return false;
    }
  }
  return true;
}
