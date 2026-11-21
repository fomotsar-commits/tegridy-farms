import { describe, it, expect } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { buyManyWithEth, buyWithEth, sellForEth, swapTokens, portion, v3Path, v3SwapExactIn, type PermitSingle } from './universalRouter';

// The command sequences are Uniswap's (universal-router Commands.sol / ActionConstants.sol,
// SDK uniswapTrade.ts), and a fork of Base ran exactly these bytes 2026-11-01: the seller got
// the quote less 0.5%, the fee Safe got exactly 0.5%, the router kept nothing. These pin
// every field, so a changed byte fails here before it reaches a wallet.
const BNKR = '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b';
const WETH = '0x4200000000000000000000000000000000000006';
const SAFE = '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0';
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n;

const swapIn = (hex: `0x${string}`) =>
  decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], hex);
const pay = (hex: `0x${string}`) => decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], hex);
const toAndMin = (hex: `0x${string}`) => decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], hex);

describe('the Universal Router calls the swap signs', () => {
  it('portion floors exactly as PAY_PORTION does', () => {
    expect(portion(221_929_089_736_408_054n, 50n)).toBe(1_109_645_448_682_040n);
    expect(portion(199n, 50n)).toBe(0n);
  });

  it('a sale: Permit2 permit, swap into WETH the router holds, fee in WETH to the Safe, unwrap the rest to the seller', () => {
    const permit: PermitSingle = { details: { token: BNKR, amount: 5n, expiration: 1, nonce: 2 }, spender: '0x6fF5693b99212Da76ad316178A184AB56D299b43', sigDeadline: 3n };
    const call = sellForEth({ chainId: 8453, coin: BNKR, weth: WETH, poolFee: 10000, amountIn: 5n, minOut: 4n, feeBips: 50n, feeRecipient: SAFE, permit: { permit, signature: '0x1234' } });
    expect(call.commands).toBe('0x0a00060c');
    const [recipient, amountIn, amountOutMin, path, payerIsUser] = swapIn(call.inputs[1]!);
    expect([recipient, amountIn, amountOutMin, payerIsUser]).toEqual([ADDRESS_THIS, 5n, 0n, true]);
    expect(path).toBe(v3Path(BNKR, 10000, WETH));
    expect(path).toBe(`${BNKR.toLowerCase()}002710${WETH.slice(2).toLowerCase()}`);
    expect(pay(call.inputs[2]!)).toEqual([WETH, SAFE, 50n]);
    expect(toAndMin(call.inputs[3]!)).toEqual([MSG_SENDER, 4n]);
  });

  it('a sale with no permit to sign starts at the swap', () => {
    const call = sellForEth({ chainId: 8453, coin: BNKR, weth: WETH, poolFee: 10000, amountIn: 5n, minOut: 4n, feeBips: 50n, feeRecipient: SAFE });
    expect(call.commands).toBe('0x00060c');
    expect(call.inputs).toHaveLength(3);
  });

  it('a buy: fee in ETH to the Safe first, wrap the rest, swap it straight to the buyer at its floor', () => {
    const call = buyWithEth({ chainId: 8453, coin: BNKR, weth: WETH, poolFee: 10000, minOut: 7n, feeBips: 50n, feeRecipient: SAFE });
    expect(call.commands).toBe('0x060b00');
    expect(pay(call.inputs[0]!)).toEqual(['0x0000000000000000000000000000000000000000', SAFE, 50n]);
    expect(toAndMin(call.inputs[1]!)).toEqual([ADDRESS_THIS, CONTRACT_BALANCE]);
    const [recipient, amountIn, amountOutMin, path, payerIsUser] = swapIn(call.inputs[2]!);
    expect([recipient, amountIn, amountOutMin, payerIsUser]).toEqual([MSG_SENDER, CONTRACT_BALANCE, 7n, false]);
    expect(path).toBe(v3Path(WETH, 10000, BNKR));
  });
});

// Our HyperEVM router is Uniswap's v2.2.0: V3_SWAP_EXACT_IN carries a sixth field, minHopPriceX36
// (universal-router 64027f3, Dispatcher.sol 68-84), sent empty. Base's v2.0 takes five. Each
// chain gets its own shape, and each shape is pinned word for word.
const swapIn6 = (hex: `0x${string}`) =>
  decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }], hex);
