/**
 * Library-contract pin for `isRevertedReceiptError` / `receiptOutcome`.
 *
 * The classifier in txErrors.ts leans on how @wagmi/core's
 * `waitForTransactionReceipt` fails, which is an implementation detail of the
 * library, not a documented API: on a reverted receipt it THROWS (after replaying
 * the tx with `call`), and on a receipt it cannot read it throws a viem read error.
 * So this suite does not construct those errors by hand. It runs the REAL action
 * against a scripted EIP-1193 provider and classifies whatever comes out. If a wagmi
 * or viem upgrade changes either shape, this goes red before a user is told a
 * revert "may have gone through", or worse, that an unreadable success reverted.
 *
 * The same outcomes were measured end to end on a local anvil (see the table in
 * txErrors.ts); this is the fast copy that runs on every push.
 */
import { describe, it, expect } from 'vitest';
import { createConfig } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { custom } from 'viem';
import { foundry } from 'viem/chains';
import { isRevertedReceiptError, receiptOutcome } from './txErrors';

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BLOCK_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222';
const FROM = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const TO = '0x00000000000000000000000000000000000c0de1';

const tx = {
  hash: HASH, blockHash: BLOCK_HASH, blockNumber: '0x5', transactionIndex: '0x0',
  from: FROM, to: TO, input: '0x', value: '0x0', gas: '0x186a0', nonce: '0x0',
  type: '0x2', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', chainId: '0x7a69',
  v: '0x0', r: '0x1', s: '0x1', accessList: [],
};
const receipt = (status: '0x0' | '0x1') => ({
  transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: '0x5', transactionIndex: '0x0',
  from: FROM, to: TO, status, logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2',
  gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', contractAddress: null,
});

type Script = Partial<Record<string, (params: unknown[]) => unknown>>;

/** A wagmi config whose only node answers from `script`; unscripted methods throw. */
function configFor(script: Script) {
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const answer = script[method];
      if (!answer) throw Object.assign(new Error(`unscripted ${method}`), { code: -32601 });
      return answer(params ?? []);
    },
  };
  return createConfig({
    chains: [foundry],
    transports: { [foundry.id]: custom(provider, { retryCount: 0 }) },
    pollingInterval: 20,
  });
}

const base: Script = {
  eth_chainId: () => '0x7a69',
  eth_blockNumber: () => '0x6',
  eth_getTransactionByHash: () => tx,
  eth_getBlockByNumber: () => ({
    hash: BLOCK_HASH, number: '0x5', parentHash: BLOCK_HASH, timestamp: '0x1', transactions: [tx],
    baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x5208', logsBloom: `0x${'0'.repeat(512)}`,
    miner: FROM, nonce: '0x0000000000000000', difficulty: '0x0', extraData: '0x', size: '0x1',
    stateRoot: BLOCK_HASH, receiptsRoot: BLOCK_HASH, transactionsRoot: BLOCK_HASH,
    sha3Uncles: BLOCK_HASH, uncles: [],
  }),
};

async function thrownBy(script: Script): Promise<unknown> {
  try {
    await waitForTransactionReceipt(configFor(script), { hash: HASH });
  } catch (err) {
    return err;
  }
  throw new Error('waitForTransactionReceipt resolved; this case needs it to throw');
}

describe('a genuine REVERT, as wagmi actually delivers it', () => {
  it('replay reverts -> thrown, and classified as a revert', async () => {
    const err = await thrownBy({
      ...base,
      eth_getTransactionReceipt: () => receipt('0x0'),
      eth_call: () => { throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' }); },
    });
    expect((err as Error).name).toBe('CallExecutionError');
    expect(isRevertedReceiptError(err)).toBe(true);
    expect(receiptOutcome({ data: undefined, isSuccess: false, isError: true, error: err })).toEqual({
      isSuccess: false, isReverted: true, isReceiptUnreadable: false,
    });
  });

  it('replay does not reproduce the revert -> a bare Error, deliberately NOT called a revert', async () => {
    // wagmi's other exit from its revert branch. A bare Error is a shape anything can
    // throw, so it stays on the "check before you resend" side: telling a user
    // "reverted, try again" on weak evidence is the expensive mistake.
    const err = await thrownBy({
      ...base,
      eth_getTransactionReceipt: () => receipt('0x0'),
      eth_call: () => '0x',
    });
    expect(Object.getPrototypeOf(err)).toBe(Error.prototype);
    expect(isRevertedReceiptError(err)).toBe(false);
    expect(receiptOutcome({ isSuccess: false, isError: true, error: err }).isReceiptUnreadable).toBe(true);
  });

  it('the replay itself hits a transport error -> still a revert (the receipt WAS read)', async () => {
    const err = await thrownBy({
      ...base,
      eth_getTransactionReceipt: () => receipt('0x0'),
      eth_call: () => { throw Object.assign(new Error('limit exceeded'), { code: -32005 }); },
    });
    expect(isRevertedReceiptError(err)).toBe(true);
  });
});

describe('a receipt we could NOT read is never classified as a revert', () => {
  it('node answers {result: null} for the receipt -> unreadable', async () => {
    const err = await thrownBy({ ...base, eth_getTransactionReceipt: () => null });
    expect((err as Error).name).toBe('TransactionReceiptNotFoundError');
    expect(isRevertedReceiptError(err)).toBe(false);
    expect(receiptOutcome({ data: undefined, isSuccess: false, isError: true, error: err })).toEqual({
      isSuccess: false, isReverted: false, isReceiptUnreadable: true,
    });
  });

  it('node errors on the receipt read -> unreadable', async () => {
    const err = await thrownBy({
      ...base,
      eth_getTransactionReceipt: () => { throw Object.assign(new Error('limit exceeded'), { code: -32005 }); },
    });
    expect(err).toBeInstanceOf(Error);
    expect(isRevertedReceiptError(err)).toBe(false);
  });
});

describe('receiptOutcome controls', () => {
  it('a successful receipt is a success and nothing else', async () => {
    const data = await waitForTransactionReceipt(
      configFor({ ...base, eth_getTransactionReceipt: () => receipt('0x1') }),
      { hash: HASH },
    );
    expect(receiptOutcome({ data, isSuccess: true, isError: false })).toEqual({
      isSuccess: true, isReverted: false, isReceiptUnreadable: false,
    });
  });

  it('a reverted receipt delivered as DATA is still a revert (defensive; wagmi 3 throws instead)', () => {
    expect(receiptOutcome({ data: { status: 'reverted' }, isSuccess: true, isError: false })).toEqual({
      isSuccess: false, isReverted: true, isReceiptUnreadable: false,
    });
  });

  it('an error with no evidence of a revert defaults to unreadable', () => {
    for (const error of [undefined, null, 'boom', new TypeError('x'), new Error('unknown reason'), { name: 'HttpRequestError' }]) {
      expect(receiptOutcome({ isSuccess: false, isError: true, error }).isReceiptUnreadable).toBe(true);
    }
  });
});
