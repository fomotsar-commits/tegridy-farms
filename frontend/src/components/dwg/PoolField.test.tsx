import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNGALOWS } from '../../lib/bungalows';
import { publishFieldPools, resetField, setFieldHot, setFieldView, type FieldPool } from '../../lib/solana/lp/fieldStore';
import { PoolField } from './PoolField';
import { FeeManifold } from './FeeManifold';
import { FIELD_ASPECT } from './tankFarm';

const registry = BUNGALOWS.filter((b) => b.chain === 'solana' && b.address && b.venueSolPool);
const tanks = (root: HTMLElement) => [...root.querySelectorAll('.p01-tank')];
const names = (root: HTMLElement) => [...root.querySelectorAll('.p01-tag')].map((t) => t.getAttribute('data-t'));
const pool = (n: number, usd: number | null): FieldPool => ({ address: `pool${n}`, tokenMint: `mint${n}`, name: `C${n}/SOL`, usd });

beforeEach(() => resetField());

describe('the tank farm on /pools (P-01)', () => {
  it('draws the registry at once, before any read: one dry tank per island coin with a venue pool', () => {
    expect(registry.length).toBeGreaterThan(0);
    const { container } = render(<PoolField />);
    expect(tanks(container)).toHaveLength(registry.length);
    expect(tanks(container).every((t) => t.hasAttribute('data-dry'))).toBe(true);
    expect(container.querySelectorAll('.p01-water')).toHaveLength(0);
    expect(new Set(names(container))).toEqual(new Set(registry.map((b) => `${b.symbol}/SOL`)));
  });

  it('draws every pool the list read once it lands, and water only where its dollars were read', () => {
    const { container } = render(<PoolField />);
    act(() => publishFieldPools([pool(0, 14_524), pool(1, null), pool(2, 212.4), pool(3, null), pool(4, 0)]));
    expect(tanks(container)).toHaveLength(5);
    expect(container.querySelectorAll('.p01-water')).toHaveLength(3);
    expect(tanks(container).filter((t) => t.hasAttribute('data-dry'))).toHaveLength(2);
    expect(names(container)).toContain('C1/SOL');
  });

  it('goes back to the registry, dry, when the list is gone', () => {
    const { container } = render(<PoolField />);
    act(() => publishFieldPools([pool(0, 14_524)]));
    act(() => publishFieldPools(null));
    expect(tanks(container)).toHaveLength(registry.length);
    expect(container.querySelectorAll('.p01-water')).toHaveLength(0);
  });

  it('lights the tank a pointer is on, in the list or on the drawing, and a press does what its View does', () => {
    const view = vi.fn();
    const { container } = render(<PoolField />);
    act(() => {
      publishFieldPools([pool(0, 500), pool(1, 50)]);
      setFieldView(view);
    });
    act(() => setFieldHot('pool1'));
    expect(container.querySelectorAll('.p01-tank[data-hot]')).toHaveLength(1);
    expect(container.querySelector('.p01-tag[data-hot]')?.getAttribute('data-t')).toBe('C1/SOL');
    act(() => setFieldHot(null));
    expect(container.querySelectorAll('[data-hot]')).toHaveLength(0);
    // The first pool is drawn last, nearest the eye.
    const first = tanks(container).at(-1)!;
    fireEvent.pointerEnter(first);
    expect(container.querySelector('.p01-tank[data-hot]')).toBe(first);
    fireEvent.click(first);
    expect(view).toHaveBeenCalledWith('mint0');
  });

  it('is decoration to a reader: hidden, and not one word in it (its names are drawn from data-t)', () => {
    const { container } = render(<PoolField />);
    act(() => publishFieldPools([pool(0, 14_524), pool(1, null)]));
    const root = container.firstElementChild!;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.textContent).toBe('');
    expect(root.querySelector('text')).toBeNull();
  });

  it('has the shape the sheet makes room for (styles/dwg-pools.css --p01-aspect)', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/dwg-pools.css'), 'utf8');
    expect(Number(/--p01-aspect:\s*([\d.]+);/.exec(css)?.[1])).toBe(FIELD_ASPECT);
  });
});

describe('the fee manifold in Rates (P-01)', () => {
  it('draws nothing for a tier that was not read', () => {
    const { container } = render(<FeeManifold tier={null} />);
    expect(container.innerHTML).toBe('');
  });

  it("draws a read tier's split, each pipe as wide as its share, and no word", () => {
    const { container } = render(<FeeManifold tier={{ tradeFeeRate: 10_000n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n }} />);
    const width = (sel: string) => Number(container.querySelector(sel)?.getAttribute('stroke-width'));
    expect(width('.p01-pipe-pool') / width('.p01-pipe-in')).toBeCloseTo(0.84, 6);
    expect(width('.p01-pipe-venue') / width('.p01-pipe-in')).toBeCloseTo(0.16, 6);
    const root = container.firstElementChild!;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.textContent).toBe('');
  });
});