const WHYPE = '0x5555555555555555555555555555555555555555';
const USDT0 = '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb';
const TREASURY = '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0';

describe('the V3 swap step, per chain', () => {
  it('Base (v2.0) gets five fields: the head is five words and nothing follows the path', () => {
    const hex = v3SwapExactIn(8453, MSG_SENDER, 5n, 4n, v3Path(WETH, 500, BNKR), false);
    expect(swapIn(hex)).toEqual([MSG_SENDER, 5n, 4n, v3Path(WETH, 500, BNKR), false]);
    // Five head words, the path's length word and its 43 bytes padded to two words.
    expect((hex.length - 2) / 64).toBe(5 + 1 + 2);
  });

  it('HyperEVM (v2.2.0) gets six: the same five, then an empty per-hop floor array', () => {
    const hex = v3SwapExactIn(999, MSG_SENDER, 5n, 4n, v3Path(WHYPE, 3000, USDT0), false);
    expect(swapIn6(hex)).toEqual([MSG_SENDER, 5n, 4n, v3Path(WHYPE, 3000, USDT0), false, []]);
    // Six head words, then the path (length + two words), then the array's length word, 0.
    expect((hex.length - 2) / 64).toBe(6 + 1 + 2 + 1);
    expect(hex.endsWith('0'.repeat(64))).toBe(true);
  });

  it('every builder takes the chain it is for', () => {
    const buy = buyWithEth({ chainId: 999, coin: USDT0, weth: WHYPE, poolFee: 3000, minOut: 7n, feeBips: 30n, feeRecipient: TREASURY });
    expect(swapIn6(buy.inputs[2]!)[5]).toEqual([]);
    const sell = sellForEth({ chainId: 999, coin: USDT0, weth: WHYPE, poolFee: 3000, amountIn: 5n, minOut: 4n, feeBips: 30n, feeRecipient: TREASURY });
    expect(swapIn6(sell.inputs[0]!)).toEqual([ADDRESS_THIS, 5n, 0n, v3Path(USDT0, 3000, WHYPE), true, []]);
    const many = buyManyWithEth({ chainId: 8453, weth: WETH, legs: [{ coin: BNKR, poolFee: 10000, amountIn: 100n, minOut: 1n }], feeBips: 50n, feeRecipient: SAFE });
    expect(swapIn(many.inputs[2]!)).toEqual([MSG_SENDER, CONTRACT_BALANCE, 1n, v3Path(WETH, 10000, BNKR), false]);
  });
});

describe('a coin for a coin', () => {
  it('swaps into the router, pays the fee in the coin out to the treasury, sweeps the rest to the seller at its floor', () => {
    const call = swapTokens({ chainId: 999, tokenIn: USDT0, tokenOut: WHYPE, poolFee: 500, amountIn: 1_000_000n, minOut: 9n, feeBips: 30n, feeRecipient: TREASURY });
    // V3_SWAP_EXACT_IN, PAY_PORTION, SWEEP (Commands.sol 0x00, 0x06, 0x04).
    expect(call.commands).toBe('0x000604');
    expect(swapIn6(call.inputs[0]!)).toEqual([ADDRESS_THIS, 1_000_000n, 0n, v3Path(USDT0, 500, WHYPE), true, []]);
    expect(pay(call.inputs[1]!)).toEqual([WHYPE, TREASURY, 30n]);
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint160' }], call.inputs[2]!)).toEqual([WHYPE, MSG_SENDER, 9n]);
  });

  it('a permit, when one is signed, goes first', () => {
    const permit: PermitSingle = { details: { token: USDT0, amount: 5n, expiration: 1, nonce: 2 }, spender: TREASURY, sigDeadline: 3n };
    const call = swapTokens({ chainId: 999, tokenIn: USDT0, tokenOut: WHYPE, poolFee: 500, amountIn: 5n, minOut: 4n, feeBips: 30n, feeRecipient: TREASURY, permit: { permit, signature: '0x1234' } });
    expect(call.commands).toBe('0x0a000604');
  });
});
