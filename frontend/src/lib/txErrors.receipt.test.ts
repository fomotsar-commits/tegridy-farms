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
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConfig, WagmiProvider, useWaitForTransactionReceipt } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { custom } from 'viem';
import { foundry } from 'viem/chains';
import { isRevertedReceiptError, noteReplacement, receiptOutcome } from './txErrors';

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
    expect(receiptOutcome({ data: undefined, isSuccess: false, isError: true, error: err }, HASH)).toEqual({
      isSuccess: false, isReverted: true, isReceiptUnreadable: false, isReplaced: false, replacement: null,
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
    expect(receiptOutcome({ isSuccess: false, isError: true, error: err }, HASH).isReceiptUnreadable).toBe(true);
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
    expect(receiptOutcome({ data: undefined, isSuccess: false, isError: true, error: err }, HASH)).toEqual({
      isSuccess: false, isReverted: false, isReceiptUnreadable: true, isReplaced: false, replacement: null,
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
    expect(receiptOutcome({ data, isSuccess: true, isError: false }, HASH)).toEqual({
      isSuccess: true, isReverted: false, isReceiptUnreadable: false, isReplaced: false, replacement: null,
    });
  });

  it('a reverted receipt delivered as DATA is still a revert (defensive; wagmi 3 throws instead)', () => {
    expect(receiptOutcome({ data: { status: 'reverted', transactionHash: HASH }, isSuccess: true, isError: false }, HASH)).toEqual({
      isSuccess: false, isReverted: true, isReceiptUnreadable: false, isReplaced: false, replacement: null,
    });
  });

  it('an error with no evidence of a revert defaults to unreadable', () => {
    for (const error of [undefined, null, 'boom', new TypeError('x'), new Error('unknown reason'), { name: 'HttpRequestError' }]) {
      expect(receiptOutcome({ isSuccess: false, isError: true, error }, HASH).isReceiptUnreadable).toBe(true);
    }
  });
});

// ─── A REPLACED transaction ─────────────────────────────────────────────────
// The wallet put another transaction at the submitted one's nonce, and that one
// mined. The node has no receipt for the submitted hash; getTransaction still
// returns it pending (viem needs that to look for a replacement), and the latest
// block holds a same-sender, same-nonce transaction whose receipt is success.
const R_HASH = '0x3333333333333333333333333333333333333333333333333333333333333333';
const REPLACEMENTS = {
  // What a wallet "cancel" sends: 0 value, to yourself, no calldata.
  cancelled: { to: FROM, input: '0x', value: '0x0' },
  // What a wallet "speed up" sends: the same call with more gas.
  repriced: { to: TO, input: '0xa9059cbb', value: '0x0', maxFeePerGas: '0x77359400' },
  // Anything else at that nonce.
  replaced: { to: TO, input: '0xdeadbeef', value: '0x0' },
} as const;
type Kind = keyof typeof REPLACEMENTS;

let submittedSeq = 0;
/** A fresh submitted hash per case: viem's reason is recorded per submitted hash. */
function replacedBy(kind: Kind): { hash: `0x${string}`; script: Script } {
  submittedSeq += 1;
  const hash = `0x${submittedSeq.toString(16).padStart(64, '9')}` as `0x${string}`;
  const pending = { ...tx, hash, input: '0xa9059cbb', nonce: '0x7', blockHash: null, blockNumber: null, transactionIndex: null };
  const mined = { ...tx, ...REPLACEMENTS[kind], hash: R_HASH, nonce: '0x7', blockNumber: '0x6' };
  return {
    hash,
    script: {
      ...base,
      eth_blockNumber: () => '0x6',
      eth_getTransactionByHash: ([h]) => (h === hash ? pending : mined),
      eth_getBlockByNumber: () => ({ ...(base.eth_getBlockByNumber!([]) as object), number: '0x6', transactions: [mined] }),
      eth_getTransactionReceipt: ([h]) =>
        h === hash ? null : { ...receipt('0x1'), transactionHash: R_HASH, to: mined.to, blockNumber: '0x6' },
    },
  };
}

describe('a REPLACED transaction, as wagmi actually delivers it', () => {
  for (const kind of Object.keys(REPLACEMENTS) as Kind[]) {
    it(`${kind}: the wait RESOLVES with the replacement's success receipt, and only onReplaced says why`, async () => {
      const { hash, script } = replacedBy(kind);
      const reasons: string[] = [];
      const data = await waitForTransactionReceipt(configFor(script), {
        hash,
        onReplaced: (r) => { reasons.push(r.reason); noteReplacement(r); },
      });
      // The measured fact this whole fix rests on. If wagmi or viem start throwing
      // here instead, this goes red and the handling below needs revisiting.
      expect(data.status).toBe('success');
      expect(data.transactionHash).toBe(R_HASH);
      expect(data.transactionHash).not.toBe(hash);
      expect(reasons).toEqual([kind]);

      const outcome = receiptOutcome({ data, isSuccess: true, isError: false }, hash);
      expect(outcome.replacement).toEqual({ hash: R_HASH, reason: kind });
      if (kind === 'repriced') {
        // A speed-up is the same call. It ran.
        expect(outcome).toMatchObject({ isSuccess: true, isReplaced: false });
      } else {
        expect(outcome).toMatchObject({ isSuccess: false, isReplaced: true, isReverted: false, isReceiptUnreadable: false });
      }
    });
  }

  it('without onReplaced the reason is unknown, so even a speed-up is not called a success', async () => {
    const { hash, script } = replacedBy('repriced');
    const data = await waitForTransactionReceipt(configFor(script), { hash });
    expect(receiptOutcome({ data, isSuccess: true, isError: false }, hash)).toMatchObject({
      isSuccess: false, isReplaced: true, replacement: { hash: R_HASH, reason: 'unknown' },
    });
  });

  // The hook is what the surfaces call. This pins that it forwards `onReplaced`
  // to the action: if it stopped, every speed-up would read as "replaced".
  for (const kind of ['cancelled', 'repriced'] as const) {
    it(`${kind}, through the real useWaitForTransactionReceipt hook`, async () => {
      const { hash, script } = replacedBy(kind);
      const config = configFor(script);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(WagmiProvider, { config }, createElement(QueryClientProvider, { client }, children));
      const { result } = renderHook(
        () => useWaitForTransactionReceipt({ hash, chainId: foundry.id, onReplaced: noteReplacement }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      // What every surface read as "my transaction succeeded" before this fix.
      expect(result.current.data?.status).toBe('success');
      expect(result.current.data?.transactionHash).toBe(R_HASH);
      const outcome = receiptOutcome(result.current, hash);
      expect(outcome.replacement?.reason).toBe(kind);
      expect(outcome.isSuccess).toBe(kind === 'repriced');
    });
  }
});
