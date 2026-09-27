// Create a launch in ONE wallet signature.
//
// One transaction, in this order (the order is forced, not chosen):
//
//   1. create the mint account (82 bytes, owned by the standard token program);
//   2. initialize it: 6 decimals, mint authority = the creator, NO freeze authority
//      (`create_launch` refuses a mint with one, because it could freeze the curve's
//      vault and lock every buyer's SOL);
//   3. create the token details (name, symbol, picture link) LOCKED forever. This
//      must come before step 4, because step 4 destroys the mint authority that
//      Metaplex needs to sign;
//   4. `create_launch`: mints the whole supply, pays the platform reserve (3.69%
//      today, read from the program's settings) to the platform treasury's token
//      account, puts the rest in the curve's vault, and revokes the mint authority,
//      so no more tokens can ever be made. The treasury is `global.fee_recipient`
//      as READ FROM CHAIN just before building, and its token account for this mint
//      is created at the creator's expense when it does not exist yet (its rent is
//      read from the cluster, never a constant). A trailing read-only account
//      (`launchIndexAddress`) lets the site find launches later;
//   5. optionally, the creator's own opening buy, clearly labelled. Its minimum
//      is the quote EXACTLY: nothing can trade between step 4 and step 5 inside one
//      transaction, so there is no price movement to allow for.
//
// The fresh mint keypair signs as well, after the wallet. It lives in memory only.

import { Keypair, SystemProgram, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
} from '@solana/spl-token';
import { TOKEN_PROGRAM_ID, type GlobalConfig } from '../curve/program';
import { associatedTokenAddress, buyIx, createLaunchIx } from '../curve/ix';
import { curveSupply, quoteBuyOnCurve, type CurveTerms } from '../curve/math';
import { clipDetail, readCreateLaunchCost, readGlobal, type CreateLaunchCost, type Read } from '../curve/read';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { launchIndexAddress } from './config';
import { describeQuoteError } from './errors';
import {
  METAPLEX_TOKEN_METADATA_ID,
  createMetadataV3Ix,
  metadataPda,
  METADATA_NAME_MAX_BYTES,
  METADATA_SYMBOL_MAX_BYTES,
  METADATA_URI_MAX_BYTES,
} from './metaplex';
import { bodySteps, buildAndSimulate, confirmedReads, notSent } from './prepare';
import type { IntentStep, OpenGate, Prepared, TxSummary, WriteRpc } from './types';

export {
  METAPLEX_TOKEN_METADATA_ID,
  createMetadataV3Ix,
  metadataPda,
  METADATA_NAME_MAX_BYTES,
  METADATA_SYMBOL_MAX_BYTES,
  METADATA_URI_MAX_BYTES,
};

export const MINT_SIZE = 82;
export const LAUNCH_DECIMALS = 6 as const;

/**
 * An allowance for what Token Metadata itself takes when it creates the details
 * account (its rent, plus any fee the Metaplex program charges). The review shows
 * the SIMULATED total, which is the real number; this only bounds the safety check.
 */
export const METADATA_COST_ALLOWANCE_LAMPORTS = 20_000_000n;

/** The curve a brand-new launch opens with, built from the global terms it will snapshot. */
export function freshCurveTerms(global: GlobalConfig): CurveTerms | null {
  const s = curveSupply(global.tokenTotalSupply, global.platformReserveBps);
  if (!s.ok) return null;
  return {
    virtualSolReserves: global.initialVirtualSol,
    virtualTokenReserves: global.initialVirtualToken,
    realSolReserves: 0n,
    realTokenReserves: s.value.curveTokens,
    tradeFeeBps: global.tradeFeeBps,
    graduationTargetLamports: global.graduationTargetLamports,
    migrationReserveLamports: global.migrationReserveLamports,
  };
}

/** Quote the creator's opening buy against the curve `create_launch` is about to open. */
export function quoteOpeningBuy(global: GlobalConfig, lamportsIn: bigint): ReturnType<typeof quoteBuyOnCurve> {
  const terms = freshCurveTerms(global);
  if (!terms) return { ok: false, error: 'Overflow' };
  return quoteBuyOnCurve(terms, lamportsIn);
}

export interface CreateLaunchInput {
  creator: PublicKey;
  mint: Keypair;
  metadata: { name: string; symbol: string; uri: string };
  /** Optional. `slippageBps` is accepted for the older contract and IGNORED: the opening buy's minimum is exact. */
  openingBuy?: { lamportsIn: bigint; slippageBps?: bigint };
}

/**
 * The create transaction's instructions, in the forced order. Pure.
 * `openingBuy` carries the exact values the buy instruction will encode.
 * `feeRecipient` MUST be `global.fee_recipient` as read from chain: the program
 * pins it, and the platform reserve is paid to its token account for this mint.
 */
