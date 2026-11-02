/**
 * The network drop-down: all five networks listed, the lit one marked, a network the section
 * has nothing on greyed with its reason and never picked, and a keyboard way in and out.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChainPicker, type ChainPickerOption } from './ChainPicker';

const OPTIONS: ChainPickerOption[] = [
  { chain: 'ethereum', enabled: true, note: 'Uniswap / CoW' },
  { chain: 'base', enabled: false, note: 'No swap here' },
  { chain: 'robinhood', enabled: false, note: 'No swap here' },
  { chain: 'solana', enabled: true, note: 'Our pools + Jupiter' },
  { chain: 'cardano', enabled: true, note: 'Minswap pools' },
];

const mount = (onPick = vi.fn()) => {
  render(<ChainPicker label="Swap network" active="ethereum" options={OPTIONS} onPick={onPick} />);
  return onPick;
};

const button = () => screen.getByRole('button', { name: 'Swap network: Ethereum' });

describe('ChainPicker', () => {
  it('is closed until pressed, then lists all five networks with the lit one selected', () => {
    mount();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'EthereumUniswap / CoW',
      'BaseNo swap here',
      'Robinhood ChainNo swap here',
      'SolanaOur pools + Jupiter',
      'CardanoMinswap pools',
    ]);
    expect(screen.getByRole('option', { name: /Ethereum/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Base/ })).toHaveAttribute('aria-disabled', 'true');
    expect(document.body.textContent).not.toMatch(/soon/i);
  });

  it('picks an open network and closes', () => {
    const onPick = mount();
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('option', { name: /Solana/ }));
    expect(onPick).toHaveBeenCalledWith('solana');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('never picks a greyed network, nor the one already lit', () => {
    const onPick = mount();
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('option', { name: /Base/ }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /Ethereum/ }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('opens on the lit network for the keyboard, moves with the arrows and closes on Escape', () => {
    mount();
    fireEvent.keyDown(button(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Ethereum/ })).toHaveFocus();
    // Up from the first wraps to the last: Cardano.
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Cardano/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(button()).toHaveFocus();
  });

  it('closes on a press outside it', () => {
    mount();
    fireEvent.click(button());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
