import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// WHAT THIS FILE IS FOR: the terminal now reads three chains and the two scoring
// upstreams behind it read one and a half. Getting that wrong does not produce
// an error — it produces a CONFIDENT ANSWER TO A DIFFERENT QUESTION:
//
//   Base shares Ethereum's 0x address format, so a Base token scanned without an
//   explicit override is scanned against Ethereum's holder source, which answers
//   about whatever unrelated contract lives at that address.
//
//   The deployer reputation core reads Ethereum mainnet's explorer. A visitor
//   who pastes an address on a Solana row would get that address's ETHEREUM
//   history rendered as this row's deployer score.
//
// Both are silent. Both are pinned here.

const scanSpy = vi.fn();
const deployerSpy = vi.fn();

vi.mock('./useTokenScan', () => ({
  useTokenScan: (address: string, chainOverride?: string) => {
    scanSpy(address, chainOverride);
    return { status: 'idle', chain: null, outcome: null, errorMessage: null, reload: vi.fn() };
  },
}));

vi.mock('./useDeployerReputation', () => ({
  useDeployerReputation: (address: string) => {
    deployerSpy(address);
    return { status: 'idle', reputation: null, errorMessage: null, reload: vi.fn() };
  },
}));

vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: vi.fn(() => new Promise(() => {})),
  isSupportedHeatAddress: () => false,
}));

import {
  DEPLOYER_NOT_ON_THIS_CHAIN,
  NO_CREATOR_LOOKUP_REASON,
  useTerminalSafety,
} from './useTerminalSafety';

const TOKEN_EVM = '0x1111111111111111111111111111111111111111';
const TOKEN_SOL = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';
const DEPLOYER = '0x2222222222222222222222222222222222222222';

function reasons(safety: ReturnType<typeof useTerminalSafety>['safety']): string {
  return safety.kind === 'unscored' ? safety.reasons.join(' ') : safety.gaps.join(' ');
}

beforeEach(() => {
  scanSpy.mockClear();
  deployerSpy.mockClear();
});

describe('the holder read is told which chain it is on', () => {
  it('forces the Base override — the one chain that cannot be auto-detected', () => {
    renderHook(() => useTerminalSafety({ token: TOKEN_EVM, network: 'base' }));
    expect(scanSpy).toHaveBeenCalledWith(TOKEN_EVM, 'base');
  });

  it('leaves Ethereum and Solana to auto-detect, because their formats are unambiguous', () => {
    renderHook(() => useTerminalSafety({ token: TOKEN_EVM, network: 'eth' }));
    expect(scanSpy).toHaveBeenCalledWith(TOKEN_EVM, undefined);

    scanSpy.mockClear();
    renderHook(() => useTerminalSafety({ token: TOKEN_SOL, network: 'solana' }));
    expect(scanSpy).toHaveBeenCalledWith(TOKEN_SOL, undefined);
  });

  it('with no network at all, nothing is forced — a pasted address detects itself', () => {
    renderHook(() => useTerminalSafety({ token: TOKEN_EVM }));
    expect(scanSpy).toHaveBeenCalledWith(TOKEN_EVM, undefined);
  });
});

describe('the deployer read is refused off Ethereum rather than answered wrongly', () => {
  it('IGNORES a pasted deployer on Solana — no request is made with it', () => {
    // Not merely unused: passing it through would return that address's Ethereum
    // history and present it as this Solana row's deployer score.
    const { result } = renderHook(() =>
      useTerminalSafety({ token: TOKEN_SOL, deployer: DEPLOYER, network: 'solana' }),
    );
    expect(deployerSpy).toHaveBeenCalledWith('');
    expect(deployerSpy).not.toHaveBeenCalledWith(DEPLOYER);
    expect(reasons(result.current.safety)).toContain(DEPLOYER_NOT_ON_THIS_CHAIN.solana);
  });

  it('IGNORES a pasted deployer on Base, with Base’s own sentence', () => {
    const { result } = renderHook(() =>
      useTerminalSafety({ token: TOKEN_EVM, deployer: DEPLOYER, network: 'base' }),
    );
    expect(deployerSpy).toHaveBeenCalledWith('');
    expect(reasons(result.current.safety)).toContain(DEPLOYER_NOT_ON_THIS_CHAIN.base);
  });

  it('each off-chain sentence names its OWN gap — they are different problems', () => {
    // Solana has no analogue of "contracts this address deployed"; Base has one
    // that simply is not read here. A reader deciding whether to wait for a
    // better answer needs to know which.
    expect(DEPLOYER_NOT_ON_THIS_CHAIN.solana).not.toBe(DEPLOYER_NOT_ON_THIS_CHAIN.base);
    expect(DEPLOYER_NOT_ON_THIS_CHAIN.solana).toMatch(/no equivalent read exists for Solana/i);
    expect(DEPLOYER_NOT_ON_THIS_CHAIN.base).toMatch(/Base contract creations are not read/i);
  });

  it('on Ethereum with no deployer, states the structural gap and invites the paste', () => {
    const { result } = renderHook(() => useTerminalSafety({ token: TOKEN_EVM, network: 'eth' }));
    expect(deployerSpy).toHaveBeenCalledWith('');
    expect(reasons(result.current.safety)).toContain(NO_CREATOR_LOOKUP_REASON);
    expect(NO_CREATOR_LOOKUP_REASON).toMatch(/no contract-creator lookup/i);
  });

  it('on Ethereum a pasted deployer IS used', () => {
    renderHook(() =>
      useTerminalSafety({ token: TOKEN_EVM, deployer: DEPLOYER, network: 'eth' }),
    );
    expect(deployerSpy).toHaveBeenCalledWith(DEPLOYER);
  });
});

describe('no chain can reach a pass on this build', () => {
  it('every network leaves the row unscored with an idle holder read', () => {
    // The deployer half is unread on all three, so `assessRowSafety` can only
    // return `unscored` (idle holder read finds nothing to state). A build that
    // ever flipped this to `scored`+`complete` would be claiming a full read
    // that no code path performs.
    for (const network of ['eth', 'base', 'solana'] as const) {
      const { result } = renderHook(() =>
        useTerminalSafety({ token: network === 'solana' ? TOKEN_SOL : TOKEN_EVM, network }),
      );
      expect(result.current.safety.kind).toBe('unscored');
    }
  });
});
