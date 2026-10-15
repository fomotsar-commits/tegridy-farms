/**
 * Library-contract pin for the DIRECT receipt helpers (`waitForReceiptOutcome`,
 * `readReceiptOutcome`), the ones every `publicClient` caller goes through.
 *
 * viem's own `waitForTransactionReceipt` is not wagmi's: it RETURNS a reverted receipt
 * and rejects only when it could not read one, and a replaced transaction resolves it
 * with the REPLACEMENT's receipt. So this runs a real viem public client against a
 * scripted EIP-1193 node and classifies whatever comes out, the same way
 * txErrors.receipt.test.ts pins the wagmi hook. If a viem upgrade changes either
 * shape, this goes red before a keeper counts a cancelled swap as done.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPublicClient, custom } from 'viem';
import { foundry } from 'viem/chains';
import { readReceiptOutcome, surfaceReceiptNotice, waitForReceiptOutcome } from './txErrors';

const BLOCK_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222';
const FROM = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const TO = '0x00000000000000000000000000000000000c0de1';
const R_HASH = '0x3333333333333333333333333333333333333333333333333333333333333333';

let seq = 0;
/** A fresh hash per case: viem records a replacement's reason per submitted hash. */
const freshHash = () => `0x${(++seq).toString(16).padStart(64, '8')}` as `0x${string}`;

const txOf = (hash: string, extra: Record<string, unknown> = {}) => ({
  hash, blockHash: BLOCK_HASH, blockNumber: '0x5', transactionIndex: '0x0',
  from: FROM, to: TO, input: '0xa9059cbb', value: '0x0', gas: '0x186a0', nonce: '0x7',
  type: '0x2', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', chainId: '0x7a69',
  v: '0x0', r: '0x1', s: '0x1', accessList: [], ...extra,
});
const receiptOf = (hash: string, status: '0x0' | '0x1', extra: Record<string, unknown> = {}) => ({
  transactionHash: hash, blockHash: BLOCK_HASH, blockNumber: '0x5', transactionIndex: '0x0',
  from: FROM, to: TO, status, logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2',
  gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', contractAddress: null,
  ...extra,
});
const block = (number: string, transactions: unknown[]) => ({
  hash: BLOCK_HASH, number, parentHash: BLOCK_HASH, timestamp: '0x1', transactions,
  baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x5208', logsBloom: `0x${'0'.repeat(512)}`,
  miner: FROM, nonce: '0x0000000000000000', difficulty: '0x0', extraData: '0x', size: '0x1',
  stateRoot: BLOCK_HASH, receiptsRoot: BLOCK_HASH, transactionsRoot: BLOCK_HASH,
  sha3Uncles: BLOCK_HASH, uncles: [],
});

type Script = Partial<Record<string, (params: unknown[]) => unknown>>;

/** A real viem public client whose only node answers from `script`. */
function clientFor(script: Script) {
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const answer = script[method];
      if (!answer) throw Object.assign(new Error(`unscripted ${method}`), { code: -32601 });
      return answer(params ?? []);
    },
  };
  return createPublicClient({ chain: foundry, transport: custom(provider, { retryCount: 0 }), pollingInterval: 20 });
}

const mined = (hash: string, status: '0x0' | '0x1'): Script => ({
  eth_chainId: () => '0x7a69',
  eth_blockNumber: () => '0x6',
  eth_getTransactionByHash: () => txOf(hash),
  eth_getTransactionReceipt: () => receiptOf(hash, status),
});

// What a wallet sends in place of the pending transaction, per viem's reason.
const REPLACEMENTS = {
  cancelled: { to: FROM, input: '0x', value: '0x0' },
  repriced: { to: TO, input: '0xa9059cbb', value: '0x0', maxFeePerGas: '0x77359400' },
  replaced: { to: TO, input: '0xdeadbeef', value: '0x0' },
} as const;

/** The sent hash never mines; the next block holds a same-sender, same-nonce `kind`. */
function replacedBy(kind: keyof typeof REPLACEMENTS, replacementStatus: '0x0' | '0x1' = '0x1'): { hash: `0x${string}`; script: Script } {
  const hash = freshHash();
  const pending = txOf(hash, { blockHash: null, blockNumber: null, transactionIndex: null });
  const other = txOf(R_HASH, { ...REPLACEMENTS[kind], blockNumber: '0x6' });
  return {
    hash,
    script: {
      eth_chainId: () => '0x7a69',
      eth_blockNumber: () => '0x6',
      eth_getTransactionByHash: ([h]) => (h === hash ? pending : other),
      eth_getBlockByNumber: () => block('0x6', [other]),
      eth_getTransactionReceipt: ([h]) => (h === hash ? null : receiptOf(R_HASH, replacementStatus, { to: other.to, blockNumber: '0x6' })),
    },
  };
}

