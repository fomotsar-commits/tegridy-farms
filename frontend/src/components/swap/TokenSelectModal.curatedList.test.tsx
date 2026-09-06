import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TokenSelectModal } from './TokenSelectModal';
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';

/**
 * 🔴 THE CURATED LIST IS ETHEREUM'S, AND MUST NOT BE OFFERED ELSEWHERE.
 *
 * `DEFAULT_TOKENS` is a list of MAINNET ERC20 addresses. The same symbol sits at
 * a DIFFERENT address on Base, and this repo carries seven addresses that are a
 * different live contract on another chain. Until 2026-09-06 this modal always
 * rendered that list, which was harmless only because every surface using it was
 * pinned to mainnet.
 *
 * Making useAddLiquidity chain-parametric REMOVED that pin — so a wallet on Base
 * could have picked "USDC" from a curated list and added liquidity against an
 * address that is not USDC there. That is the footgun this prop closes: the
 * caller decides what is curated FOR THIS CHAIN, and off mainnet the answer is
 * nothing. What is withdrawn is a LIST presented as authoritative on a chain it
 * was not curated for — the import flow is untouched and is not covered here.
 */
vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useReadContract: () => ({ data: undefined, isLoading: false }),
  useReadContracts: () => ({ data: undefined, isLoading: false }),
  usePublicClient: () => null,
  useAccount: () => ({ address: undefined, isConnected: false }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const CUSTOM: TokenInfo = {
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'MINE',
  name: 'My Token',
  decimals: 18,
};

function mount(tokens: TokenInfo[] | undefined, customTokens: TokenInfo[] = []) {
  return render(
    <TokenSelectModal
      open
      onClose={() => {}}
      onSelect={() => {}}
      customTokens={customTokens}
      onAddCustomToken={() => {}}
      {...(tokens === undefined ? {} : { tokens })}
    />,
  );
}

describe('TokenSelectModal — the curated list is per chain', () => {
  it('offers Ethereum’s list when that is what it is given', () => {
    expect(DEFAULT_TOKENS.length, 'fixture is vacuous — no curated tokens exist').toBeGreaterThan(1);
    mount(DEFAULT_TOKENS);
    // A curated entry that is NOT the native token, so this cannot pass on the
    // ETH row alone.
    const erc20 = DEFAULT_TOKENS.find((t) => !t.isNative)!;
    expect(screen.getAllByText(erc20.symbol).length).toBeGreaterThan(0);
  });

  it('offers NOTHING curated when handed an empty list — the off-mainnet case', () => {
    mount([]);
    const erc20s = DEFAULT_TOKENS.filter((t) => !t.isNative);
    const leaked = erc20s
      .filter((t) => screen.queryAllByText(t.symbol).length > 0)
      .map((t) => `${t.symbol} (${t.address})`);
    expect(
      leaked,
      'a MAINNET token address is being offered on a chain it was not curated for — ' +
        'that symbol is a different contract, or nothing, at that address there',
    ).toEqual([]);
  });

  // NOT ASSERTED HERE: that a pasted address still works off mainnet. That is
  // the IMPORT flow (validateAddress -> onAddCustomToken), not this list, and I
  // could not render it deterministically without standing up the wagmi reads it
  // makes. Saying so rather than shipping a test that pretends to cover it.

  it('defaults to Ethereum’s list when no prop is passed, so existing callers are unchanged', () => {
    mount(undefined);
    const erc20 = DEFAULT_TOKENS.find((t) => !t.isNative)!;
    expect(screen.getAllByText(erc20.symbol).length).toBeGreaterThan(0);
  });
});
