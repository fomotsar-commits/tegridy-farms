// The contract between the write layer and the page that drives it.
//
// Everything a page needs to offer a launch, a trade, a graduation, a pool
// swap or a liquidity change passes through these types, and every one of them keeps
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
import type { PriceCheck } from '../../../solana/lp/poolHealth';
import type { SafetyReason } from '../../../solana/lp/tokenSafety';

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
      /** `global.paused`. Create, buy and graduate stop; sell and pool swaps do not. */
      paused: boolean;
      graduation: GraduationReadiness;
    };

export type OpenGate = Extract<WriteGate, { kind: 'open' }>;

/**
 * Whether adding or removing liquidity may be offered. Read from the cluster and the
 * pool program only: never the launch program, `global` or a fee tier, so nothing
 * about the launch program can close the way out of a pool (spec D2).
 */
export type LpGate =
  /** LP's own switch is off, or there is no write configuration. */
  | { kind: 'off' }
  | { kind: 'blocked'; reason: GateBlock; detail: string }
  /** `mode` 'withdraw-only': removing works, adding is paused. */
  | { kind: 'open'; cfg: CurveWriteConfig; mode: 'on' | 'withdraw-only' };

export type LpOpenGate = Extract<LpGate, { kind: 'open' }>;

/** The public fee tier's terms a person is shown before opening a pool, and that prepare re-checks. */
export type TierTerms = Pick<AmmConfigView, 'createPoolFee' | 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate' | 'creatorFeeRate'>;

/**
 * The public fee tier (tier 1), as read for opening a pool. Separate from `LpGate`:
 * nothing here can close or open adding and removing liquidity (spec N3).
 */
export type TierState =
  | { kind: 'ready'; address: PublicKey; config: AmmConfigView }
  /** No account there: the vault has not created the tier yet. */
  | { kind: 'not-open'; address: PublicKey }
  /** The tier's `disable_create_pool` is on. */
  | { kind: 'switched-off'; address: PublicKey; config: AmmConfigView }
  /** Its fee to open is above this site's ceiling. */
  | { kind: 'fee-too-high'; address: PublicKey; config: AmmConfigView; limit: bigint }
  /** Something is there, but not the pool program's tier 1 (wrong owner, undecodable, another index). */
  | { kind: 'not-a-tier'; address: PublicKey; detail: string }
  | { kind: 'unread'; address: PublicKey; detail: string };

/** The pool program's fee account for openings: it must be a native wrapped-SOL account, or every opening fails. */
export type FeeAccountState =
  | { kind: 'ready' }
  | { kind: 'missing' }
  | { kind: 'not-wsol'; detail: string }
  | { kind: 'unread'; detail: string };

export interface CreateFacts {
  tier: TierState;
  feeAccount: FeeAccountState;
}

export interface ActionAvailability {
  create: boolean;
  buy: boolean;
  sell: boolean;
  migrate: boolean;
  poolSwap: boolean;
}

/** Adding and removing liquidity in one of our cp-swap pools, and opening a new one. */
export type LpKind = 'lp-deposit' | 'lp-withdraw' | 'lp-create';

export type TxKind = 'create' | 'buy' | 'sell' | 'migrate' | 'pool-buy' | 'pool-sell' | LpKind;

/**
 * What a watched token account is, so the review can name it and print it in its
 * own mint's decimals. `treasury` is the platform treasury's account (create: the
 * reserve arriving); `workshop` is the island Workshop's $BAYLA account (create: the
 * plant's half); the rest are the signer's own. No role = the signer's token.
 */
