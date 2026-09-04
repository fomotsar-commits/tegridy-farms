// Reading a receipt and deciding whether it actually paid this invoice.
//
// This is the module that finally makes `chain-confirmed` reachable
// (settlement.ts:SettlementVerification). Until now only `client-reported` was
// reachable on this deployment, because nothing here had ever read a receipt.
//
// ─── WHAT AN ERC-20 TRANSFER CANNOT CARRY ───────────────────────────────────
//
// A plain `transfer(to, amount)` emits `Transfer(from, to, value)` and nothing
// else. There is no invoice field, no memo, no reference. So this judge can bind
// a hash to (token, payee, amount, and — when the block was read — a time
// window), and it CANNOT bind it to an invoice id. The same hash would confirm
// any invoice of the same merchant for the same amount. That limit is stated on
// the surface in as many words and de-duplicated merchant-side by
// acceptedHashes.ts, rather than being papered over here.
//
// Solana Pay solves this with a `reference` account and Request Network with
// payment-reference calldata. Both need a rail this venue does not have: a plain
// ERC-20 has no third field, and a memo-bearing route would be a new contract.
//
// ─── WHY EXACT-EQUAL AND NOT `>=` ───────────────────────────────────────────
//
// Leg 2 moves `invoice.settleAmount`, exactly (settlement.ts). So a receipt that
// moved a different figure did not execute the plan this venue offered, and the
// merchant reading it needs to see both numbers rather than a green tick. The
// case that makes this earn its keep is a fee-on-transfer token: the buyer's
// wallet sends the invoiced amount and the merchant RECEIVES LESS, which is a
// refutation, and the detail names the shortfall.
//
// ─── AN UNREAD RECEIPT IS NOT A REFUTED ONE ─────────────────────────────────
//
// Nothing in this file is reachable without a receipt in hand. "The RPC did not
// answer" and "no such hash" are handled by the caller (hooks/useReceiptProof.ts)
// as `unread`, never routed through here, because a refutation tells a merchant
// they were not paid and an outage tells them nothing at all.

import { erc20Abi, parseEventLogs, type Log } from 'viem';
import { formatScaled } from '../tax/csv';
import type { Invoice } from './invoice';

/** Exactly the shape a wagmi/viem receipt already has — no adapter, no copy. */
export interface JudgeableReceipt {
  status: 'success' | 'reverted';
  logs: readonly Log[];
}

/** The block the receipt landed in. Null when it could not be read; never assumed. */
export interface JudgeableBlock {
  timestamp: bigint;
}

export type ReceiptVerdict =
  | {
      verification: 'chain-confirmed';
      /** The wallet the settlement asset actually left. Rendered FIRST on every confirmed card. */
      from: `0x${string}`;
      /** Which log in the receipt carried it. Null only if the node omitted the index. */
      logIndex: number | null;
      /** Chain time of the block, in unix seconds. Null when the block was not read. */
      minedAt: number | null;
      /** True only when a block WAS read and its time is past `expiresAt`. */
      afterExpiry: boolean;
    }
  | { verification: 'chain-refuted'; detail: string };

function sameAddress(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * The verdict on one receipt against one invoice.
 *
 * Pure: every input is passed in, including the block, so the same receipt
 * judges the same way in a test, on a merchant's screen and on a buyer's.
 */
export function judgeReceipt(
  inv: Invoice,
  receipt: JudgeableReceipt,
  block: JudgeableBlock | null,
): ReceiptVerdict {
  const owed = `${formatScaled(inv.settleAmount, inv.settleDecimals)} ${inv.settleSymbol}`;

  if (receipt.status !== 'success') {
    return {
      verification: 'chain-refuted',
      detail: `This transaction reverted on chain, so no ${inv.settleSymbol} moved and the merchant was not paid.`,
    };
  }

  // `parseEventLogs` drops anything that is not a Transfer rather than throwing
  // on the unrelated logs any real transaction carries.
  const transfers = parseEventLogs({ abi: erc20Abi, logs: [...receipt.logs], eventName: 'Transfer' });

  const exact = transfers.find(
    (l) =>
      sameAddress(l.address, inv.settleToken) &&
      sameAddress(l.args.to, inv.merchant) &&
      l.args.value === inv.settleAmount,
  );

  if (exact) {
    if (block !== null && block.timestamp < BigInt(inv.createdAt)) {
      return {
        verification: 'chain-refuted',
        detail:
          'This transfer was mined before this invoice existed, so it cannot be its payment. Presenting an ' +
          'older transfer against a newer invoice is how a paid hash gets spent twice.',
      };
    }
    return {
      verification: 'chain-confirmed',
      from: exact.args.from,
      logIndex: exact.logIndex,
      minedAt: block === null ? null : Number(block.timestamp),
      afterExpiry: block !== null && block.timestamp > BigInt(inv.expiresAt),
    };
  }

  // No exact match. Say WHICH way it missed, because "not found" over a receipt
  // that moved 99 of the right token to the right person is a useless sentence.
  const wrongAmount = transfers.find(
    (l) => sameAddress(l.address, inv.settleToken) && sameAddress(l.args.to, inv.merchant),
  );
  if (wrongAmount) {
    const got = `${formatScaled(wrongAmount.args.value, inv.settleDecimals)} ${inv.settleSymbol}`;
    return {
      verification: 'chain-refuted',
      detail:
        `This receipt moved ${got} to the merchant and the invoice is for ${owed}. A token that takes a fee on ` +
        'transfer does exactly this: the wallet sends the invoiced amount and the payee receives less.',
    };
  }

  const wrongToken = transfers.find(
    (l) => sameAddress(l.args.to, inv.merchant) && l.args.value === inv.settleAmount,
  );
  if (wrongToken) {
    return {
      verification: 'chain-refuted',
      detail:
        `This receipt moved the right amount to the merchant, but on token ${wrongToken.address} rather than the ` +
        `${inv.settleSymbol} at ${inv.settleToken} the invoice names. An amount is not a payment without its asset.`,
    };
  }

  const anyToMerchant = transfers.some((l) => sameAddress(l.args.to, inv.merchant));
  return {
    verification: 'chain-refuted',
    detail: anyToMerchant
      ? `This receipt moves tokens to the merchant, but none of them is ${owed} of the ${inv.settleSymbol} at ${inv.settleToken}.`
      : `This receipt contains no ERC-20 transfer to ${inv.merchant} at all.`,
  };
}
