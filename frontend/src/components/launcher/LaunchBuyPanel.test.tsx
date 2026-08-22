// The buy surface's job is to be unbuyable whenever it cannot tell the truth.
//
// Three failures are pinned because each one, shipped, is a loss of the user's money
// rather than a cosmetic defect:
//   1. A failed pool read must read as a failed read, never as "no pool" and never as a
//      buyable state.
//   2. A failed quote must block the buy and say why. There is no minimum-of-zero path.
//   3. The minimum rendered must be the minimum inside the calldata that gets signed —
//      asserted by decoding the very calldata handed to the wallet, not by re-deriving it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { decodeAbiParameters, decodeFunctionData, formatEther, type Address, type Hex } from 'viem';

const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' as Address;
const HOOK = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

const readContract = vi.fn();
// One stable client object: wagmi memoizes its client, and a fresh identity per render
// would re-fire the pool read forever.
const publicClient = { readContract };
vi.mock('wagmi', () => ({ usePublicClient: () => publicClient }));

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

// Typed against the real hook signature rather than inferred from the zero-arg
// impl. Inferred, `mock.calls[0]` is a zero-length tuple, and the params this
// file decodes below had to be recovered through a hand-written shape — a shape
// that was free to drift from `LaunchBuyParams` without anything noticing.
const buyOneClick = vi.fn<(params: LaunchBuyParams) => Promise<string>>(async () => '0xbatchid');
const hookState = { canBatch: true, buyOneClick };
vi.mock('../../hooks/useOneClickLaunchBuy', () => ({ useOneClickLaunchBuy: () => hookState }));

const quoteExactInputV4 = vi.fn();
vi.mock('@whetstone-research/doppler-sdk/evm', () => ({
  Quoter: class {
    quoteExactInputV4(p: unknown) {
      return quoteExactInputV4(p);
    }
  },
  getAddresses: () => ({ universalRouter: ROUTER }),
}));

import { LaunchBuyPanel, QUOTE_TTL_SECONDS } from './LaunchBuyPanel';
import { UNIVERSAL_ROUTER_EXECUTE_ABI, type LaunchBuyParams } from '../../lib/launcher/launchBuy';

/** The pool the auction hook reports: native ETH is currency0, the launch token currency1. */
const POOL_TUPLE = [NATIVE, TOKEN, 8_388_608, -60, HOOK] as const;

const NOW = 1_800_000_000;
let clock = NOW;

function renderPanel(extra: Partial<React.ComponentProps<typeof LaunchBuyPanel>> = {}) {
  return render(
    <LaunchBuyPanel
      hookAddress={HOOK}
      tokenAddress={TOKEN}
      tokenSymbol="TEG"
      numeraire={NATIVE}
      now={() => clock}
      {...extra}
    />,
  );
}

/** Pull `amountOutMinimum` back out of the UR calldata the wallet was handed. */
function encodedMinOut(data: Hex): bigint {
  const { args } = decodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI, data });
  const [, inputs] = args as readonly [Hex, readonly Hex[], bigint];
  const [, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!) as readonly [
    Hex,
    readonly Hex[],
  ];
  const [swap] = decodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    params[0]!,
  ) as readonly [{ amountOutMinimum: bigint }];
  return swap.amountOutMinimum;
}

async function quoteFor(amount: string, slippage?: string) {
  await screen.findByLabelText('Amount of ETH to spend');
  fireEvent.change(screen.getByLabelText('Amount of ETH to spend'), { target: { value: amount } });
  if (slippage !== undefined) {
    fireEvent.change(screen.getByLabelText('Slippage tolerance in basis points'), {
      target: { value: slippage },
    });
  }
  fireEvent.click(screen.getByRole('button', { name: /get quote/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clock = NOW;
  hookState.canBatch = true;
  readContract.mockResolvedValue(POOL_TUPLE);
  quoteExactInputV4.mockResolvedValue({ amountOut: 1_000_000n });
});

describe('reading the pool', () => {
  it('reports an unreadable pool as OUR failure and offers nothing to press', async () => {
    readContract.mockRejectedValue(new Error('rpc down'));
    renderPanel();
    expect(await screen.findByText(/couldn’t read this launch’s pool/i)).toBeTruthy();
    // The read failure is attributed to us, not reported as an absent pool.
    expect(screen.getByText(/problem on our side/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /get quote/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^buy/i })).toBeNull();
  });

  it('reads the pool key off the hook rather than assuming it', async () => {
    renderPanel();
    await screen.findByLabelText('Amount of ETH to spend');
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: HOOK, functionName: 'poolKey' }),
    );
  });
});