export type TokenRole = 'treasury' | 'workshop' | 'lp' | 'wsol' | 'token';

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
  | {
      kind: 'create-launch';
      mint: PublicKey;
      /** Receives the platform reserve inside the instruction: `global.fee_recipient`, read from chain. */
      feeRecipient: PublicKey;
      /** Its token account for this mint, where the reserve lands (created by the creator if missing). */
      treasuryToken: PublicKey;
    }
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
  | { kind: 'close-wsol' }
  /** The plant, half 1: $BAYLA burned from the signer's own $BAYLA account (create only). */
  | { kind: 'plant-burn'; account: PublicKey; mint: PublicKey; amount: bigint }
  /** The plant, half 2: $BAYLA sent from that account to the island's Workshop (create only). */
  | { kind: 'plant-transfer'; from: PublicKey; to: PublicKey; mint: PublicKey; amount: bigint }
  /** cp-swap `deposit`: exactly `lpAmount` pool shares, at most `max0` / `max1` of each side. */
  | { kind: 'pool-deposit'; pool: PublicKey; lpAmount: bigint; max0: bigint; max1: bigint }
  /** cp-swap `withdraw`: `lpAmount` pool shares out of `lpAccount`, at least `min0` / `min1` back. */
  | { kind: 'pool-withdraw'; pool: PublicKey; lpAccount: PublicKey; lpAmount: bigint; min0: bigint; min1: bigint }
  /**
   * cp-swap `initialize`: open `pool` on fee tier `ammConfig` (always tier 1) with exactly
   * `init0` / `init1`. Its open time is always 0 (the decoder refuses any other), so it is
   * not carried.
   */
  | { kind: 'pool-create'; pool: PublicKey; ammConfig: PublicKey; init0: bigint; init1: bigint };

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
      /**
       * The platform reserve `create_launch` pays to the treasury in this same
       * transaction. `amount` is computed from the settings read just now, and the
       * test run must show exactly that many tokens arriving in `treasuryToken`.
       */
      platformReserve: {
        amount: bigint;
        bps: bigint;
        /** `global.fee_recipient`, read from chain. Called a multisig only when it is the known vault. */
        recipient: PublicKey;
        treasuryToken: PublicKey;
      } | null;
      /**
       * Rent the creator pays for the treasury's token account, in lamports, read from
       * the cluster (never a constant). `0n` when that account already exists.
       */
      treasuryAccountRent: bigint;
      /**
       * The plant this same transaction pays (island ruling 2), read back out of its
       * bytes: `burned` is destroyed and `toWorkshop` reaches `workshopAccount`, both
       * from `from`, the creator's own $BAYLA account. Amounts in $BAYLA base units.
       */
      plant: {
        total: bigint;
        burned: bigint;
        toWorkshop: bigint;
        from: PublicKey;
        workshopAccount: PublicKey;
        mint: PublicKey;
        decimals: 6;
      };
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
  | {
      kind: 'pool-buy' | 'pool-sell';
      mint: PublicKey;
      pool: PublicKey;
      amountIn: bigint;
      minimumAmountOut: bigint;
      quote: OwnPoolQuote;
      /** True when the transaction closes the wrapped-SOL account, so SOL comes back as plain SOL. */
      unwrapsWsol: boolean;
    }
  | LpDepositSummary
  | LpWithdrawSummary
  | LpCreateSummary;

/**
 * Adding liquidity, as the review shows it. Every amount comes from the prepared
 * transaction: `max` is decoded from its bytes, `quoted` is the cost worked out from
 * the fresh read it was built on.
 */
export interface LpDepositSummary {
  kind: 'lp-deposit';
  pool: PublicKey;
  origin: PoolPins['origin'];
  /** The pool's fee tier as read while preparing; `null` = not read (display only). */
  config: AmmConfigView | null;
  /**
   * The pool's own creator-fee switch (cp-swap `enable_creator_fee`), from the same fresh
   * read: whether a trade on it pays the tier's creator fee on top of the trade fee.
   */
  enableCreatorFee: boolean;
  tokenMint: PublicKey;
  tokenDecimals: number;
  quoteIsToken0: boolean;
  lpAmount: bigint;
  lpDecimals: number;
  /** The ceiling cost from the fresh snapshot. */
  quoted: { sol: bigint; token: bigint };
  /** Decoded from the bytes. */
  max: { sol: bigint; token: bigint };
  /** The other side's maximum was lowered to what the wallet holds. */
  limitedByBalance: 'none' | 'sol' | 'token';
  /** Display only. */
  sharePct: { before: number; after: number };
  /** The fresh price check that passed. */
  price: PriceCheck;
  tokenWarnings: SafetyReason[];
  /** True when the wrapped-SOL account is closed at the end, so unused SOL comes back as plain SOL. */
  unwrapsWsol: boolean;
  wsolHeldBefore: bigint;
  notices: string[];
}

/** Removing liquidity, as the review shows it. `min` is decoded from the bytes. */
export interface LpWithdrawSummary {
  kind: 'lp-withdraw';
  pool: PublicKey;
  origin: PoolPins['origin'];
  config: AmmConfigView | null;
  tokenMint: PublicKey;
  tokenDecimals: number;
  quoteIsToken0: boolean;
  lpAccount: PublicKey;
  lpAmount: bigint;
  lpDecimals: number;
  heldBefore: bigint;
  /** Every pool share the account held. */
  all: boolean;
  keep: bigint;
  /** The floor payout from the fresh snapshot. */
  quoted: { sol: bigint; token: bigint };
  min: { sol: bigint; token: bigint };
  tokenAccount: PublicKey;
  /** What opening the token account costs; `0n` when it exists. */
  tokenAccountRent: bigint;
  unwrapsWsol: boolean;
  notices: string[];
}

/**
 * Opening a new pool on the public fee tier, as the review shows it. Every amount comes
 * from the prepared transaction: `put` is decoded from its bytes, the rents and the fee
 * were read while preparing.
 */
