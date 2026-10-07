// An address on a card: short by default, whole on a press, copied whole, linked only
// when the caller has a link.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { AddressRow } from './AddressRow';

/** The venue's BAYLA/SOL pool (MAINNET_FACTS.md): a real 44-character address. */
const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const SHORT = 'Ervz…z5w4';
const URL = `https://solscan.io/account/${POOL}`;

let writeText: ReturnType<typeof vi.fn<(t: string) => Promise<void>>>;
beforeEach(() => {
  writeText = vi.fn(async (_t: string) => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
});
afterEach(() => vi.unstubAllGlobals());

describe('AddressRow', () => {
  it('collapsed: the label, and first4…last4 on a 44px press that says it is collapsed; the whole value is not on the page', () => {
    expect(POOL).toHaveLength(44);
    render(<AddressRow label="Pool address" value={POOL} />);
    const group = screen.getByRole('group', { name: 'Pool address' });
    const toggle = within(group).getByRole('button', { name: `${SHORT} Show whole` });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.className).toContain('min-h-[44px]');
    expect(within(group).queryByText(POOL)).toBeNull();
  });

  it('a press shows the whole 44 characters and says so; a second press hides them again', () => {
    render(<AddressRow label="Pool address" value={POOL} />);
    fireEvent.click(screen.getByRole('button', { name: `${SHORT} Show whole` }));
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(POOL)).toBeInTheDocument();
    fireEvent.click(less);
    expect(screen.queryByText(POOL)).toBeNull();
    expect(screen.getByRole('button', { name: `${SHORT} Show whole` })).toHaveAttribute('aria-expanded', 'false');
  });

  it('Copy is a 44px press that copies the whole value, never the short form', async () => {
    render(<AddressRow label="Pool address" value={POOL} />);
    const copy = screen.getByRole('button', { name: 'Copy' });
    expect(copy.className).toContain('min-h-[44px]');
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(POOL);
    expect(writeText).not.toHaveBeenCalledWith(SHORT);
  });

  it('with an explorer url: a 44px link to it in a new tab; without one: no link at all', () => {
    const { unmount } = render(<AddressRow label="Pool address" value={POOL} explorerUrl={URL} />);
    const link = screen.getByRole('link', { name: 'Explorer' });
    expect(link).toHaveAttribute('href', URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.className).toContain('min-h-[44px]');
    unmount();

    render(<AddressRow label="Pool address" value={POOL} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Explorer')).toBeNull();
    render(<AddressRow label="Token" value={POOL} explorerUrl={null} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('no em dash anywhere in the row, collapsed or expanded', () => {
    const { container } = render(<AddressRow label="Pool address" value={POOL} explorerUrl={URL} />);
    expect(container.textContent).not.toMatch(/—/);
    fireEvent.click(screen.getByRole('button', { name: `${SHORT} Show whole` }));
    expect(container.textContent).not.toMatch(/—/);
  });
});
