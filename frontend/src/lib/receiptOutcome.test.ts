// @vitest-environment node
/**
 * receiptOutcome reads wagmi's receipt ERROR to tell a revert from a receipt we
 * never got. That only works while wagmi keeps throwing the shapes it throws
 * today, so these cases run the REAL `@wagmi/core` waitForTransactionReceipt,
 * with real viem underneath, against a scripted JSON-RPC node, and hand what it
 * throws to receiptOutcome. A wagmi or viem upgrade that changes a shape fails
 * here, not in a user's wallet.
 *
 * The scripted responses copy the shapes a local anvil node produced on
 * 2026-09-17 (a reverted tx gave `CallExecutionError`; a withheld receipt gave
 * `TransactionReceiptNotFoundError`, for a successful tx and a reverted one alike).
 */
import { describe, it, expect } from 'vitest';
import { createConfig, custom, waitForTransactionReceipt } from '@wagmi/core';
import { defineChain } from 'viem';
import { receiptOutcome, isRevertedReceiptError } from './txErrors';

const chain = defineChain({
  id: 31337,
  name: 'scripted',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://scripted.invalid'] } },
});

const HASH = `0x${'ab'.repeat(32)}` as const;
const FROM = `0x${'11'.repeat(20)}`;
const TO = `0x${'22'.repeat(20)}`;
const BLOCK = '0x10';
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

const tx = {
  hash: HASH, nonce: '0x0', blockHash: BLOCK_HASH, blockNumber: BLOCK, transactionIndex: '0x0',
  from: FROM, to: TO, value: '0x0', gas: '0x30000', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1',
  input: '0x', type: '0x2', chainId: '0x7a69', accessList: [], v: '0x0', r: '0x1', s: '0x1', yParity: '0x0',
};
const receipt = (status: '0x0' | '0x1') => ({
  transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: BLOCK, transactionIndex: '0x0',
  from: FROM, to: TO, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
  logs: [], logsBloom: `0x${'00'.repeat(256)}`, status, type: '0x2', contractAddress: null,
});
const block = {
  hash: BLOCK_HASH, number: BLOCK, parentHash: `0x${'00'.repeat(32)}`, timestamp: '0x1', nonce: '0x0',
  gasLimit: '0x1c9c380', gasUsed: '0x5208', baseFeePerGas: '0x1', miner: FROM, difficulty: '0x0',
  extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, sha3Uncles: `0x${'00'.repeat(32)}`, size: '0x1',
  stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`,
  transactionsRoot: `0x${'00'.repeat(32)}`, uncles: [], transactions: [tx],
};

type Node = { receipt: 'success' | 'reverted' | 'withheld' };

function configFor(node: Node) {
  const request = async ({ method }: { method: string }) => {
    switch (method) {
      case 'eth_chainId': return '0x7a69';
      case 'eth_blockNumber': return BLOCK;
      case 'eth_getTransactionByHash': return tx;
      case 'eth_getBlockByNumber': return block;
      case 'eth_getTransactionReceipt':
        if (node.receipt === 'withheld') return null; // an un-indexed node's answer
        return receipt(node.receipt === 'success' ? '0x1' : '0x0');
      case 'eth_call':
        // wagmi replays a reverted tx to read its reason; the node reverts again.
        throw Object.assign(new Error('execution reverted: nope'), {
          code: 3,
          data: '0x08c379a0' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + '6e6f7065'.padEnd(64, '0'),
        });
      default: throw new Error(`scripted node: unexpected ${method}`);
    }
  };
  return createConfig({
    chains: [chain],
    transports: { [chain.id]: custom({ request }, { retryCount: 0 }) },
    pollingInterval: 10,
  });
}

/** Run the real wagmi action and fold its settlement into the query shape wagmi's hook exposes. */
async function settle(node: Node) {
  try {
    const data = await waitForTransactionReceipt(configFor(node), { hash: HASH });
    return { data, isSuccess: true, isError: false, error: undefined as unknown };
  } catch (error) {
    return { data: undefined, isSuccess: false, isError: true, error };
  }
}

describe('receiptOutcome against the real wagmi receipt wait', () => {
  it('a successful tx is a success', async () => {
    const q = await settle({ receipt: 'success' });
    expect(receiptOutcome(q)).toEqual({ isSuccess: true, isReverted: false, isUnconfirmed: false });
  });

  it('a reverted tx arrives as an ERROR, and is read as a revert', async () => {
    const q = await settle({ receipt: 'reverted' });
    // The fact everything else rests on: wagmi does not hand back a reverted receipt.
    expect(q.isError, 'wagmi returned a reverted receipt instead of throwing; re-derive receiptOutcome').toBe(true);
    expect((q.error as Error).name).toBe('CallExecutionError');
    expect(receiptOutcome(q)).toEqual({ isSuccess: false, isReverted: true, isUnconfirmed: false });
  });

  it('a withheld receipt is unconfirmed, never a revert', async () => {
    const q = await settle({ receipt: 'withheld' });
    expect(q.isError).toBe(true);
    expect((q.error as Error).name).toBe('TransactionReceiptNotFoundError');
    expect(receiptOutcome(q)).toEqual({ isSuccess: false, isReverted: false, isUnconfirmed: true });
  });
});

describe('receiptOutcome', () => {
  it('keeps a fetched non-success receipt as a revert, should wagmi ever return one', () => {
    expect(receiptOutcome({ isSuccess: true, isError: false, data: { status: 'reverted' } })).toEqual({
      isSuccess: false, isReverted: true, isUnconfirmed: false,
    });
  });

  it('reads an error it does not recognise as unconfirmed, the side that never says "send it again"', () => {
    for (const error of [new Error('unknown reason'), { name: 'HttpRequestError' }, undefined, null, 'boom']) {
      expect(isRevertedReceiptError(error)).toBe(false);
      expect(receiptOutcome({ isSuccess: false, isError: true, error })).toEqual({
        isSuccess: false, isReverted: false, isUnconfirmed: true,
      });
    }
  });

  it('is all-false while the query is still pending', () => {
    expect(receiptOutcome({ isSuccess: false, isError: false })).toEqual({
      isSuccess: false, isReverted: false, isUnconfirmed: false,
    });
  });
});