export interface LpCreateSummary {
  kind: 'lp-create';
  pool: PublicKey;
  /** `standard`: the pool's standard address for tier 1. `other`: a fresh key made in this browser. */
  origin: 'standard' | 'other';
  /** Tier 1 as read while preparing. Never null: prepare refuses without it. */
  config: AmmConfigView;
  tokenMint: PublicKey;
  tokenDecimals: number;
  quoteIsToken0: boolean;
  /** Decoded from the bytes: exactly what goes in. */
  put: { sol: bigint; token: bigint };
  /** isqrt(sol·token), the pool's whole share count; `lpAmount` = supply − 100. */
  supply: bigint;
  lpAmount: bigint;
  lpDecimals: 9;
  /** What the 100 locked shares are worth at the opening amounts (display). */
  locked: { sol: bigint; token: bigint };
  createFee: bigint;
  feeReceiver: PublicKey;
  /** Read while preparing: the pool's own accounts (never returned), the opener's pool-share account (refundable). */
  rents: { neverRefunded: bigint; lpAccount: bigint };
  /** The opening check that passed: state 'agrees', against 'outside'. */
  price: PriceCheck;
  tokenWarnings: SafetyReason[];
  unwrapsWsol: boolean;
  wsolHeldBefore: bigint;
  notices: string[];
}

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
  /**
   * Change in each watched token account, with the watch entry's `role` and
   * `decimals` copied across. Without `role` it is the signer's own token;
   * `role: 'treasury'` is the platform treasury's (create: the reserve arriving), and
   * `role: 'workshop'` the island Workshop's $BAYLA account (create: the plant's half).
   */
  tokenDeltas: Array<{ mint: PublicKey; account: PublicKey; delta: bigint; role?: TokenRole; decimals?: number }>;
}

export interface PreparedTx {
  kind: TxKind;
  /** Legacy transaction: fee payer = the wallet, blockhash and compute budget set. */
  tx: Transaction;
  /**
   * `create`: the fresh mint keypair. `lp-create` on a one-off address: the new pool's
   * keypair. Memory only. Everything else: none.
   */
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
  tokens: Map<string, PreToken>;
}

/**
 * One watched token account before the transaction. `lamports` and `nativeReserve`
 * matter for wrapped SOL: a sync turns every lamport above the reserve and the
 * balance into balance, so the check needs both to know what a sync may add
 * (`syncCredit` in wsol.ts). `nativeReserve` is null for an account that is not native.
 * `exists: false` with `lamports` above 0 is an address that only holds SOL someone sent
 * it (`opened` in wsol.ts): no account yet, so no balance, but whoever opens an account
 * there pays only what is missing from its deposit (the opening's SOL row counts this).
 */
export interface PreToken {
  exists: boolean;
  amount: bigint;
  lamports: bigint;
  nativeReserve: bigint | null;
}

/**
 * What `intent.ts` needs to judge a transaction for one signer: a launch-program
 * transaction (`CurveIntent`), or adding or removing liquidity (`PoolIntent`).
 */
export type IntentContext = CurveIntent | PoolIntent;

/** A launch, a curve trade, a graduation or a launch pool's swap. Every field it had before liquidity stays required. */
export interface CurveIntent {
  /**
   * What this transaction is for. Each kind may call only its own programs: a create
   * never reaches the pool program, a curve trade never reaches Token Metadata.
   */
  kind: Exclude<TxKind, LpKind>;
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
 * One pool, as checked while preparing. Built ONLY by `poolPins()` from the
 * prepare-time read: each vault, the LP mint and the price record equal BOTH the
 * derivation from the pool address AND the pool's own recorded field. Never taken
 * from the page's copy, which can be stale or a hostile pool.
 */
export interface PoolPins {
  address: PublicKey;
  ammConfig: PublicKey;
  origin: 'launch-pool' | 'standard' | 'other';
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  token0Program: PublicKey;
  token1Program: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  lpMint: PublicKey;
  observation: PublicKey;
  /** The side that is not SOL. */
  tokenMint: PublicKey;
  tokenProgram: PublicKey;
  quoteIsToken0: boolean;
  /** Deposit: ATA(lpMint, signer, Tokenkeg). Withdraw: the pool-share account verified at prepare. */
  lpAccount: PublicKey;
}

/** Adding or removing liquidity: every account the pool instruction names is pinned by `pins`. */
export interface PoolIntent {
  kind: LpKind;
  signer: PublicKey;
  cfg: CurveWriteConfig;
  /** The most priority fee this transaction may carry, in lamports. */
  maxPriorityLamports: bigint;
  pins: PoolPins;
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
  /**
   * The signer's own token accounts, plus (create only) the treasury's and the
   * Workshop's, marked by `role`. `decimals` is that mint's, when the builder knows
   * it; the review falls back to the page's token decimals without it.
   */
  tokenAccounts: Array<{ account: PublicKey; mint: PublicKey; role?: TokenRole; decimals?: number }>;
}

export type NotSent = {
  status: 'not-sent';
  /** `gate`: the heat door refused the maker at submit (LaunchCreateForm), before any build. */
  stage: 'gate' | 'build' | 'simulate' | 'sign' | 'send';
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
