// Logs are built with viem's real `encodeEventTopics` / `encodeAbiParameters`,
// not hand-written hex, so what these tests feed `judgeReceipt` is byte-identical
// to what an RPC returns. A hand-rolled topic that happened to match the judge's
// expectations would prove the judge agrees with the test and nothing else.

import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, pad, type Log } from 'viem';
import type { Invoice } from './invoice';
import { judgeReceipt } from './receiptProof';

const MERCHANT = '0x1111111111111111111111111111111111111111' as const;
const BUYER = '0x2222222222222222222222222222222222222222' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as const;

const CREATED = 1_760_000_000;
const EXPIRES = CREATED + 900;

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-abc234def567',
    merchant: MERCHANT,
    chainId: 1,
    settleToken: USDC,
    settleSymbol: 'USDC',
    settleDecimals: 6,
    settleAmount: 100_000_000n,
    memo: '',
    expiresAt: EXPIRES,
    createdAt: CREATED,
    ...over,
  };
}

let nextIndex = 0;

function transferLog(args: {
  token?: `0x${string}`;
  from?: `0x${string}`;
  to?: `0x${string}`;
  value?: bigint;
}): Log {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { from: args.from ?? BUYER, to: args.to ?? MERCHANT },
  });
  return {
    address: args.token ?? USDC,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }], [args.value ?? 100_000_000n]),
    blockNumber: 21_000_000n,
    blockHash: pad('0x01', { size: 32 }),
    transactionHash: pad('0x02', { size: 32 }),
    transactionIndex: 3,
    logIndex: nextIndex++,
    removed: false,
  } as unknown as Log;
}

/** An unrelated log, to prove the judge does not choke on a real receipt's noise. */
function noiseLog(): Log {
  return {
    address: '0x3333333333333333333333333333333333333333',
    topics: [pad('0xdeadbeef', { size: 32 })],
    data: '0x',
    blockNumber: 21_000_000n,
    blockHash: pad('0x01', { size: 32 }),
    transactionHash: pad('0x02', { size: 32 }),
    transactionIndex: 3,
    logIndex: nextIndex++,
    removed: false,
  } as unknown as Log;
}

const block = (timestamp: number) => ({ timestamp: BigInt(timestamp) });

describe('a receipt confirms an invoice only when it moved the exact debt', () => {
  it('confirms the exact transfer and names who it came from', () => {
    const verdict = judgeReceipt(
      invoice(),
      { status: 'success', logs: [noiseLog(), transferLog({})] },
      block(CREATED + 30),
    );
    expect(verdict.verification).toBe('chain-confirmed');
    if (verdict.verification !== 'chain-confirmed') return;
    expect(verdict.from).toBe(BUYER);
    expect(verdict.minedAt).toBe(CREATED + 30);
    expect(verdict.afterExpiry).toBe(false);
    expect(typeof verdict.logIndex).toBe('number');
  });

  it('confirms when the payee is written in a different case', () => {
    const verdict = judgeReceipt(
      invoice({ merchant: MERCHANT.toUpperCase().replace('0X', '0x') as `0x${string}` }),
      { status: 'success', logs: [transferLog({})] },
      block(CREATED + 30),
    );
    expect(verdict.verification).toBe('chain-confirmed');
  });

  it('refutes a shortfall and names BOTH figures', () => {
    // The fee-on-transfer case: the wallet sent 100 and the merchant got 99.
    const verdict = judgeReceipt(
      invoice(),
      { status: 'success', logs: [transferLog({ value: 99_000_000n })] },
      block(CREATED + 30),
    );
    expect(verdict.verification).toBe('chain-refuted');
    if (verdict.verification !== 'chain-refuted') return;
    expect(verdict.detail).toContain('99.000000 USDC');
    expect(verdict.detail).toContain('100.000000 USDC');
  });

  it('refutes the right amount moved on the wrong token contract', () => {
    const verdict = judgeReceipt(
      invoice(),
      { status: 'success', logs: [transferLog({ token: USDT })] },
      block(CREATED + 30),
    );
    expect(verdict.verification).toBe('chain-refuted');
    if (verdict.verification !== 'chain-refuted') return;
    expect(verdict.detail).toContain(USDT);
  });

  it('refutes a reverted transaction even when a matching log is present', () => {
    // wagmi's `isSuccess` means "receipt fetched", so this is exactly the state
    // that once rendered "The transfer confirmed on chain" for a failed payment.
    const verdict = judgeReceipt(
      invoice(),
      { status: 'reverted', logs: [transferLog({})] },
      block(CREATED + 30),
    );
    expect(verdict.verification).toBe('chain-refuted');
    if (verdict.verification !== 'chain-refuted') return;
    expect(verdict.detail).toMatch(/reverted/i);
  });

  it('refutes a receipt with no transfer to the merchant at all', () => {
    const verdict = judgeReceipt(
      invoice(),
      { status: 'success', logs: [noiseLog(), transferLog({ to: BUYER })] },
      block(CREATED + 30),
    );
    expect(verdict.verification).toBe('chain-refuted');
    if (verdict.verification !== 'chain-refuted') return;
    expect(verdict.detail).toContain(MERCHANT);
  });

  it('refutes a transfer mined before the invoice existed', () => {
    // The re-presentation attack: a hash already spent on last week's invoice,
    // shown against a fresh one for the same amount.
    const verdict = judgeReceipt(
      invoice(),
      { status: 'success', logs: [transferLog({})] },
      block(CREATED - 1),
    );
    expect(verdict.verification).toBe('chain-refuted');
    if (verdict.verification !== 'chain-refuted') return;
    expect(verdict.detail).toMatch(/before this invoice existed/i);
  });
});

describe('the time binding is reported, never assumed', () => {
  it('confirms with minedAt null when the block could not be read', () => {
    // A missing block is a gap in what we know about WHEN. It is not evidence of
    // anything about the transfer, so it must not turn a confirmation into a
    // refutation — the surface prints "block time not read" instead.
    const verdict = judgeReceipt(invoice(), { status: 'success', logs: [transferLog({})] }, null);
    expect(verdict.verification).toBe('chain-confirmed');
    if (verdict.verification !== 'chain-confirmed') return;
    expect(verdict.minedAt).toBeNull();
    expect(verdict.afterExpiry).toBe(false);
  });

  it('confirms a late payment and flags it rather than refusing it', () => {
    // The merchant decides whether a late payment counts. The chain does not.
    const verdict = judgeReceipt(
      invoice(),
      { status: 'success', logs: [transferLog({})] },
      block(EXPIRES + 60),
    );
    expect(verdict.verification).toBe('chain-confirmed');
    if (verdict.verification !== 'chain-confirmed') return;
    expect(verdict.afterExpiry).toBe(true);
  });
});
