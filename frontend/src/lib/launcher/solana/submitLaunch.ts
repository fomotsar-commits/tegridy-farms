// Browser submit seam for the Solana launch rail.
//
// Everything up to here was preview-only: the pure builders in `dbc.ts` produced
// descriptors and the page rendered them. This module is the one place that turns
// a descriptor into a transaction a member of the public signs and broadcasts.
//
// ## Why this reuses `dbcClient.launchToken` instead of calling the SDK directly
//
// `launchToken` already does the two things that are easy to get wrong: it asserts
// the base-mint keypair matches the descriptor's `baseMint` (so a mismatched pair
// can never be sent), and `prepareAndSign` sets `feePayer` + `recentBlockhash` +
// `lastValidBlockHeight` and refuses to hand back a transaction whose blockhash
// came back empty. Re-implementing that here would duplicate the parts most worth
// not duplicating.
//
// `dbcClient.ts` is documented as the NODE-only operator wrapper. Importing it in
// the browser is safe and deliberate: the node-only hazard is `squads.ts`'s
// `findProgramAddressSync` (stubbed in web3.js's browser build), which lives INSIDE
// `deriveSquadsVaultPda`/`verifySquadsVault` — functions `launchToken` never calls.
// squads.ts's module top level is only constants. Do NOT reach for
// `createPartnerConfig` or `claimPartnerFees` from a browser context: those DO
// verify vault PDAs and will break.
//
// ## What we deliberately do NOT do here
//
// No config creation. A launch goes against the operator's EXISTING partner config,
// whose address is build-time configuration and never user input — see
// `resolveLaunchConfig`. Letting a caller name the config would let them point a
// launch at a config whose feeClaimer is theirs, using our brand as the wrapper.

import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { launchToken } from './dbcClient';
import { buildLaunchParams, type DbcLaunchParams } from './dbc';

/** Commitment used for the client and for confirmation. */
const COMMITMENT = 'confirmed' as const;

/**
 * Poll a signature to confirmation.
 *
 * Deliberately polls `getSignatureStatuses` rather than opening a WS subscription,
 * matching the Solana swap page: the RPC proxy only needs an https CSP entry, not
 * wss, and `getSignatureStatuses` is on `/api/solrpc`'s method allowlist while a
 * socket is not proxied at all.
 *
 * NOTE: `SolanaSwapPage` carries a private, identical copy of this loop. They should
 * become one helper the next time that page is touched for another reason; it is not
 * worth destabilising a live trading surface for a de-duplication alone.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 90_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st) {
      if (st.err) throw new Error('The launch transaction failed on-chain.');
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // NOT an error we can treat as "did not happen" — see submitLaunch's contract.
  throw new ConfirmationTimeout(signature);
}

/**
 * Thrown when the transaction was BROADCAST but not confirmed inside the window.
 *
 * A distinct type because the correct UI response is the opposite of a normal
 * failure: the launch may well have landed, so the caller must NOT invite a retry
 * that would mint a second token. The EVM rail shipped exactly that bug — a
 * receipt-wait timeout re-enabled the launch button and could double-launch
 * (fixed in #125). Carrying the signature lets the UI send the user to an explorer
 * instead of guessing.
 */
export class ConfirmationTimeout extends Error {
  readonly signature: string;
  constructor(signature: string) {
    super('Broadcast, but not confirmed in time. Check the transaction before retrying — it may have succeeded.');
    this.name = 'ConfirmationTimeout';
    this.signature = signature;
  }
}

/** The wallet-adapter surface this module needs — kept minimal so tests can fake it. */
export type SendTransaction = (tx: Transaction, connection: Connection) => Promise<string>;

export interface SubmitLaunchInput {
  connection: Connection;
  sendTransaction: SendTransaction;
  /** The connected wallet: pays fees, and is the pool creator. */
  walletAddress: string;
  /** Operator's existing partner config. Build-time configuration, never user input. */
  config: string;
  /**
   * The token's mint account, which must co-sign creation.
   *
   * MUST be stable across retries of the same attempt. Generating a fresh one per
   * click turns a retry into a second, different token — the same class of defect
   * as the EVM double-launch. The caller owns this lifetime; see the page's ref.
   */
  mintKeypair: Keypair;
  name: string;
  symbol: string;
  uri: string;
  /**
   * How long to poll for confirmation before giving up, in ms. Defaults to 90s.
   *
   * Injectable because it is the one knob a caller legitimately needs: tests cannot
   * wait 90 seconds to exercise the stranded path, and that path is the most
   * important one in this module to have covered.
   */
  confirmTimeoutMs?: number;
}

export interface SubmitLaunchResult {
  signature: string;
  /** The launched token's mint address. */
  mint: string;
}

/**
 * Build → sign → broadcast → confirm a launch, returning the mint and signature.
 *
 * CONTRACT: a thrown `ConfirmationTimeout` means the transaction WAS broadcast.
 * Callers must not treat it as "nothing happened" and must not auto-retry.
 */
export async function submitLaunch(input: SubmitLaunchInput): Promise<SubmitLaunchResult> {
  const mint = input.mintKeypair.publicKey.toBase58();

  const params: DbcLaunchParams = buildLaunchParams(
    {
      config: input.config,
      baseMint: mint,
      poolCreator: input.walletAddress,
      payer: input.walletAddress,
    },
    { name: input.name, symbol: input.symbol, uri: input.uri },
  );

  const client = await DynamicBondingCurveClient.create(input.connection, COMMITMENT);

  // `signer: undefined` on purpose. `launchToken` then partial-signs ONLY the mint
  // keypair and returns the transaction with feePayer + blockhash already set; the
  // wallet adapter's `sendTransaction` adds the wallet's signature and broadcasts.
  // Passing a signer here instead would sign twice and buy nothing.
  const tx = await launchToken(client, params, undefined, input.mintKeypair);

  const signature = await input.sendTransaction(tx, input.connection);
  await confirmSignature(input.connection, signature, input.confirmTimeoutMs);
  return { signature, mint };
}
