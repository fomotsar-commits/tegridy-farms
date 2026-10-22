// The L2 pool list says only what its reads returned: "No pools yet" only when
// allPairsLength() answered 0, "could not read" for a factory or a pool that did not answer,
// and a dash for a reserve that did not land.
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BASE, BRB, BRB_PAIR, answer, fake, oneBrbPool, resetFake } from '../../test/fakeFactory';

vi.mock('wagmi', async () => {
  const f = await import('../../test/fakeFactory');
  return { useReadContract: f.useReadContract, useReadContracts: f.useReadContracts };
});

import { ChainPoolTable } from './ChainPoolTable';

const show = (chainId = 8453) => render(<ChainPoolTable chainId={chainId} onPick={vi.fn()} />);
const rowOf = (name: RegExp) => screen.getByRole('rowheader', { name }).closest('tr')!;

beforeEach(resetFake);

describe('the pool list on Base and Robinhood Chain', () => {
  it('says "No pools yet" when the factory answered 0', () => {
    fake.length = { data: 0n, isError: false };
    show();
    expect(screen.getByRole('status')).toHaveTextContent('No pools yet.');
  });

  it('says it could not read, never "no pools", when the factory did not answer', () => {
    fake.length = { data: undefined, isError: true };
    show();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read Base pools.');
    expect(screen.queryByText(/No pools yet/)).toBeNull();
  });

  it('says it is reading while the count is on its way', () => {
    show(4663);
    expect(screen.getByRole('status')).toHaveTextContent('Reading Robinhood Chain pools');
    expect(screen.queryByText(/No pools yet/)).toBeNull();
  });

  it('names a pool it could not read, with no Add or Remove', () => {
    oneBrbPool();
    fake.length = { data: 2n, isError: false };
    show();
    expect(rowOf(/BRB \/ ETH/)).toBeInTheDocument();
    const lost = rowOf(/Pool 2: could not read/);
    expect(within(lost).queryByRole('link', { name: 'Add' })).toBeNull();
    expect(lost).toHaveTextContent('not read');
  });

  it('draws an unread reserve as a dash, and says the cut is on once kLast is set', () => {
    oneBrbPool();
    fake.answers.delete(`${BRB_PAIR.toLowerCase()}:getReserves:`);
    answer(BRB_PAIR, 'kLast', 123n);
    show();
    const row = rowOf(/BRB \/ ETH/);
    expect(row).toHaveTextContent('– BRB');
    expect(row).not.toHaveTextContent('0.0000');
    expect(row).toHaveTextContent('0.3% fee: 0.25% to providers');
  });

  it('says the split is not read when kLast did not answer', () => {
    oneBrbPool();
    fake.answers.delete(`${BRB_PAIR.toLowerCase()}:kLast:`);
    show();
    expect(rowOf(/BRB \/ ETH/)).toHaveTextContent('0.3% fee, split not read');
  });

  it('shows a token that copies a listed name, or is not plain ASCII, by its address', () => {
    oneBrbPool();
    answer(BRB, 'symbol', 'USDC');
    show();
    expect(screen.queryByText(/USDC/)).toBeNull();
    expect(rowOf(/0x0e86\.\.\.e0d8 \/ ETH/)).toBeInTheDocument();

    resetFake();
    oneBrbPool();
    answer(BRB, 'symbol', 'UЅDC');
    show();
    expect(screen.getAllByRole('rowheader', { name: /0x0e86\.\.\.e0d8 \/ ETH/ }).length).toBeGreaterThan(0);
  });

  it('refuses a token with more than 18 decimals, as the token picker does', () => {
    oneBrbPool();
    answer(BRB, 'decimals', 24);
    show();
    const row = rowOf(/BRB \/ ETH/);
    expect(within(row).queryByRole('link', { name: 'Add' })).toBeNull();
    expect(row).toHaveTextContent('not supported');
  });

  it('links the pool to its explorer on its own chain', () => {
    oneBrbPool();
    show();
    expect(within(rowOf(/BRB \/ ETH/)).getByRole('link', { name: '0x0000...b4b1' }))
      .toHaveAttribute('href', `https://basescan.org/address/${BRB_PAIR}`);
    expect(BASE.chainId).toBe(8453);
  });
});
