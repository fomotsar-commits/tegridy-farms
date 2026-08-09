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
import { assertMayLaunch } from '../../heat/launchGate';

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
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const st = value[0];
      if (st) {
        if (st.err) throw new LaunchFailedOnChain(signature);
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
      }
    } catch (e) {
      // A DEFINITIVE outcome must propagate; a transport blip must not.
      if (e instanceof LaunchFailedOnChain) throw e;
      // Swallow and keep polling. This is the load-bearing line in the module.
      //
      // The transaction is ALREADY BROADCAST by the time we poll, so letting an RPC
      // error escape here would surface a landed transaction as a generic failure —
      // and the caller, correctly, treats generic failures as "never submitted".
      // A user would then be told in writing that nothing happened, for a token that
      // exists on mainnet, with the signature discarded.
      //
      // This is not hypothetical on this stack: /api/solrpc rewrites ANY non-ok
      // upstream status to 502 (frontend/api/solrpc.js), and web3.js retries 429 but
      // NOT 502 — so the single most likely transient failure lands right here. The
      // loop deadline is the real timeout; one bad poll is not an answer.
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

/**
 * The transaction landed and FAILED on-chain. Definitive, and it carries the
 * signature because "it failed" is not the same as "it never happened": the mint
 * account may now be initialized, so the same keypair cannot be reused, and the
 * user is owed the signature to see why.
 */
export class LaunchFailedOnChain extends Error {
  readonly signature: string;
  constructor(signature: string) {
    super('The launch transaction was submitted but failed on-chain.');
    this.name = 'LaunchFailedOnChain';
    this.signature = signature;
  }
}

/** True for every error that means the transaction REACHED the network. */
export function wasBroadcast(err: unknown): err is ConfirmationTimeout | LaunchFailedOnChain {
  return err instanceof ConfirmationTimeout || err instanceof LaunchFailedOnChain;
}

/** The wallet-adapter surface this module needs — kept minimal so tests can fake it. */
export type SendTransaction = (tx: Transaction, connection: Connection) => Promise<string>;

export interface SubmitLaunchInput {
  connection: Connection;
  sendTransaction: SendTransaction;
  /** The connected wallet: pays fees, and is the pool creator. */
  walletAddress: string;
  /**
   * The address the island measures for the launch gate.
   *
   * An ETHEREUM address, and separate from `walletAddress` on purpose: the island's
   * measured registry is Base + Ethereum tokens, so the Solana pubkey that pays for
   * this launch has no standing to read. "EVM address is the qualifying identity today;
   * SOL linking rides the island's multiwallet rail when it ships" (gate spec §3). When
   * that rail ships, this can collapse back into `walletAddress` — until then, passing
   * the Solana key here would deny every Solana launcher for the wrong reason.
   */
  heatIdentity: string;
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
  /**
   * Called the instant the transaction is broadcast, before confirmation begins.
   *
   * Not a convenience. Without it the UI cannot tell "waiting for the user to
   * approve" from "approved, broadcast, waiting on chain", so it keeps saying
   * "confirm in your wallet" for the whole confirmation window — which is exactly
   * what makes someone reload the page. A reload destroys the in-memory mint
   * keypair, and the next attempt generates a NEW one, so a launch that had already
   * landed becomes a genuine second token. Surfacing the signature the moment it
   * exists is what makes that window survivable.
   */
  onBroadcast?: (signature: string) => void;
}

export interface SubmitLaunchResult {
  signature: string;
  /** The launched token's mint address. */
  mint: string;
  /**
   * `gate_decision_id` — the Heat gate audit row that permitted this launch, carried on
   * the birth notify. Null when the local audit store was unavailable; never a blocker.
   */
  gateDecisionId: string | null;
}

/**
 * Build → sign → broadcast → confirm a launch, returning the mint and signature.
 *
 * CONTRACT: a thrown `ConfirmationTimeout` means the transaction WAS broadcast.
 * Callers must not treat it as "nothing happened" and must not auto-retry.
 */
export async function submitLaunch(input: SubmitLaunchInput): Promise<SubmitLaunchResult> {
  // THE SEEDLING GATE, FIRST — above the descriptor build, above the SDK, and far above
  // `sendTransaction`.
  //
  // Position is the whole point. `HeatGateDenied` is a plain Error subclass ON PURPOSE,
  // so `wasBroadcast()` reads false and the refusal reports "nothing was submitted" —
  // which is literally true from up here. Below `sendTransaction` the same throw would
  // be indistinguishable from a landed transaction that failed, and the caller would
  // tell someone in writing that nothing happened for a token that exists on mainnet.
  // Never move this line down, and never give the denial a `signature`.
  //
  // `heatIdentity` and not `walletAddress`: an Ethereum address is the qualifying
  // identity today (gate spec §3) — the island's registry measures Base and Ethereum
  // tokens, so a Solana pubkey reads cold for reasons that are about the island's
  // multiwallet rail not shipping yet, not about the launcher.
  //
  // An ABSENT identity gets its own message rather than being handed to the oracle as
  // an empty string: "the instrument is unreachable" would be a lie about the island
  // when the truth is that we have nothing to ask about. Still a plain Error, still
  // above every side effect, so it is still provably "never submitted".
  if (!input.heatIdentity) {
    throw new Error(
      'Connect the Ethereum wallet that carries your standing on Jungle Bay Island. An Ethereum address is the qualifying identity for the launch gate today — Solana linking rides the island’s multiwallet rail when it ships.',
    );
  }
  const gateRow = await assertMayLaunch(input.heatIdentity);

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
  // From here on, EVERY exit carries the signature: ConfirmationTimeout or
  // LaunchFailedOnChain. No path past this line may throw a plain Error, because a
  // plain Error is how the caller identifies "never submitted".
  input.onBroadcast?.(signature);
  await confirmSignature(input.connection, signature, input.confirmTimeoutMs);
  return { signature, mint, gateDecisionId: gateRow?.id ?? null };
}
