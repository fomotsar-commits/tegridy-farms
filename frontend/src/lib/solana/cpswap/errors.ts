/**
 * cp-swap's Anchor error codes, in plain English for the person who pressed the
 * button.
 *
 * The numbering is positional (Anchor numbers `#[error_code]` variants from 6000 in
 * declaration order), so this table is pinned against the fork's own IDL by
 * `errors.test.ts`: the names below must equal the IDL's names at the same codes,
 * and every IDL code must have a sentence.
 *
 * cp-swap and the launch program BOTH start at 6000, so a bare number never says
 * whose error it is. The caller must first work out which program failed (the
 * `Program <id> failed` log line) and only then look a code up here.
 */
export const CP_SWAP_ERROR_CODES = {
  6000: 'NotApproved',
  6001: 'InvalidOwner',
  6002: 'EmptySupply',
  6003: 'InvalidInput',
  6004: 'IncorrectLpMint',
  6005: 'ExceededSlippage',
  6006: 'ZeroTradingTokens',
  6007: 'NotSupportMint',
  6008: 'InvalidVault',
  6009: 'InitLpAmountTooLess',
  6010: 'TransferFeeCalculateNotMatch',
  6011: 'MathOverflow',
  6012: 'InsufficientVault',
  6013: 'InvalidFeeModel',
  6014: 'NoFeeCollect',
} as const;

export type CpSwapErrorName = (typeof CP_SWAP_ERROR_CODES)[keyof typeof CP_SWAP_ERROR_CODES];

export const CP_SWAP_ERROR_COPY: Record<CpSwapErrorName, string> = {
  NotApproved: 'The pool is not taking swaps right now (it is switched off or not open yet).',
  InvalidOwner: 'One of the accounts in this swap belongs to the wrong owner.',
  EmptySupply: 'The pool has no liquidity for this.',
  InvalidInput: 'The pool refused the amounts in this swap.',
  IncorrectLpMint: 'The pool refused the pool-share token named in this transaction.',
  ExceededSlippage: 'The price moved past your limit before this landed. Get a new quote and try again.',
  ZeroTradingTokens: 'That amount is too small to trade.',
  NotSupportMint: 'The pool does not support this kind of token.',
  InvalidVault: 'The pool vault named in this transaction is wrong.',
  InitLpAmountTooLess: 'Too little was put in to open the pool.',
  TransferFeeCalculateNotMatch: 'A token transfer fee did not match what the pool expected.',
  MathOverflow: 'The amount is too large for the pool to work with.',
  InsufficientVault: 'The pool does not hold enough to pay this out.',
  InvalidFeeModel: 'The pool has a fee setting it cannot use.',
  NoFeeCollect: 'There are no fees to collect.',
};

export function cpSwapErrorName(code: number): CpSwapErrorName | null {
  return (CP_SWAP_ERROR_CODES as Record<number, CpSwapErrorName | undefined>)[code] ?? null;
}
