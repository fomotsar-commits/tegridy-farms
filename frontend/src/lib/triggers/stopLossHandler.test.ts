// The handler binding.
//
// The struct layout is the consensus-critical part: the handler decodes these bytes
// positionally, so a field inserted or reordered here changes which number is the
// strike. The round trip below is the pin.
//
// The two dials are the honesty part. Both default off, and the reason is asymmetric:
// a missing handler or a missing feed produces an order that never fires while the
// user believes it is watching. Nothing may be inferred, defaulted, or repaired into
// existence.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, slice, toFunctionSelector } from 'viem';
import {
  buildCreateStopLossCalldata,
  encodeStopLossStaticInput,
  feedFor,
  stopLossHandlerAddress,
  triggerPriceFeeds,
  type StopLossData,
} from './stopLossHandler';
import { COMPOSABLE_COW_CREATE_ABI } from '../composableCow';
import { COW_APP_DATA_HASH } from '../cowProtocol';

const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;
const FEED_A = '0x2222222222222222222222222222222222222222' as const;
const FEED_B = '0x3333333333333333333333333333333333333333' as const;
const HANDLER = '0x4444444444444444444444444444444444444444' as const;
const ZERO = '0x0000000000000000000000000000000000000000';

const DATA: StopLossData = {
  sellToken: TOWELI,
  buyToken: WETH,
  sellAmount: 1000n * 10n ** 18n,
  buyAmount: 495n * 10n ** 18n,
  appData: COW_APP_DATA_HASH,
  receiver: USER,
  isSellOrder: true,
  isPartiallyFillable: false,
  validityBucketSeconds: 900n,
  sellTokenPriceOracle: FEED_A,
  buyTokenPriceOracle: FEED_B,
  strike: 5n * 10n ** 17n,
  maxTimeSinceLastOracleUpdate: 3600n,
};

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('the StopLoss Data struct round-trips through its exact layout', () => {
  it('decodes back to the same field values in the same order', () => {
    const [decoded] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'sellToken', type: 'address' },
            { name: 'buyToken', type: 'address' },
            { name: 'sellAmount', type: 'uint256' },
            { name: 'buyAmount', type: 'uint256' },
            { name: 'appData', type: 'bytes32' },
            { name: 'receiver', type: 'address' },
            { name: 'isSellOrder', type: 'bool' },
            { name: 'isPartiallyFillable', type: 'bool' },
            { name: 'validityBucketSeconds', type: 'uint256' },
            { name: 'sellTokenPriceOracle', type: 'address' },
            { name: 'buyTokenPriceOracle', type: 'address' },
            { name: 'strike', type: 'int256' },
            { name: 'maxTimeSinceLastOracleUpdate', type: 'uint256' },
          ],
        },
      ],
      encodeStopLossStaticInput(DATA),
    );

    // No `as [Record<string, unknown>]`: viem already infers the exact struct
    // from the components above, so the field reads below are checked against the
    // layout this test is asserting rather than against a bag of `unknown`.
    expect(decoded.sellToken.toLowerCase()).toBe(TOWELI.toLowerCase());
    expect(decoded.buyToken.toLowerCase()).toBe(WETH.toLowerCase());
    expect(decoded.sellAmount).toBe(DATA.sellAmount);
    expect(decoded.buyAmount).toBe(DATA.buyAmount);
    expect(decoded.appData).toBe(COW_APP_DATA_HASH);
    expect(decoded.isSellOrder).toBe(true);
    expect(decoded.isPartiallyFillable).toBe(false);
    expect(decoded.validityBucketSeconds).toBe(900n);
    expect(decoded.sellTokenPriceOracle.toLowerCase()).toBe(FEED_A.toLowerCase());
    expect(decoded.buyTokenPriceOracle.toLowerCase()).toBe(FEED_B.toLowerCase());
    expect(decoded.strike).toBe(DATA.strike);
    expect(decoded.maxTimeSinceLastOracleUpdate).toBe(3600n);
  });
});

describe('buildCreateStopLossCalldata', () => {
  it('encodes ComposableCoW.create against the handler it was handed', () => {
    const salt = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    const calldata = buildCreateStopLossCalldata({ handler: HANDLER, data: DATA, salt });
    expect(slice(calldata, 0, 4)).toBe(toFunctionSelector(COMPOSABLE_COW_CREATE_ABI[0]));

    const { functionName, args } = decodeFunctionData({ abi: COMPOSABLE_COW_CREATE_ABI, data: calldata });
    expect(functionName).toBe('create');
    const params = (args as readonly unknown[])[0] as { handler: string; salt: string; staticInput: string };
    expect(params.handler.toLowerCase()).toBe(HANDLER.toLowerCase());
    expect(params.salt).toBe(salt);
    expect(params.staticInput).toBe(encodeStopLossStaticInput(DATA));
    expect((args as readonly unknown[])[1]).toBe(true);
  });
});

describe('the handler dial has no fallback', () => {
  it('is null with nothing configured', () => {
    expect(stopLossHandlerAddress()).toBeNull();
  });

  it('rejects the zero address rather than treating it as a deployment', () => {
    vi.stubEnv('VITE_COW_STOP_LOSS_HANDLER', ZERO);
    expect(stopLossHandlerAddress()).toBeNull();
  });

  it('rejects a malformed address rather than repairing it', () => {
    for (const bad of ['0x1234', 'not-an-address', '4444444444444444444444444444444444444444', '   ']) {
      vi.stubEnv('VITE_COW_STOP_LOSS_HANDLER', bad);
      expect(stopLossHandlerAddress()).toBeNull();
    }
  });

  it('accepts a well-formed address', () => {
    vi.stubEnv('VITE_COW_STOP_LOSS_HANDLER', HANDLER);
    expect(stopLossHandlerAddress()).toBe(HANDLER);
  });
});

describe('the feed registry drops what it cannot parse', () => {
  it('is empty with nothing configured', () => {
    expect(triggerPriceFeeds()).toEqual({});
    expect(feedFor(TOWELI)).toBeNull();
  });

  it('parses well-formed triples and is address-case insensitive on lookup', () => {
    vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${TOWELI}:${FEED_A}:8, ${WETH}:${FEED_B}:18`);
    expect(feedFor(TOWELI.toLowerCase())).toEqual({ token: TOWELI, feed: FEED_A, decimals: 8 });
    expect(feedFor(WETH)).toEqual({ token: WETH, feed: FEED_B, decimals: 18 });
  });

  it('drops an entry with a bad feed rather than keeping the token half', () => {
    vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${TOWELI}:0xdead:8`);
    expect(feedFor(TOWELI)).toBeNull();
  });

  it('drops an entry pointing at the zero address', () => {
    vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${TOWELI}:${ZERO}:8`);
    expect(feedFor(TOWELI)).toBeNull();
  });

  it('drops an entry with nonsense decimals rather than assuming 8', () => {
    for (const dec of ['0', '99', 'eight', '8.5', '']) {
      vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${TOWELI}:${FEED_A}:${dec}`);
      expect(feedFor(TOWELI)).toBeNull();
    }
  });

  it('keeps the good entries in a list that also contains a bad one', () => {
    vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `garbage, ${WETH}:${FEED_B}:8`);
    expect(feedFor(WETH)).not.toBeNull();
    expect(Object.keys(triggerPriceFeeds())).toHaveLength(1);
  });
});
