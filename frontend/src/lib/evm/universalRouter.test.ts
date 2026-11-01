import { describe, it, expect } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { buyWithEth, sellForEth, portion, v3Path, type PermitSingle } from './universalRouter';

// The command sequences are Uniswap's (universal-router Commands.sol / ActionConstants.sol,
// SDK uniswapTrade.ts), and a fork of Base ran exactly these bytes 2026-11-01: the seller got
// the quote less 0.5%, the fee Safe got exactly 0.5%, the router kept nothing. These pin
// every field, so a changed byte fails here before it reaches a wallet.
const BNKR = '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b';
const WETH = '0x4200000000000000000000000000000000000006';
const SAFE = '0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1';
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
    const call = sellForEth({ coin: BNKR, weth: WETH, poolFee: 10000, amountIn: 5n, minOut: 4n, feeBips: 50n, feeRecipient: SAFE, permit: { permit, signature: '0x1234' } });
    expect(call.commands).toBe('0x0a00060c');
    const [recipient, amountIn, amountOutMin, path, payerIsUser] = swapIn(call.inputs[1]!);
    expect([recipient, amountIn, amountOutMin, payerIsUser]).toEqual([ADDRESS_THIS, 5n, 0n, true]);
    expect(path).toBe(v3Path(BNKR, 10000, WETH));
    expect(path).toBe(`${BNKR.toLowerCase()}002710${WETH.slice(2).toLowerCase()}`);
    expect(pay(call.inputs[2]!)).toEqual([WETH, SAFE, 50n]);
    expect(toAndMin(call.inputs[3]!)).toEqual([MSG_SENDER, 4n]);
  });

  it('a sale with no permit to sign starts at the swap', () => {
    const call = sellForEth({ coin: BNKR, weth: WETH, poolFee: 10000, amountIn: 5n, minOut: 4n, feeBips: 50n, feeRecipient: SAFE });
    expect(call.commands).toBe('0x00060c');
    expect(call.inputs).toHaveLength(3);
  });

  it('a buy: fee in ETH to the Safe first, wrap the rest, swap it straight to the buyer at its floor', () => {
    const call = buyWithEth({ coin: BNKR, weth: WETH, poolFee: 10000, minOut: 7n, feeBips: 50n, feeRecipient: SAFE });
    expect(call.commands).toBe('0x060b00');
    expect(pay(call.inputs[0]!)).toEqual(['0x0000000000000000000000000000000000000000', SAFE, 50n]);
    expect(toAndMin(call.inputs[1]!)).toEqual([ADDRESS_THIS, CONTRACT_BALANCE]);
    const [recipient, amountIn, amountOutMin, path, payerIsUser] = swapIn(call.inputs[2]!);
    expect([recipient, amountIn, amountOutMin, payerIsUser]).toEqual([MSG_SENDER, CONTRACT_BALANCE, 7n, false]);
    expect(path).toBe(v3Path(WETH, 10000, BNKR));
  });
});
