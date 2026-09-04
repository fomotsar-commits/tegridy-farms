import { describe, it, expect } from 'vitest';
import { CONFIGURED_CHAIN_IDS } from '../chains/registry';
import type { Invoice } from './invoice';
import {
  hasPaymentLinkChain,
  judgeSettleToken,
  PAYMENT_LINK_CHAIN_IDS,
  settleTokenKnownOnChain,
  settleTokensFor,
  type SettleTokenRead,
} from './settleTokens';

const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-000001',
    merchant: '0x1111111111111111111111111111111111111111',
    chainId: 1,
    settleToken: MAINNET_USDC as `0x${string}`,
    settleSymbol: 'USDC',
    settleDecimals: 6,
    settleAmount: 100_000_000n,
    memo: '',
    expiresAt: 1_760_000_900,
    createdAt: 1_760_000_000,
    ...over,
  };
}

describe('the settle table is the source of which chains can carry a link', () => {
  it('names exactly the five verified mainnet assets', () => {
    expect(settleTokensFor(1).map((t) => t.symbol).sort()).toEqual(['DAI', 'Toweli', 'USDC', 'USDT', 'WETH']);
  });

  it('carries the symbol the CONTRACT returns, not the trade list label', () => {
    // 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D answers symbol() = "Toweli"
    // (mainnet read 2026-09-02). Signing the trade list's "TOWELI" would make
    // every TOWELI invoice refuse itself as a token mismatch in the buyer's own
    // settle-token check — this pins the override that prevents it.
    const toweli = settleTokensFor(1).find((t) => t.address.toLowerCase() === '0x420698cfdeddea6bc78d59bc17798113ad278f9d');
    expect(toweli?.symbol).toBe('Toweli');
    expect(settleTokensFor(1).map((t) => t.symbol)).not.toContain('TOWELI');
  });

  it('offers nothing on a chain with no verified asset, rather than mainnet\'s list', () => {
    // Both are CONFIGURED chains — viemChains serves them — and neither has a
    // registered settlement token. An empty answer is the point: a link minted
    // here would name an address a buyer could never pay.
    expect(CONFIGURED_CHAIN_IDS).toContain(8453);
    expect(CONFIGURED_CHAIN_IDS).toContain(4663);
    expect(settleTokensFor(8453)).toEqual([]);
    expect(settleTokensFor(4663)).toEqual([]);
    expect(settleTokensFor(999_999)).toEqual([]);
    expect(settleTokensFor(null)).toEqual([]);
  });

  it('does not let a mainnet address count as known on another chain', () => {
    expect(settleTokenKnownOnChain(1, MAINNET_USDC)?.symbol).toBe('USDC');
    expect(settleTokenKnownOnChain(1, MAINNET_USDC.toLowerCase())?.symbol).toBe('USDC');
    expect(settleTokenKnownOnChain(8453, MAINNET_USDC)).toBeNull();
  });

  it('derives the mintable chains from the table and not from the configured set', () => {
    expect([...PAYMENT_LINK_CHAIN_IDS]).toEqual([1]);
    expect(hasPaymentLinkChain()).toBe(true);
    // The distinction the pill rests on: the configured set is strictly larger,
    // so a condition keyed on it could never be false.
    expect(CONFIGURED_CHAIN_IDS.length).toBeGreaterThan(PAYMENT_LINK_CHAIN_IDS.length);
  });
});

describe('re-reading the signed token: four outcomes, none of them each other', () => {
  const read = (over: Partial<Extract<SettleTokenRead, { kind: 'read' }>> = {}): SettleTokenRead => ({
    kind: 'read',
    hasCode: true,
    symbol: 'USDC',
    decimals: 6,
    ...over,
  });

  it('matches when the contract agrees with every signed figure', () => {
    expect(judgeSettleToken(invoice(), read())).toBe('matches');
  });

  it('calls an address with no bytecode no-code, never mismatch', () => {
    expect(judgeSettleToken(invoice(), read({ hasCode: false, symbol: null, decimals: null }))).toBe('no-code');
  });

  it('calls a wrong decimal count a mismatch even when the symbol agrees', () => {
    // The 18-vs-6 case is the damaging one: same name, amounts off by 10^12.
    expect(judgeSettleToken(invoice(), read({ decimals: 18 }))).toBe('mismatch');
  });

  it('calls a wrong symbol a mismatch, case-sensitively', () => {
    expect(judgeSettleToken(invoice(), read({ symbol: 'usdc' }))).toBe('mismatch');
  });

  it('never lets a failed read become a refusal of the invoice', () => {
    // An implementation that folds `unread` into `no-code` or `mismatch` tells a
    // buyer their merchant's token is fake every time an RPC rate-limits them.
    expect(judgeSettleToken(invoice(), { kind: 'unread', detail: 'rpc down' })).toBe('unread');
  });

  it('never convicts on a partial read', () => {
    // Code is there, symbol() answered, decimals() did not. Comparing against a
    // null would answer 'mismatch' about something nobody read.
    expect(judgeSettleToken(invoice(), read({ decimals: null }))).toBe('unread');
    expect(judgeSettleToken(invoice(), read({ symbol: null }))).toBe('unread');
  });
});
