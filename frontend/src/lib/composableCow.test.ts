import { describe, it, expect } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, toFunctionSelector, slice } from 'viem';
import {
  planTwap,
  twapDataFromPlan,
  encodeTwapStaticInput,
  buildCreateTwapCalldata,
  randomSalt,
  COMPOSABLE_COW_CREATE_ABI,
  TWAP_HANDLER_ADDRESS,
  TWAP_MAX_PARTS,
  type TwapData,
} from './composableCow';
import { COW_APP_DATA_HASH } from './cowProtocol';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

const SELL_SCALE = 10n ** 18n; // WETH decimals

describe('planTwap — schedule math', () => {
  it('splits an evenly divisible total into equal parts', () => {
    const plan = planTwap({
      totalSellAmount: 12n * SELL_SCALE,
      parts: 4,
      intervalSeconds: 3600,
      priceNumerator: 25_000_000n * 10n ** 18n, // 25M TOWELI per 1 WETH
      priceScale: SELL_SCALE,
      startTime: 1000,
    });
    expect(plan.valid).toBe(true);
    expect(plan.error).toBeNull();
    expect(plan.partSellAmount).toBe(3n * SELL_SCALE);
    expect(plan.actualTotalSell).toBe(12n * SELL_SCALE);
    expect(plan.dust).toBe(0n);
    expect(plan.n).toBe(4n);
    expect(plan.t).toBe(3600n);
    expect(plan.span).toBe(0n);
    expect(plan.t0).toBe(1000n);
    // minPartLimit = partSell * price / scale = 3 * 25M *1e18
    expect(plan.minPartLimit).toBe(3n * 25_000_000n * 10n ** 18n);
    expect(plan.minTotalBuy).toBe(plan.minPartLimit * 4n);
  });

  it('reports dust when the total is not evenly divisible', () => {
    const plan = planTwap({
      totalSellAmount: 10n,
      parts: 3,
      intervalSeconds: 60,
      priceNumerator: 1n,
      priceScale: 1n,
    });
    expect(plan.valid).toBe(true);
    expect(plan.partSellAmount).toBe(3n); // floor(10/3)
    expect(plan.actualTotalSell).toBe(9n);
    expect(plan.dust).toBe(1n);
  });

  it('rejects parts outside the allowed range', () => {
    expect(planTwap({ totalSellAmount: 100n, parts: 1, intervalSeconds: 60, priceNumerator: 1n, priceScale: 1n }).valid).toBe(false);
    expect(planTwap({ totalSellAmount: 100n, parts: TWAP_MAX_PARTS + 1, intervalSeconds: 60, priceNumerator: 1n, priceScale: 1n }).valid).toBe(false);
    expect(planTwap({ totalSellAmount: 100n, parts: 2.5, intervalSeconds: 60, priceNumerator: 1n, priceScale: 1n }).valid).toBe(false);
  });

  it('rejects an interval below the 60s floor', () => {
    const plan = planTwap({ totalSellAmount: 100n, parts: 2, intervalSeconds: 30, priceNumerator: 1n, priceScale: 1n });
    expect(plan.valid).toBe(false);
  });

  it('rejects a span larger than the interval', () => {
    const plan = planTwap({ totalSellAmount: 100n, parts: 2, intervalSeconds: 60, spanSeconds: 120, priceNumerator: 1n, priceScale: 1n });
    expect(plan.valid).toBe(false);
  });

  it('rejects a total too small to split', () => {
    const plan = planTwap({ totalSellAmount: 2n, parts: 3, intervalSeconds: 60, priceNumerator: 1n, priceScale: 1n });
    expect(plan.valid).toBe(false); // floor(2/3) = 0
  });

  it('rejects a non-positive price', () => {
    expect(planTwap({ totalSellAmount: 100n, parts: 2, intervalSeconds: 60, priceNumerator: 0n, priceScale: 1n }).valid).toBe(false);
  });
});

describe('encodeTwapStaticInput — round trips through the exact struct layout', () => {
  const data: TwapData = {
    sellToken: WETH,
    buyToken: TOWELI,
    receiver: USER,
    partSellAmount: 3n * SELL_SCALE,
    minPartLimit: 75_000_000n * 10n ** 18n,
    t0: 1234n,
    n: 4n,
    t: 3600n,
    span: 0n,
    appData: COW_APP_DATA_HASH,
  };

  it('decodes back to the same field values in order', () => {
    const encoded = encodeTwapStaticInput(data);
    const [decoded] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'sellToken', type: 'address' },
            { name: 'buyToken', type: 'address' },
            { name: 'receiver', type: 'address' },
            { name: 'partSellAmount', type: 'uint256' },
            { name: 'minPartLimit', type: 'uint256' },
            { name: 't0', type: 'uint256' },
            { name: 'n', type: 'uint256' },
            { name: 't', type: 'uint256' },
            { name: 'span', type: 'uint256' },
            { name: 'appData', type: 'bytes32' },
          ],
        },
      ],
      encoded,
    );
    // No `as [Record<string, unknown>]`: viem already infers the exact struct
    // from the components above, so the field reads below are checked against the
    // layout this test is asserting rather than against a bag of `unknown`.
    expect(decoded.sellToken.toLowerCase()).toBe(WETH.toLowerCase());
    expect(decoded.buyToken.toLowerCase()).toBe(TOWELI.toLowerCase());
    expect(decoded.partSellAmount).toBe(3n * SELL_SCALE);
    expect(decoded.minPartLimit).toBe(75_000_000n * 10n ** 18n);
    expect(decoded.t0).toBe(1234n);
    expect(decoded.n).toBe(4n);
    expect(decoded.t).toBe(3600n);
    expect(decoded.span).toBe(0n);
    expect(decoded.appData).toBe(COW_APP_DATA_HASH);
  });
});

describe('buildCreateTwapCalldata', () => {
  it('encodes ComposableCoW.create with the TWAP handler and round-trips', () => {
    const plan = planTwap({
      totalSellAmount: 4n * SELL_SCALE,
      parts: 2,
      intervalSeconds: 3600,
      priceNumerator: 10_000_000n * 10n ** 18n,
      priceScale: SELL_SCALE,
      startTime: 500,
    });
    const data = twapDataFromPlan(plan, { sellToken: WETH, buyToken: TOWELI, receiver: USER });
    const salt = ('0x' + '11'.repeat(32)) as `0x${string}`;
    const calldata = buildCreateTwapCalldata({ data, salt, dispatch: true });

    // selector matches create(...)
    const selector = slice(calldata, 0, 4);
    expect(selector).toBe(toFunctionSelector(COMPOSABLE_COW_CREATE_ABI[0]));

    const { functionName, args } = decodeFunctionData({ abi: COMPOSABLE_COW_CREATE_ABI, data: calldata });
    expect(functionName).toBe('create');
    const params = (args as readonly unknown[])[0] as { handler: string; salt: string; staticInput: string };
    expect(params.handler.toLowerCase()).toBe(TWAP_HANDLER_ADDRESS.toLowerCase());
    expect(params.salt).toBe(salt);
    expect((args as readonly unknown[])[1]).toBe(true);
  });
});

describe('randomSalt', () => {
  it('returns a 32-byte hex and differs across calls', () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
