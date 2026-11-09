// A trip as a version 1 transaction (SIMD-0385), for the trips that do not fit in a legacy
// one: 1,232 bytes then, 4,096 now. Three swaps through two PumpSwap pools name 43 accounts
// (SOL > BOBO > GRR > SOL, 11-08: $5.45 of distinct gaps in 24 h), which no legacy or v0
// message holds without a lookup table of those pools' own accounts; as version 1 the same
// trip is 1,671 bytes, and mainnet ran it (read-only test run 2026-11-09). Built with
// @solana/kit as the site builds its own (frontend/src/lib/launcher/solana/write/v1.ts):
// web3.js 1.98 can neither build nor read the format.
//
// A version 1 message carries its budget in its CONFIG, not as instructions: the compute-unit
// limit, the loaded-accounts-data limit (unset means 0, and the transaction fails) and the whole
// priority fee in lamports. A ComputeBudget instruction inside one would be ignored, so none is
// kept. There are no lookup tables: every account is named in the message.

import { ed25519 } from '@noble/curves/ed25519';
import { ComputeBudgetProgram, type Keypair, type TransactionInstruction, type PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
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

/** Solana's size limit for a legacy or v0 transaction. */
export const LEGACY_TX_SIZE_LIMIT = 1232;

/** Solana's size limit for a version 1 transaction. */
export const V1_TX_SIZE_LIMIT = 4_096;

/** 64 MiB: what a legacy transaction may load by default; a test run asks for it. */
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/** Loaded account data is charged in 32 KiB pages. */
const LOADED_DATA_PAGE = 32 * 1024;

/** A trip built as a version 1 transaction: its wire bytes, unsigned until `signV1`. */
export interface V1Tx {
  version: 1;
  wire: Uint8Array;
}

/** A trip as the send step carries it: a v0 transaction (web3.js), or a version 1 one. */
export type TripTx = VersionedTransaction | V1Tx;

export const isV1 = (t: TripTx): t is V1Tx => !(t instanceof VersionedTransaction) && (t as V1Tx).version === 1;

/** The budget a version 1 message carries in place of ComputeBudget instructions. */
export interface V1Config {
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  priorityFeeLamports: bigint;
}

/**
 * The config for `units` at `microLamports` a unit, the priority fee a legacy trip pays for the
 * same (units × price / 1,000,000, rounded up). `loaded`: what a test run loaded, plus a quarter
 * in whole 32 KiB pages; without it, the legacy default, 64 MiB. Never 0.
 */
export function v1Config(units: number, microLamports: number, loaded?: number): V1Config {
  const limit =
    typeof loaded === 'number' && Number.isFinite(loaded) && loaded > 0
      ? Math.min(Math.max(1, Math.ceil((loaded * 1.25) / LOADED_DATA_PAGE)) * LOADED_DATA_PAGE, MAX_LOADED_ACCOUNTS_DATA_SIZE)
      : MAX_LOADED_ACCOUNTS_DATA_SIZE;
  return { computeUnitLimit: units, loadedAccountsDataSizeLimit: limit, priorityFeeLamports: BigInt(Math.ceil((units * microLamports) / 1_000_000)) };
}

const roleOf = (k: { isSigner: boolean; isWritable: boolean }): AccountRole =>
  k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;

const toKit = (ix: TransactionInstruction): Instruction => ({
  programAddress: address(ix.programId.toBase58()),
  accounts: ix.keys.map((k) => ({ address: address(k.pubkey.toBase58()), role: roleOf(k) })),
  data: new Uint8Array(ix.data),
});

/** The unsigned version 1 trip: `instructions` less any ComputeBudget one, the budget in `config`. */
export function assembleV1(payer: PublicKey, blockhash: string, lastValidBlockHeight: number, config: V1Config, instructions: readonly TransactionInstruction[]): V1Tx {
  const budget = ComputeBudgetProgram.programId;
  const body = instructions.filter((ix) => !ix.programId.equals(budget));
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(address(payer.toBase58()), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, m),
    (m) => setTransactionMessageConfig(config, m),
    (m) => appendTransactionMessageInstructions(body.map(toKit), m),
  );
  return { version: 1, wire: new Uint8Array(getTransactionEncoder().encode(compileTransaction(message))) };
}

/** Whether a v0 transaction serializes within the legacy limit (web3.js throws past it). */
export function fitsLegacy(tx: VersionedTransaction): boolean {
  try {
    return tx.serialize().length <= LEGACY_TX_SIZE_LIMIT;
  } catch {
    return false;
  }
}

/** The trip signed by the keeper's key, and its signature as the chain names it (base58). */
export function signV1(t: V1Tx, key: Keypair): { wire: Uint8Array; signature: string } {
  const tx = getTransactionDecoder().decode(t.wire);
  const who = key.publicKey.toBase58();
  const signatures: Record<string, Uint8Array | null> = { ...(tx.signatures as Record<string, Uint8Array | null>) };
  if (!(who in signatures)) throw new Error(`${who} is not a signer of this trip`);
  const sig = ed25519.sign(new Uint8Array(tx.messageBytes), key.secretKey.slice(0, 32));
  signatures[who] = sig;
  const wire = new Uint8Array(getTransactionEncoder().encode({ messageBytes: tx.messageBytes, signatures } as unknown as KitTransaction));
  return { wire, signature: getBase58Decoder().decode(sig) };
}
