// The contract between the write layer and the page that drives it.
//
// Everything a page needs to offer a launch, a trade, a graduation, a reserve
// release or a pool swap passes through these types, and every one of them keeps
// three answers apart that this repo has collapsed before:
//
//   - we READ it and the answer is no,
//   - we READ it and the answer is yes,
//   - we COULD NOT READ it.
//
// And for a transaction, the four answers a person must never confuse:
//
//   - confirmed: it landed and did what the review said;
//   - reverted: it landed and the program refused it (nothing moved but the fee);
//   - expired: it can no longer land, so trying again is safe;
//   - unknown: it was sent and we could not find out. NEVER shown as "failed",
//     because a person told "failed" presses the button again and pays twice.
//
// There is no React here and there must not be.

import type { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import type { GlobalConfig } from '../curve/program';
import type { CurveBuyQuote, SellQuote } from '../curve/math';
import type { AmmConfigView } from '../../../solana/cpswap/program';
import type { OwnPoolQuote } from '../../../solana/cpswap/read';

export type SolanaCluster = 'mainnet' | 'devnet' | 'localnet';

/** Which programs the write path talks to, and on which cluster. */
export interface CurveWriteConfig {
  programId: PublicKey;
  cpSwapProgram: PublicKey;
  cluster: SolanaCluster;
}

/** Why the write path is configured but closed. Each renders its own sentence. */
export type GateBlock =
  | 'wrong-cluster'
  | 'launch-program-missing'
  | 'cpswap-program-missing'
  | 'protocol-not-initialized'
  | 'venue-mismatch'
  | 'venue-not-configured'
  | 'unreadable';

/**
 * The two cp-swap prerequisites a graduation needs that are NOT in `global`.
 * `null` = could not read, which is not the same as "missing".
 */
export interface GraduationReadiness {
  /** cp-swap's permission PDA for the launch program's migration authority. */
  permission: boolean | null;
  /** cp-swap's hard-coded create-pool-fee WSOL account. */
  createPoolFeeReceiver: boolean | null;
}

export type WriteGate =
  /** No write configuration at all: today's read-only page. */
  | { kind: 'off' }
  | { kind: 'blocked'; reason: GateBlock; detail: string }
  | {
      kind: 'open';
      cfg: CurveWriteConfig;
      global: GlobalConfig;
      ammConfig: AmmConfigView;
      ammConfigAddress: PublicKey;
      /** `global.paused`. Create, buy and graduate stop; sell, release and pool swaps do not. */
      paused: boolean;
      graduation: GraduationReadiness;
    };

export type OpenGate = Extract<WriteGate, { kind: 'open' }>;

export interface ActionAvailability {
  create: boolean;
  buy: boolean;
  sell: boolean;
  migrate: boolean;
  release: boolean;
  poolSwap: boolean;
}

export type TxKind = 'create' | 'buy' | 'sell' | 'migrate' | 'release' | 'pool-buy' | 'pool-sell';

/**
 * One instruction of the FINAL transaction, decoded back out of its bytes.
 *
 * The review screen is built from these, not from the values the builder was
 * handed, so what a person reads is what the transaction actually encodes. If an
 * instruction cannot be decoded into one of these shapes the transaction is
 * refused before any wallet sees it (see `intent.ts`).
 */
export type IntentStep =
  | { kind: 'compute-limit'; units: number }
  | { kind: 'compute-price'; microLamports: bigint }
  | { kind: 'create-mint-account'; mint: PublicKey; lamports: bigint }
  | { kind: 'init-mint'; mint: PublicKey; decimals: number }
  | { kind: 'create-metadata'; mint: PublicKey; name: string; symbol: string; uri: string }
  | { kind: 'create-launch'; mint: PublicKey }
  | { kind: 'create-token-account'; owner: PublicKey; mint: PublicKey; address: PublicKey }
  | {
      kind: 'curve-buy';
      mint: PublicKey;
      maxLamportsIn: bigint;
      minTokensOut: bigint;
      creator: PublicKey;
      feeRecipient: PublicKey;
    }
  | {
      kind: 'curve-sell';
      mint: PublicKey;
      tokensIn: bigint;
      minLamportsOut: bigint;
      creator: PublicKey;
      feeRecipient: PublicKey;
    }
  | { kind: 'migrate'; mint: PublicKey; pool: PublicKey; creator: PublicKey; feeRecipient: PublicKey }
  | { kind: 'release'; mint: PublicKey; recipient: PublicKey }
  | { kind: 'wrap-sol'; lamports: bigint }
  | { kind: 'sync-wsol' }
  | {
      kind: 'pool-swap';
      pool: PublicKey;
      inputMint: PublicKey;
      outputMint: PublicKey;
      amountIn: bigint;
      minimumAmountOut: bigint;
    }
  | { kind: 'close-wsol' };

export type TxSummary =
  | {
      kind: 'create';
      mint: PublicKey;
      creator: PublicKey;
      name: string;
      symbol: string;
      uri: string;
      decimals: 6;
      /**
       * The creator's own first buy, in the same transaction. `minTokensOut` equals
       * the quote EXACTLY: nothing can trade between `create_launch` and this buy,
       * so there is no slippage to allow for.
       */
      openingBuy: { maxLamportsIn: bigint; minTokensOut: bigint; quote: CurveBuyQuote } | null;
    }
  | {
      kind: 'buy';
      mint: PublicKey;
      /** What the signed instruction lets the program take: the most this buy can cost. */
      maxLamportsIn: bigint;
      /** The amount the person typed. Above `maxLamportsIn` only when the buy fills the curve. */
      requestedLamports: bigint;
      minTokensOut: bigint;
      quote: CurveBuyQuote;
      /** The buy reaches the curve's ceiling, so `maxLamportsIn` is capped at what the curve can take, below `requestedLamports`. */
      fillsCurve: boolean;
      /** `null` when it could not be computed; never shown as 0. */
      priceImpactBps: bigint | null;
      /** How the fee inside `quote.feeLamports` is meant to split. Either leg can be folded or waived on chain (see `feeSplit`). */
      feeSplit: FeeSplitView;
    }
  | {
      kind: 'sell';
      mint: PublicKey;
      tokensIn: bigint;
      minLamportsOut: bigint;
      quote: SellQuote;
      /** `null` when it could not be computed; never shown as 0. */
      priceImpactBps: bigint | null;
      feeSplit: FeeSplitView;
    }
  | { kind: 'migrate'; mint: PublicKey; pool: PublicKey }
  | { kind: 'release'; mint: PublicKey; amount: bigint; recipient: PublicKey }
  | {
      kind: 'pool-buy' | 'pool-sell';
      mint: PublicKey;
      pool: PublicKey;
      amountIn: bigint;
      minimumAmountOut: bigint;
      quote: OwnPoolQuote;
      /** True when the transaction closes the wrapped-SOL account, so SOL comes back as plain SOL. */
      unwrapsWsol: boolean;
    };

/**
 * The trade fee's SCHEDULED split. The program pays the creator's share to the
 * creator and the rest to the fee recipient, EXCEPT that a leg which would leave
 * its receiver below rent is folded (creator into platform) or waived (platform,
 * never charged to the trader). So `creator` is the most the creator can receive,
 * but `platform` is NOT a ceiling: with the creator leg folded, the platform can
 * receive all of `total`. The trader never pays more than `total`.
 */
export interface FeeSplitView {
  total: bigint;
  creator: bigint;
  platform: bigint;
}

/**
 * What the simulation of the FINAL transaction says happens to the signer's own
 * balances. Shown on the review screen and checked against the summary: if these
 * disagree with what the screen says, the action is blocked.
 */
export interface SimulatedEffect {
  /** Change in the signer's SOL balance, in lamports (negative = leaves the wallet). */
  signerLamportsDelta: bigint;
  /** Change in each of the signer's token accounts this transaction touches. */
  tokenDeltas: Array<{ mint: PublicKey; account: PublicKey; delta: bigint }>;
}

export interface PreparedTx {
  kind: TxKind;
  /** Legacy transaction: fee payer = the wallet, blockhash and compute budget set. */
  tx: Transaction;
  /** `create`: the fresh mint keypair (kept in memory only). Everything else: none. */
  extraSigners: Keypair[];
  blockhash: string;
  lastValidBlockHeight: number;
  /** Serialized size in bytes (Solana's limit is 1,232). */
  sizeBytes: number;
  simulation: { unitsConsumed: number; logs: string[] };
  fees: {
    /** 5,000 lamports per signature. */
    baseLamports: bigint;
    priorityLamports: bigint;
    /** False when the recent-fee read failed and the priority price was set to 0. Say so on screen. */
    priorityFeeRead: boolean;
    /** Rent for accounts this transaction creates that we know the size of. Most comes back only if they are closed. */
    newAccountRentLamports: bigint;
  };
  /** The final transaction's instructions, decoded back out of its bytes. */
  steps: IntentStep[];
  simulated: SimulatedEffect;
  summary: TxSummary;
  /** Internal: what `submitPrepared` re-checks if the wallet hands back a different message. Do not render. */
  check: PreparedCheck;
}

/** Opaque to the page. Carried so the post-signature check reuses the pre-signature rules. */
export interface PreparedCheck {
  intent: IntentContext;
  expect: Expectation;
  /** Instructions after the two compute-budget ones, exactly as built. */
  body: Array<{ programId: string; keys: Array<[string, boolean, boolean]>; data: string }>;
  /** Signer + token accounts whose post-simulation state is compared with the summary. */
  watch: WatchList;
  /** Their balances before, read while preparing. */
  pre: PreState;
}

/** What was on chain before the transaction, for the accounts the check watches. */
export interface PreState {
  signerLamports: bigint;
  tokens: Map<string, { exists: boolean; amount: bigint }>;
}

/** What `intent.ts` needs to judge a transaction for one signer. */
export interface IntentContext {
  signer: PublicKey;
  cfg: CurveWriteConfig;
  /** Read off the decoded global, never guessed. */
  feeRecipient: PublicKey;
  ammConfig: PublicKey;
  /** For curve trades: `curve.creator`, read off the decoded curve. */
  creator?: PublicKey;
  /** The launch mint this transaction is about. */
  mint: PublicKey;
  /** The most priority fee this transaction may carry, in lamports. */
  maxPriorityLamports: bigint;
}

/**
 * Bounds the simulated balance change must fall inside. Network fees (base +
 * priority) are added to `maxSolOut` by the checker, so a simulator that does or
 * does not deduct them both pass.
 */
export interface Expectation {
  /** The most SOL the signer may lose, excluding network fees. */
  maxSolOut: bigint;
  /** For sells: the least SOL the signer must gain, before network fees. */
  minSolIn?: bigint;
  tokens: Array<{ account: PublicKey; mint: PublicKey; minDelta: bigint; maxDelta: bigint }>;
}

export interface WatchList {
  signer: PublicKey;
  tokenAccounts: Array<{ account: PublicKey; mint: PublicKey }>;
}

export type NotSent = {
  status: 'not-sent';
  stage: 'build' | 'simulate' | 'sign' | 'send';
  message: string;
  logs?: string[];
};

export type TxOutcome =
  | { status: 'confirmed'; signature: string; slot: number | null }
  | {
      status: 'reverted';
      signature: string;
      program: 'launch' | 'cp-swap' | 'other';
      code: number | null;
      message: string;
    }
  /** The blockhash ran out and the network has no record of it. Nothing happened; trying again is safe. */
  | { status: 'expired'; signature: string; message: string }
  /** Sent, not confirmed. NEVER render as failed. */
  | { status: 'unknown'; signature: string; message: string }
  | NotSent;

export type Prepared = { ok: true; prepared: PreparedTx } | { ok: false; outcome: NotSent };

/** The one wallet capability the write path uses. It never asks a wallet to broadcast. */
export interface TxSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
}

export type WriteRpc = Pick<
  Connection,
  | 'getLatestBlockhash'
  | 'simulateTransaction'
  | 'sendRawTransaction'
  | 'getSignatureStatuses'
  | 'getTransaction'
  | 'getRecentPrioritizationFees'
  | 'getAccountInfo'
  | 'getMinimumBalanceForRentExemption'
  | 'getMultipleAccountsInfo'
  | 'getBlockHeight'
  | 'getSlot'
>;

export interface SubmitDeps {
  /**
   * Called once the signature is known and BEFORE the first send, with the
   * transaction's blockhash window. From that moment it may land even if the page
   * goes away, so this is where a page writes the note that survives a reload.
   */
  onSent?: (signature: string, lastValidBlockHeight: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Hard ceiling on how long to keep watching, whatever the block height says. */
  timeoutMs?: number;
  /** How often to re-send and re-check. */
  intervalMs?: number;
}
