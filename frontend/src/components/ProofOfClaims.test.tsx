// /toweli shows the burn twice: this panel's "Burned forever" row and the bungalow's burn
// card. Both must print the same percent from the same sum, or one page gives two answers.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BUNGALOW_BURN_FACTS, EVM_BURN_ADDRESS, formatBurnPercent, tallyBurn } from '../lib/bungalowBurn';
import { TOWELI_ADDRESS } from '../lib/constants';

type ReadCell = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Query = { address: string; functionName: string; args?: readonly unknown[] };

// Keyed by token, function and args, so an answer read from the wrong slot is a failure.
// The row reads through useBungalowBurn, the hook behind the burn card, which is not mocked:
// this file holds the row to that hook's real answer.
const wagmi = vi.hoisted(() => ({ answers: new Map<string, ReadCell>() }));
const keyOf = (q: Query) => `${q.address.toLowerCase()}:${q.functionName}:${(q.args ?? []).map(String).join(',')}`;
vi.mock('wagmi', () => ({
  useReadContracts: ({ contracts }: { contracts: Query[] }) => ({
    data: contracts.map((q) => wagmi.answers.get(keyOf(q)) ?? { status: 'failure', error: new Error(`unmocked ${keyOf(q)}`) }),
  }),
}));

const { ProofOfClaims } = await import('./ProofOfClaims');

const E18 = 10n ** 18n;
const ok = (result: unknown): ReadCell => ({ status: 'success', result });
const fail = (): ReadCell => ({ status: 'failure', error: new Error('rpc down') });
const at = (fn: string, args = '') => `${TOWELI_ADDRESS.toLowerCase()}:${fn}:${args}`;

function seed(over: { supply?: ReadCell; burnAddress?: ReadCell; decimals?: ReadCell; ownBalance?: ReadCell } = {}) {
  wagmi.answers.set(at('totalSupply'), over.supply ?? ok(1_000_000_000n * E18));
  wagmi.answers.set(at('balanceOf', EVM_BURN_ADDRESS), over.burnAddress ?? ok(257_626_865_814586290000000000n));
  wagmi.answers.set(at('decimals'), over.decimals ?? ok(18));
  wagmi.answers.set(at('balanceOf', TOWELI_ADDRESS), over.ownBalance ?? ok(0n));
}

/** The percent the burn card prints for the same reading. */
function cardPercent(supplyRaw: bigint, atBurnAddressRaw: bigint): string {
  const tally = tallyBurn(BUNGALOW_BURN_FACTS.toweli!, { supplyRaw, decimals: 18, atBurnAddressRaw });
  if (!tally.ok) throw new Error(tally.reason);
  return formatBurnPercent(tally);
}

const burnRow = () => screen.queryByText('Burned forever')?.closest('a')?.textContent ?? null;

beforeEach(() => wagmi.answers.clear());

describe('ProofOfClaims, the burn row', () => {
  it('prints the same percent as the burn card, rounded down, of everything minted', () => {
    seed();
    render(<ProofOfClaims />);
    expect(cardPercent(1_000_000_000n * E18, 257_626_865_814586290000000000n)).toBe('25.76%');
    expect(burnRow()).toContain('25.76% of everything minted');
  });

  it('still agrees with the card after TOWELI is destroyed with burn()', () => {
    // 10,000,000 burnt outright: the supply falls and the old row (burn address over supply) parted from the card.
    const supply = 990_000_000n * E18;
    seed({ supply: ok(supply) });
    render(<ProofOfClaims />);
    const percent = cardPercent(supply, 257_626_865_814586290000000000n);
    expect(percent).toBe('26.76%');
    expect(burnRow()).toContain(`${percent} of everything minted`);
  });

  it.each([
    ['the burn address', { burnAddress: fail() }],
    ['the decimals', { decimals: fail() }],
    ['the token contract\'s own balance', { ownBalance: fail() }],
  ])('prints no burn row when %s could not be read, and keeps the supply row', (_leg, over) => {
    seed(over);
    render(<ProofOfClaims />);
    expect(burnRow()).toBeNull();
    expect(screen.getByText('Fixed supply (no mint function)')).toBeTruthy();
  });

  it('prints no burn row when the supply is above everything ever minted', () => {
    seed({ supply: ok(1_000_000_001n * E18) });
    render(<ProofOfClaims />);
    expect(burnRow()).toBeNull();
  });
});
