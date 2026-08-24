import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
import { CurveCreateView } from './CurveCreatePanel';

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> });
  return { m: { ...passthrough, div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> }, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});

function view() {
  const onCreate = vi.fn();
  render(<CurveCreateView pending={false} onCreate={onCreate} />);
  return { onCreate };
}

describe('CurveCreateView', () => {
  it('keeps Create disabled until name and symbol are both present', () => {
    view();
    const btn = screen.getByRole('button', { name: /create launch/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Towelie Jr' } });
    expect(btn).toBeDisabled(); // still no symbol
    fireEvent.change(screen.getByLabelText(/token symbol/i), { target: { value: 'twljr' } });
    expect(btn).not.toBeDisabled();
  });

  it('uppercases the symbol and passes a zero opening buy when the field is blank', () => {
    const { onCreate } = view();
    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Towelie Jr' } });
    fireEvent.change(screen.getByLabelText(/token symbol/i), { target: { value: 'twljr' } });
    fireEvent.click(screen.getByRole('button', { name: /create launch/i }));
    expect(onCreate).toHaveBeenCalledWith('Towelie Jr', 'TWLJR', 0n);
  });

  it('parses a non-blank opening buy into wei', () => {
    const { onCreate } = view();
    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText(/token symbol/i), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText(/opening buy/i), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: /create launch/i }));
    expect(onCreate).toHaveBeenCalledWith('A', 'A', parseEther('0.5'));
  });

  it('blocks an un-parseable opening buy', () => {
    view();
    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText(/token symbol/i), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText(/opening buy/i), { target: { value: '.' } });
    expect(screen.getByRole('button', { name: /create launch/i })).toBeDisabled();
  });
});