export function createLaunchInstructions(
  gate: OpenGate,
  input: CreateLaunchInput,
  mintRentLamports: number,
  openingBuy: { maxLamportsIn: bigint; minTokensOut: bigint } | null,
  feeRecipient: PublicKey,
): TransactionInstruction[] {
  const { programId, cpSwapProgram } = gate.cfg;
  const creator = input.creator;
  const mint = input.mint.publicKey;

  const launchIx = createLaunchIx({ creator, mint, feeRecipient }, { programId, cpSwapProgram });
  launchIx.keys.push({ pubkey: launchIndexAddress(programId), isSigner: false, isWritable: false });

  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: creator,
      newAccountPubkey: mint,
      lamports: mintRentLamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint, LAUNCH_DECIMALS, creator, null, TOKEN_PROGRAM_ID),
    createMetadataV3Ix({
      metadata: metadataPda(mint),
      mint,
      mintAuthority: creator,
      payer: creator,
      updateAuthority: creator,
      name: input.metadata.name,
      symbol: input.metadata.symbol,
      uri: input.metadata.uri,
    }),
    launchIx,
  ];

  if (openingBuy) {
    const ata = associatedTokenAddress(mint, creator);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(creator, ata, creator, mint, TOKEN_PROGRAM_ID),
      buyIx(
        // The creator is both the trader and the curve's creator in this buy.
        { trader: creator, mint, feeRecipient, creator },
        openingBuy.maxLamportsIn,
        openingBuy.minTokensOut,
        { programId, cpSwapProgram },
      ),
    );
  }
  return ixs;
}

export const LAUNCH_TERMS_CHANGED =
  'The launch terms changed since this page loaded. Reload the page to see the new terms, then review again. Nothing was sent.';

/**
 * Every setting `create_launch` copies onto a new curve, plus where it graduates to.
 * The page showed `shown`; the launch would get `now`.
 */
export function sameLaunchTerms(shown: GlobalConfig, now: GlobalConfig): boolean {
  return (
    shown.tradeFeeBps === now.tradeFeeBps &&
    shown.creatorFeeShareBps === now.creatorFeeShareBps &&
    shown.initialVirtualSol === now.initialVirtualSol &&
    shown.initialVirtualToken === now.initialVirtualToken &&
    shown.tokenTotalSupply === now.tokenTotalSupply &&
    shown.graduationTargetLamports === now.graduationTargetLamports &&
    shown.migrationReserveLamports === now.migrationReserveLamports &&
    shown.platformReserveBps === now.platformReserveBps &&
    shown.feeRecipient.equals(now.feeRecipient) &&
    shown.cpSwapProgram.equals(now.cpSwapProgram) &&
    shown.ammConfig.equals(now.ammConfig)
  );
}

function findStep<K extends IntentStep['kind']>(steps: IntentStep[], kind: K): Extract<IntentStep, { kind: K }> | undefined {
  return steps.find((s) => s.kind === kind) as Extract<IntentStep, { kind: K }> | undefined;
}

