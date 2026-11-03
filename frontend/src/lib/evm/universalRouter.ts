import { encodeAbiParameters, encodePacked, type Address, type Hex } from 'viem';

/**
 * Uniswap's Universal Router: the router Uniswap's own app sends trades through, and the
 * one place that app takes its interface fee (PAY_PORTION). A swap here that reaches an
 * island coin's own Uniswap V3 pool pays the venue its fee the same way, in the same
 * transaction, with no contract of ours in the path.
 *
 * Read on Base 2026-11-01: the router's poolManager() is Uniswap V4's PoolManager on Base
 * (0x4985…2b2b), which only Uniswap's v2 Universal Router carries; Permit2 is the canonical
 * deployment every chain shares. The command bytes, recipients and CONTRACT_BALANCE below
 * are Uniswap's own (universal-router Commands.sol, ActionConstants.sol), and the command
 * sequences are the ones its SDK builds (uniswapTrade.ts), except that a buy's fee is taken
 * from the ETH going in, so the venue is paid in ETH either way.
 *
 * Nothing here reads, signs or sends: it is calldata and typed data the page hands a wallet.
 */
export const UNIVERSAL_ROUTER: Readonly<Record<number, Address>> = Object.freeze({
  8453: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
});
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export function universalRouterOn(chainId: number): Address | null {
  return UNIVERSAL_ROUTER[chainId] ?? null;
}

// Commands.sol
const V3_SWAP_EXACT_IN = 0x00;
const PAY_PORTION = 0x06;
const PERMIT2_PERMIT = 0x0a;
const WRAP_ETH = 0x0b;
const UNWRAP_WETH = 0x0c;
// ActionConstants.sol
const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n;
const ETH: Address = '0x0000000000000000000000000000000000000000';

const BIPS_BASE = 10_000n;

/** What PAY_PORTION pays out of `amount`: it floors, exactly like this. */
export function portion(amount: bigint, bips: bigint): bigint {
  return (amount * bips) / BIPS_BASE;
}

/** A single-pool V3 path: tokenIn, the pool's fee tier, tokenOut. */
export function v3Path(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  return encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
}

/** Permit2's AllowanceTransfer.PermitSingle. */
export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
}

/** The EIP-712 types Permit2 hashes a PermitSingle with (PermitHash.sol). */
export const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
} as const;

export function permit2Domain(chainId: number) {
  return { name: 'Permit2', chainId, verifyingContract: PERMIT2 } as const;
}

/** Permit2.allowance(owner, token, spender), as the page reads it to pick the permit's nonce. */
export const PERMIT2_ALLOWANCE_ABI = [
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
] as const;

export const UNIVERSAL_ROUTER_ABI = [
  {
    type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
    outputs: [],
  },
] as const;

export interface RouterCall {
  commands: Hex;
  inputs: Hex[];
}

function commandBytes(cmds: number[]): Hex {
  return `0x${cmds.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const v3SwapExactIn = (recipient: Address, amountIn: bigint, amountOutMin: bigint, path: Hex, payerIsUser: boolean) =>
  encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [recipient, amountIn, amountOutMin, path, payerIsUser],
  );
const payPortion = (token: Address, recipient: Address, bips: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [token, recipient, bips]);
const recipientAndMin = (recipient: Address, amountMin: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, amountMin]);
const permit2Permit = (permit: PermitSingle, signature: Hex) =>
  encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'details', type: 'tuple',
            components: [
              { name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' },
              { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' },
            ],
          },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      { type: 'bytes' },
    ],
    [permit, signature],
  );

/**
 * Sell a coin for ETH. The router pulls `amountIn` through Permit2 (with the signed permit
 * when one is given), swaps it into WETH it holds, pays `feeBips` of that WETH to
 * `feeRecipient`, and unwraps the rest to the seller, who must get at least `minOut`.
 */
export function sellForEth(a: {
  coin: Address; weth: Address; poolFee: number; amountIn: bigint; minOut: bigint;
  feeBips: bigint; feeRecipient: Address; permit?: { permit: PermitSingle; signature: Hex };
}): RouterCall {
  const cmds: number[] = [];
  const inputs: Hex[] = [];
  if (a.permit) { cmds.push(PERMIT2_PERMIT); inputs.push(permit2Permit(a.permit.permit, a.permit.signature)); }
  cmds.push(V3_SWAP_EXACT_IN, PAY_PORTION, UNWRAP_WETH);
  inputs.push(
    v3SwapExactIn(ADDRESS_THIS, a.amountIn, 0n, v3Path(a.coin, a.poolFee, a.weth), true),
    payPortion(a.weth, a.feeRecipient, a.feeBips),
    recipientAndMin(MSG_SENDER, a.minOut),
  );
  return { commands: commandBytes(cmds), inputs };
}

/**
 * Buy a coin with ETH (send the ETH as the call's value). The router pays `feeBips` of the
 * ETH to `feeRecipient` first, wraps the rest, and swaps it straight to the buyer, who must
 * get at least `minOut`.
 */
export function buyWithEth(a: {
  coin: Address; weth: Address; poolFee: number; minOut: bigint; feeBips: bigint; feeRecipient: Address;
}): RouterCall {
  return {
    commands: commandBytes([PAY_PORTION, WRAP_ETH, V3_SWAP_EXACT_IN]),
    inputs: [
      payPortion(ETH, a.feeRecipient, a.feeBips),
      recipientAndMin(ADDRESS_THIS, CONTRACT_BALANCE),
      v3SwapExactIn(MSG_SENDER, CONTRACT_BALANCE, a.minOut, v3Path(a.weth, a.poolFee, a.coin), false),
    ],
  };
}
