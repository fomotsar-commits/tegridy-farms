import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { useNFTBoost } from './useNFTBoost';

const USER = '0xffffffffffffffffffffffffffffffffffffffff' as `0x${string}`;

// Contract addresses from the hook (duplicated here intentionally so the tests
// fail loudly if someone moves them without updating the hook).
const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9';
const GOLD = '0x6aa03f42c5366e2664c887eb2e90844ca00b92f3';

describe('useNFTBoost', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('defaults to no boost when user holds neither collection', () => {
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.holdsJBAC).toBe(false);
    expect(result.current.holdsGoldCard).toBe(false);
    expect(result.current.jbacCount).toBe(0);
    expect(result.current.goldCardCount).toBe(0);
    expect(result.current.boostMultiplier).toBe(1); // baseline
    expect(result.current.boostLabel).toBeNull();
  });

  it('flips holdsJBAC when balanceOf on JBAC returns > 0', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: JBAC, result: 1n });
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.holdsJBAC).toBe(true);
    expect(result.current.jbacCount).toBe(1);
    expect(result.current.boostMultiplier).toBe(1.5);
    expect(result.current.boostLabel).toBe('JBAC +0.5x');
  });

  it('jbacCount reflects the actual balance when > 1', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: JBAC, result: 7n });
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.jbacCount).toBe(7);
  });

  it('boost stays 1.5x regardless of JBAC count above 1', () => {
    // The contract-level boost is binary (hold any JBAC → +0.5x).
    // jbacCount is cosmetic; it doesn't stack in the UI label.
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: JBAC, result: 100n });
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.boostMultiplier).toBe(1.5);
  });

  it('Gold Card holder without JBAC: no on-chain boost, labelled as cosmetic', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: GOLD, result: 1n });
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.holdsJBAC).toBe(false);
    expect(result.current.holdsGoldCard).toBe(true);
    expect(result.current.goldCardCount).toBe(1);
    expect(result.current.boostMultiplier).toBe(1);
    expect(result.current.boostLabel).toBe('Gold Card (no on-chain boost)');
  });

  it('holding both: JBAC label takes precedence (boost matters more than Gold)', () => {
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: JBAC, result: 1n });
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: GOLD, result: 3n });
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.holdsJBAC).toBe(true);
    expect(result.current.holdsGoldCard).toBe(true);
    expect(result.current.boostMultiplier).toBe(1.5);
    expect(result.current.boostLabel).toBe('JBAC +0.5x');
  });

  it('clamps jbacCount to Number.MAX_SAFE_INTEGER on absurd balances', () => {
    // Guard against a misreported uint256 that would overflow Number conversion.
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: JBAC, result: huge });
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.jbacCount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns undefined-safe zero state when reads fail', () => {
    wagmiMock.setReadResult({
      functionName: 'balanceOf',
      address: JBAC,
      result: undefined,
      status: 'failure',
    });
    wagmiMock.setReadResult({
      functionName: 'balanceOf',
      address: GOLD,
      result: undefined,
      status: 'failure',
    });
    const { result } = renderHook(() => useNFTBoost());
    expect(result.current.holdsJBAC).toBe(false);
    expect(result.current.holdsGoldCard).toBe(false);
    expect(result.current.boostMultiplier).toBe(1);
  });
});