export async function prepareCreateLaunch(rpc: WriteRpc, gate: OpenGate, input: CreateLaunchInput): Promise<Prepared> {
  if (gate.paused) return notSent('build', 'New launches are paused right now.');
  const creator = input.creator;
  const mint = input.mint.publicKey;
  if (mint.equals(creator)) return notSent('build', 'The new token address must be a fresh key.');

  // `create_launch` copies the launch terms from the program's settings AS THEY ARE
  // when it runs. The page showed `gate.global`, read when it loaded; the operator can
  // change the settings since. Read them again, and refuse if what the creator saw is
  // no longer what they would get.
  const fresh = await readGlobal(confirmedReads(rpc), gate.cfg.programId).catch(
    (e: unknown): Read<GlobalConfig> => ({ kind: 'unreadable', detail: clipDetail(e) }),
  );
  if (fresh.kind !== 'ok') {
    return notSent('build', 'Could not read the launch terms from the network just now, so nothing was built. Try again.');
  }
  if (fresh.value.paused) return notSent('build', 'New launches are paused right now.');
  if (!sameLaunchTerms(gate.global, fresh.value)) {
    return notSent('build', LAUNCH_TERMS_CHANGED);
  }
  // Who receives the platform reserve: global.fee_recipient AS READ JUST NOW. The
  // instruction, the pre-sign check and the review all use this one value.
  const feeRecipient = fresh.value.feeRecipient;
  const split = curveSupply(fresh.value.tokenTotalSupply, fresh.value.platformReserveBps);
  if (!split.ok) {
    return notSent('build', 'The launch settings are not valid, so nothing was built. This is a setup problem, not something you did.');
  }
  const reserveTokens = split.value.reserveTokens;
  const reserveBps = fresh.value.platformReserveBps;
  const treasuryToken = associatedTokenAddress(mint, feeRecipient);

  let openingBuy: { maxLamportsIn: bigint; minTokensOut: bigint } | null = null;
  let openingQuote: Extract<ReturnType<typeof quoteOpeningBuy>, { ok: true }>['value'] | null = null;
  if (input.openingBuy && input.openingBuy.lamportsIn > 0n) {
    const q = quoteOpeningBuy(gate.global, input.openingBuy.lamportsIn);
    if (!q.ok) return notSent('build', `Your opening buy: ${describeQuoteError(q.error)}`);
    openingQuote = q.value;
    // Exact: nothing trades between create_launch and this buy.
    openingBuy = { maxLamportsIn: input.openingBuy.lamportsIn, minTokensOut: q.value.tokensOut };
  }
  // The treasury's own wallet: its token account IS the treasury's token account, so
  // its opening buy and the platform reserve would land in one account, and the
  // check before signing could not tell them apart. A launch without a buy is fine.
  if (openingBuy && creator.equals(feeRecipient)) {
    return notSent(
      'build',
      'This wallet is the platform treasury, so an opening buy would land in the same token account as the platform reserve. Launch without an opening buy, then buy on the curve.',
    );
  }

  // Rent, read from the cluster: the mint, and what create_launch charges the
  // creator (the curve, its vault and, when missing, the treasury's token account).
  let mintRent: number;
  let cost: CreateLaunchCost;
  try {
    const [m, c] = await Promise.all([
      rpc.getMinimumBalanceForRentExemption(MINT_SIZE),
      readCreateLaunchCost(confirmedReads(rpc), mint, feeRecipient),
    ]);
    if (!Number.isSafeInteger(m) || m < 0 || c.kind !== 'ok') throw new Error('rent');
    mintRent = m;
    cost = c.value;
  } catch {
    return notSent('build', 'Could not read the network to prepare this launch.');
  }

  let body: TransactionInstruction[];
  try {
    body = createLaunchInstructions(gate, input, mintRent, openingBuy, feeRecipient);
  } catch (e) {
    return notSent('build', e instanceof Error ? `The token details are not valid: ${e.message}.` : 'The token details are not valid.');
  }

  const creatorAta = associatedTokenAddress(mint, creator);
  return buildAndSimulate(rpc, {
    kind: 'create',
    body,
    extraSigners: [input.mint],
    intent: {
      kind: 'create',
      signer: creator,
      cfg: gate.cfg,
      feeRecipient,
      ammConfig: gate.global.ammConfig,
      creator,
      mint,
      maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS,
    },
    watch: {
      signer: creator,
      tokenAccounts: [
        ...(openingBuy ? [{ account: creatorAta, mint }] : []),
        // Not yours: watched so the test run proves the reserve lands where the review says.
        { account: treasuryToken, mint, role: 'treasury' as const },
      ],
    },
    expect: (_pre, rents) => ({
      // Mint rent + what create_launch charges (curve, vault, treasury token account
      // when missing) + the token details, and the opening buy's ceiling and token
      // account if any.
      maxSolOut:
        BigInt(mintRent) +
        cost.total +
        METADATA_COST_ALLOWANCE_LAMPORTS +
        (openingBuy ? openingBuy.maxLamportsIn + rents.tokenAccount : 0n),
      tokens: [
        ...(openingBuy
          ? [{ account: creatorAta, mint, minDelta: openingBuy.minTokensOut, maxDelta: openingBuy.minTokensOut }]
          : []),
        // The treasury receives the platform reserve, exactly.
        { account: treasuryToken, mint, minDelta: reserveTokens, maxDelta: reserveTokens },
      ],
    }),
    // The token details account is sized by Metaplex, so its rent is only in the simulated total.
    newAccountRent: (_pre, rents) => BigInt(mintRent) + cost.total + (openingBuy ? rents.tokenAccount : 0n),
    summarize: (steps): TxSummary | string => {
      const s = bodySteps(steps);
      const meta = findStep(s, 'create-metadata');
      const init = findStep(s, 'init-mint');
      const launch = findStep(s, 'create-launch');
      if (!meta || !init || !launch) return 'The launch transaction is missing a step, so it was blocked.';
      if (!launch.feeRecipient.equals(feeRecipient) || !launch.treasuryToken.equals(treasuryToken)) {
        return 'The platform reserve in the transaction goes somewhere other than the treasury, so it was blocked.';
      }
      if (meta.name !== input.metadata.name || meta.symbol !== input.metadata.symbol || meta.uri !== input.metadata.uri) {
        return 'The token details in the transaction do not match the form, so it was blocked.';
      }
      const buy = findStep(s, 'curve-buy');
      if ((buy === undefined) !== (openingBuy === null)) return 'The opening buy in the transaction does not match the form.';
      if (buy && openingBuy && (buy.maxLamportsIn !== openingBuy.maxLamportsIn || buy.minTokensOut !== openingBuy.minTokensOut)) {
        return 'The opening buy in the transaction does not match the quote.';
      }
      return {
        kind: 'create',
        mint,
        creator,
        name: meta.name,
        symbol: meta.symbol,
        uri: meta.uri,
        decimals: LAUNCH_DECIMALS,
        openingBuy:
          buy && openingQuote ? { maxLamportsIn: buy.maxLamportsIn, minTokensOut: buy.minTokensOut, quote: openingQuote } : null,
        platformReserve:
          reserveTokens > 0n
            ? { amount: reserveTokens, bps: reserveBps, recipient: feeRecipient, treasuryToken }
            : null,
        treasuryAccountRent: cost.treasuryToken,
      };
    },
  });
}
