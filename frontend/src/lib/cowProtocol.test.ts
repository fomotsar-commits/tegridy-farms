import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, stringToHex, getAddress } from 'viem';
import {
  COW_SETTLEMENT_ADDRESS,
  COW_VAULT_RELAYER_ADDRESS,
  COW_APP_DATA_DOC,
  COW_APP_DATA_HASH,
  COW_ORDER_TYPES,
  cowDomain,
  buildLimitSellOrder,
  toOrderSubmission,
  cowOrderbookUrl,
  isTerminalStatus,
} from './cowProtocol';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USER = '0x1111111111111111111111111111111111111111';

describe('cowProtocol', () => {
  it('uses the canonical GPv2 settlement + vault-relayer addresses (valid checksum)', () => {
    expect(COW_SETTLEMENT_ADDRESS.toLowerCase()).toBe('0x9008d19f58aabd9ed0d60971565aa8510560ab41');
    expect(COW_VAULT_RELAYER_ADDRESS.toLowerCase()).toBe('0xc92e8bdf79f0507f65a392b0ab4667716bfe0110');
    // EIP-55 checksum is valid (getAddress throws on an invalid mixed-case literal).
    expect(getAddress(COW_SETTLEMENT_ADDRESS)).toBe(COW_SETTLEMENT_ADDRESS);
    expect(getAddress(COW_VAULT_RELAYER_ADDRESS)).toBe(COW_VAULT_RELAYER_ADDRESS);
  });

  it('appData hash is the deterministic keccak256 of the appData doc (CoW re-derives + verifies this)', () => {
    expect(COW_APP_DATA_HASH).toBe(keccak256(stringToHex(COW_APP_DATA_DOC)));
    expect(COW_APP_DATA_HASH).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.parse(COW_APP_DATA_DOC).appCode).toBe('Tegridy Farms');
  });

  it('cowDomain binds verifyingContract to the settlement contract', () => {
    const d = cowDomain(1);
    expect(d.name).toBe('Gnosis Protocol');
    expect(d.version).toBe('v2');
    expect(d.chainId).toBe(1);
    expect(d.verifyingContract).toBe(COW_SETTLEMENT_ADDRESS);
  });

  it('Order EIP-712 type matches the canonical GPv2 field order (consensus-critical)', () => {
    expect(COW_ORDER_TYPES.Order.map((f) => f.name)).toEqual([
      'sellToken',
      'buyToken',
      'receiver',
      'sellAmount',
      'buyAmount',
      'validTo',
      'appData',
      'feeAmount',
      'kind',
      'partiallyFillable',
      'sellTokenBalance',
      'buyTokenBalance',
    ]);
  });

  it('buildLimitSellOrder builds a zero-fee sell order at the limit buyAmount', () => {
    const order = buildLimitSellOrder({
      sellToken: WETH,
      buyToken: USDC,
      sellAmount: 1_000000000000000000n,
      buyAmount: 4000_000000n,
      validTo: 2_000_000_000,
      receiver: USER,
    });
    expect(order.kind).toBe('sell');
    expect(order.feeAmount).toBe(0n);
    expect(order.partiallyFillable).toBe(false);
    expect(order.appData).toBe(COW_APP_DATA_HASH);
    expect(order.sellAmount).toBe(1_000000000000000000n);
    expect(order.buyAmount).toBe(4000_000000n);
    expect(order.sellTokenBalance).toBe('erc20');
    expect(order.buyTokenBalance).toBe('erc20');
    expect(order.validTo).toBe(2_000_000_000);
  });

  it('toOrderSubmission stringifies bigints + attaches signature, scheme, appData doc + hash', () => {
    const order = buildLimitSellOrder({
      sellToken: WETH,
      buyToken: USDC,
      sellAmount: 1_000000000000000000n,
      buyAmount: 4000_000000n,
      validTo: 2_000_000_000,
      receiver: USER,
    });
    const sig = ('0x' + 'ab'.repeat(65)) as `0x${string}`;
    const sub = toOrderSubmission(order, sig, USER);
    expect(sub.sellAmount).toBe('1000000000000000000');
    expect(sub.buyAmount).toBe('4000000000');
    expect(sub.feeAmount).toBe('0');
    expect(sub.signingScheme).toBe('eip712');
    expect(sub.signature).toBe(sig);
    expect(sub.from).toBe(USER);
    expect(sub.appData).toBe(COW_APP_DATA_DOC);
    expect(sub.appDataHash).toBe(COW_APP_DATA_HASH);
    // The submitted doc must re-hash to the submitted hash — exactly what CoW checks.
    expect(keccak256(stringToHex(sub.appData))).toBe(sub.appDataHash);
  });

  it('cowOrderbookUrl routes through the hardened aggregator proxy', () => {
    expect(cowOrderbookUrl('orders')).toBe('/api/cow/mainnet/api/v1/orders');
    expect(cowOrderbookUrl('orders/0xdeadbeef')).toBe('/api/cow/mainnet/api/v1/orders/0xdeadbeef');
  });

  // The invariant behind the literal above: whatever base cowOrderbookUrl emits,
  // frontend/vercel.json must actually rewrite it to the aggregator function. The
  // proxy is a FLAT function serving `/api/aggregator` exactly, so an unrewritten
  // base (e.g. the old `/api/aggregator/cow/...`) 404/405s in prod with no local
  // signal. This reads the real deploy config so the two can't drift apart.
  it('cowOrderbookUrl emits a base that vercel.json actually rewrites', () => {
    // jsdom's import.meta.url isn't a file: URL, so anchor on cwd instead
    // (vitest runs from frontend/; tolerate a repo-root invocation too).
    const candidates = [
      resolve(process.cwd(), 'vercel.json'),
      resolve(process.cwd(), 'frontend/vercel.json'),
    ];
    const configPath = candidates.find((p) => existsSync(p));
    expect(configPath, `vercel.json not found in ${candidates.join(' or ')}`).toBeTruthy();

    const vercelConfig = JSON.parse(readFileSync(configPath!, 'utf8')) as {
      rewrites: { source: string; destination: string }[];
    };

    const url = cowOrderbookUrl('orders');
    // Turn each rewrite source ("/api/cow/:path*") into a matcher.
    const matched = vercelConfig.rewrites.filter((r) =>
      new RegExp(`^${r.source.replace(/:path\*/, '.+').replace(/\*/g, '')}$`).test(url),
    );

    expect(matched.length).toBeGreaterThan(0);
    // It must land on the aggregator function with provider=cow — not the SPA fallback.
    expect(matched[0].destination).toContain('/api/aggregator');
    expect(matched[0].destination).toContain('provider=cow');
  });

  it('isTerminalStatus identifies settled/cancelled/expired orders', () => {
    expect(isTerminalStatus('fulfilled')).toBe(true);
    expect(isTerminalStatus('traded')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('expired')).toBe(true);
    expect(isTerminalStatus('open')).toBe(false);
    expect(isTerminalStatus('active')).toBe(false);
  });
});