describe('wallets that cannot batch atomically', () => {
  it('says so and offers no partial path', async () => {
    hookState.canBatch = false;
    renderPanel();
    expect(await screen.findByText(/doesn’t advertise atomic batching/i)).toBeTruthy();
    expect(screen.getByText(/won’t offer a partial version/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /get quote/i })).toBeNull();
  });
});

describe('quoting', () => {
  it('blocks the buy with a stated reason when the quote cannot be obtained', async () => {
    quoteExactInputV4.mockRejectedValue(new Error('execution reverted'));
    renderPanel();
    await quoteFor('1');
    expect(await screen.findByText(/this buy wasn’t sent/i)).toBeTruthy();
    expect(screen.getByText(/couldn’t get a price/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^buy TEG$/i })).toBeNull();
    expect(buyOneClick).not.toHaveBeenCalled();
  });

  it('blocks the buy when the pool quotes zero out', async () => {
    quoteExactInputV4.mockResolvedValue({ amountOut: 0n });
    renderPanel();
    await quoteFor('1');
    expect(await screen.findByText(/zero tokens out/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^buy TEG$/i })).toBeNull();
  });

  it('refuses an out-of-range slippage rather than quietly clamping it', async () => {
    renderPanel();
    await quoteFor('1', '9000');
    expect(await screen.findByText(/slippage must be a whole number/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^buy TEG$/i })).toBeNull();
  });
});

describe('the number shown is the number signed', () => {
  it('renders the encoded minimum, and hands the wallet that exact calldata', async () => {
    renderPanel();
    await quoteFor('1', '250');
    const minOut = 975_000n; // 2.5% off a 1,000,000 quote

    await screen.findByText(/minimum you receive/i);
    expect(screen.getByText(`${formatEther(minOut)} TEG`)).toBeTruthy();
    expect(screen.getByText('250 bps')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^buy TEG$/i }));
    await waitFor(() => expect(buyOneClick).toHaveBeenCalledTimes(1));
    const params = buyOneClick.mock.calls[0][0];
    // `WalletCall.data` is OPTIONAL — a plain value transfer carries no calldata.
    // The hand-written shape this test used to cast to declared it required,
    // which is not what `WalletCall` says, so assert it is there rather than
    // assume it: a buy submitted with no calldata is the failure worth naming.
    expect(params.swapCall.data, 'the buy was submitted with no calldata').toBeDefined();
    expect(encodedMinOut(params.swapCall.data ?? '0x')).toBe(minOut);
    expect(params.amountInWei).toBe(10n ** 18n);
    expect(params.swapCall.to.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(BigInt(params.swapCall.value!)).toBe(10n ** 18n); // native buy carries its own value
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('will not submit a quote the auction has already repriced past', async () => {
    renderPanel();
    await quoteFor('1');
    const buy = await screen.findByRole('button', { name: /^buy TEG$/i });
    expect((buy as HTMLButtonElement).disabled).toBe(false);

    // The staleness hint repaints on a timer, so the button can still be live when the
    // quote ages out. Clicking it anyway must refuse rather than send an old floor.
    clock = NOW + QUOTE_TTL_SECONDS + 1;
    fireEvent.click(buy);
    expect(await screen.findByText(/this buy wasn’t sent/i)).toBeTruthy();
    expect(screen.getByText(/repriced since/i)).toBeTruthy();
    expect(buyOneClick).not.toHaveBeenCalled();
  });

  it('surfaces a wallet rejection as an unsent buy', async () => {
    buyOneClick.mockRejectedValueOnce(new Error('User rejected the request.'));
    renderPanel();
    await quoteFor('1');
    fireEvent.click(await screen.findByRole('button', { name: /^buy TEG$/i }));
    expect(await screen.findByText(/this buy wasn’t sent/i)).toBeTruthy();
    expect(screen.getByText(/user rejected the request/i)).toBeTruthy();
    expect(toastError).toHaveBeenCalled();
  });
});
