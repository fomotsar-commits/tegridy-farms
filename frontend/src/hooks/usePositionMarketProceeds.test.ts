import { describe, it, expect } from 'vitest';
import { netProceeds, ORDER_STATUS, POSITION_MARKET_ABI } from './usePositionMarket';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const SINK = '0x00000000000000000000000000000000000000aa' as const;

describe('netProceeds', () => {
  it('returns null when the fee is unknown rather than assuming zero', () => {
    // The dial ships at zero, but a surface that hardcodes that assumption
    // silently understates what a seller pays the day it is turned on.
    expect(netProceeds(10n ** 18n, null, SINK)).toBeNull();
    expect(netProceeds(10n ** 18n, 100, null)).toBeNull();
  });

  it('is the whole price at a zero rate', () => {
    expect(netProceeds(10n ** 18n, 0, SINK)).toBe(10n ** 18n);
  });

  it('is the whole price when no sink is wired, whatever the rate says', () => {
    // Mirrors the contract: `fill` forces the fee to zero when the snapshotted
    // recipient is the zero address, so the UI must not show a deduction that
    // will not happen.
    expect(netProceeds(10n ** 18n, 250, ZERO)).toBe(10n ** 18n);
  });

  it('deducts the snapshotted rate when a sink is wired', () => {
    expect(netProceeds(10n ** 18n, 100, SINK)).toBe(99n * 10n ** 16n); // 1%
    expect(netProceeds(10n ** 18n, 250, SINK)).toBe(9_750n * 10n ** 14n); // 2.5%
  });

  it('rounds the fee down, never the seller', () => {
    // 1 wei at 1% must not round a fee up into a proceeds shortfall.
    expect(netProceeds(1n, 100, SINK)).toBe(1n);
  });
});

describe('POSITION_MARKET_ABI', () => {
  it('declares only selectors the contract exports', () => {
    // An ABI entry with no matching bytecode reverts with empty returndata,
    // which reads to a user as a refusal rather than as the wiring bug it is.
    // This pins the list so a rename on the Solidity side has to be mirrored
    // here deliberately.
    const names = POSITION_MARKET_ABI.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        'MAX_ESCROWED_POSITIONS',
        'STAKING_TRANSFER_RATE_LIMIT',
        'cancel',
        'claimEscrowRewards',
        'escrowRewardsOwed',
        'escrowedCount',
        'feeBps',
        'feeRecipient',
        'fill',
        'fillability',
        'list',
        'nextOrderId',
        'orders',
      ].sort(),
    );
  });

  it('keeps fill payable — the payment and the transfer are one call', () => {
    const fill = POSITION_MARKET_ABI.find((f) => f.name === 'fill');
    expect(fill?.stateMutability).toBe('payable');
  });

  it('mirrors the on-chain OrderStatus encoding', () => {
    expect(ORDER_STATUS).toEqual({ None: 0, Open: 1, Filled: 2, Cancelled: 3 });
  });
});