describe('waitForReceiptOutcome, against the real viem client', () => {
  it('a success is a success', async () => {
    const hash = freshHash();
    const o = await waitForReceiptOutcome(clientFor(mined(hash, '0x1')), hash);
    expect(o.kind).toBe('success');
    expect(o.kind === 'success' && o.replacement).toBeNull();
  });

  it('a revert is RETURNED by viem, and read as a revert (not unreadable)', async () => {
    const hash = freshHash();
    const o = await waitForReceiptOutcome(clientFor(mined(hash, '0x0')), hash);
    expect(o.kind).toBe('reverted');
  });

  it('a receipt it could not read is unreadable, never a failure', async () => {
    const hash = freshHash();
    const client = clientFor({
      ...mined(hash, '0x1'),
      eth_getTransactionReceipt: () => { throw Object.assign(new Error('limit exceeded'), { code: -32005 }); },
    });
    const o = await waitForReceiptOutcome(client, hash);
    expect(o.kind).toBe('unreadable');
  });

  it('a wallet CANCEL resolves viem with a success receipt, and is read as replaced', async () => {
    const { hash, script } = replacedBy('cancelled');
    const o = await waitForReceiptOutcome(clientFor(script), hash);
    expect(o).toMatchObject({ kind: 'replaced', replacement: { hash: R_HASH, reason: 'cancelled' } });
    // The fact the whole helper exists for: what viem handed back says success.
    expect(o.kind === 'replaced' && o.receipt.status).toBe('success');
  });

  it('a different transaction at that nonce is read as replaced', async () => {
    const { hash, script } = replacedBy('replaced');
    const o = await waitForReceiptOutcome(clientFor(script), hash);
    expect(o).toMatchObject({ kind: 'replaced', replacement: { hash: R_HASH, reason: 'replaced' } });
  });

  it('a SPEED-UP is the same call: a success, carrying the hash that actually mined', async () => {
    const { hash, script } = replacedBy('repriced');
    const o = await waitForReceiptOutcome(clientFor(script), hash);
    expect(o).toMatchObject({ kind: 'success', replacement: { hash: R_HASH, reason: 'repriced' } });
    expect(o.kind === 'success' && o.receipt.transactionHash).toBe(R_HASH);
  });

  it('a sped-up transaction that reverted is a revert', async () => {
    const { hash, script } = replacedBy('repriced', '0x0');
    const o = await waitForReceiptOutcome(clientFor(script), hash);
    expect(o.kind).toBe('reverted');
  });

  it('passes onReplaced to the client: without it a speed-up could not be told from a cancel', async () => {
    const hash = freshHash();
    const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', transactionHash: hash }));
    await waitForReceiptOutcome({ waitForTransactionReceipt }, hash);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash, onReplaced: expect.any(Function) });
  });
});

describe('readReceiptOutcome, against the real viem client', () => {
  it('reads a success and a revert', async () => {
    const ok = freshHash();
    expect((await readReceiptOutcome(clientFor(mined(ok, '0x1')), ok)).kind).toBe('success');
    const bad = freshHash();
    expect((await readReceiptOutcome(clientFor(mined(bad, '0x0')), bad)).kind).toBe('reverted');
  });

  it('not mined yet, or a failed read, is unreadable', async () => {
    const hash = freshHash();
    expect((await readReceiptOutcome(clientFor({ ...mined(hash, '0x1'), eth_getTransactionReceipt: () => null }), hash)).kind)
      .toBe('unreadable');
    const failing = clientFor({
      ...mined(hash, '0x1'),
      eth_getTransactionReceipt: () => { throw Object.assign(new Error('boom'), { code: -32000 }); },
    });
    expect((await readReceiptOutcome(failing, hash)).kind).toBe('unreadable');
  });
});

describe('surfaceReceiptNotice', () => {
  const toast = () => ({ warning: vi.fn() });
  const hash = `0x${'ab'.repeat(32)}` as const;

  it('an unread receipt gets the unconfirmed warning, with the repeat cost', () => {
    const t = toast();
    surfaceReceiptNotice(t, { kind: 'unreadable', error: new Error('x') }, { hash, chainId: 1, repeatCost: 'it costs X.' });
    expect(t.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
      description: expect.stringContaining('it costs X.'),
    }));
  });

  it('a cancel gets the cancelled warning', () => {
    const t = toast();
    surfaceReceiptNotice(
      t,
      { kind: 'replaced', receipt: {}, replacement: { hash: R_HASH, reason: 'cancelled' } },
      { hash, chainId: 1, repeatCost: '' },
    );
    expect(t.warning).toHaveBeenCalledWith('Transaction cancelled', expect.anything());
  });

  it('says nothing for a success or a revert: those words belong to the surface', () => {
    const t = toast();
    surfaceReceiptNotice(t, { kind: 'success', receipt: {}, replacement: null }, { hash, chainId: 1, repeatCost: '' });
    surfaceReceiptNotice(t, { kind: 'reverted', receipt: {} }, { hash, chainId: 1, repeatCost: '' });
    expect(t.warning).not.toHaveBeenCalled();
  });
});
