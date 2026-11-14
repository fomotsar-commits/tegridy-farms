// Harvest's figure draws the run, not the money: one plate per claim, every plate the same size,
// and each plate says only where its claim stands. A claimed plate is down on the pad; any other
// is afloat above it.
import { describe, it, expect } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { HarvestStack, type StackPlate } from './HarvestStack';

const plate = (key: string, chain: StackPlate['chain'], state: StackPlate['state'] = null): StackPlate => ({ key, chain, accent: '#6fd9a8', state });

/** How far a plate stands off the pad, in sheet pixels, from the lift its group carries. */
const liftOf = (root: HTMLElement, key: string) => {
  const t = (root.querySelector(`[data-plate="${key}"]`) as SVGGElement).style.transform;
  return Math.abs(Number(/translateY\((-?[\d.]+)px\)/.exec(t)?.[1] ?? 0));
};
const sizeOf = (root: HTMLElement, key: string) => {
  const top = root.querySelectorAll(`[data-plate="${key}"] polygon`)[2]!.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
  const xs = top.map((p) => p[0]!);
  const ys = top.map((p) => p[1]!);
  return `${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}x${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}`;
};

describe("Harvest's figure", () => {
  it('draws one plate per claim, every one the same size whatever it pays, as a picture', () => {
    const plates = [plate('a', 'solana'), plate('b', 'solana'), plate('c', 'ethereum'), plate('d', 'base')];
    const { container, getByTestId } = render(<HarvestStack plates={plates} />);
    expect(container.querySelectorAll('[data-plate]')).toHaveLength(4);
    expect(new Set(plates.map((p) => sizeOf(container, p.key))).size).toBe(1);
    expect(getByTestId('harvest-stack').getAttribute('aria-hidden')).toBe('true');
    // One stack per network, named on the ground, in the order a harvest runs.
    expect(Array.from(container.querySelectorAll('text')).map((t) => t.textContent)).toEqual(['Solana', 'Ethereum', 'Base']);
  });

  it('ready to claim: each plate afloat above the last, in the order it will be sent', async () => {
    const { container } = render(<HarvestStack plates={[plate('a', 'solana'), plate('b', 'solana'), plate('c', 'solana')]} />);
    await waitFor(() => expect(liftOf(container, 'a')).toBeGreaterThan(0));
    expect(liftOf(container, 'b')).toBeGreaterThan(liftOf(container, 'a'));
    expect(liftOf(container, 'c')).toBeGreaterThan(liftOf(container, 'b'));
    expect(Array.from(container.querySelectorAll('[data-plate]')).map((g) => g.getAttribute('data-state'))).toEqual(['ready', 'ready', 'ready']);
  });

  it('a claimed plate comes down on the pad, each on the last; the plate at the wallet stands clear of the rest', async () => {
    const plates = [plate('a', 'solana', 'claimed'), plate('b', 'solana', 'claimed'), plate('c', 'solana', 'sending'), plate('d', 'solana', 'waiting')];
    const { container } = render(<HarvestStack plates={plates} />);
    await waitFor(() => expect(liftOf(container, 'd')).toBeGreaterThan(0));
    expect(liftOf(container, 'a')).toBe(0);
    // The second claimed plate rests on the first: one plate's thickness up, no air between.
    const thick = liftOf(container, 'b');
    expect(thick).toBeGreaterThan(0);
    expect(liftOf(container, 'c')).toBeGreaterThan(thick * 3);
    expect(liftOf(container, 'd')).toBeGreaterThan(liftOf(container, 'b'));
  });

  it.each(['reverted', 'unconfirmed', 'declined', 'not-sent'] as const)('a claim that came to "%s" is left afloat, never down with the claimed', async (state) => {
    const { container } = render(<HarvestStack plates={[plate('a', 'base', 'claimed'), plate('b', 'base', state)]} />);
    await waitFor(() => expect(liftOf(container, 'b')).toBeGreaterThan(0));
    expect(liftOf(container, 'a')).toBe(0);
    expect(container.querySelector('[data-plate="b"]')!.getAttribute('data-state')).toBe(state);
    // Its plate is not the claimed green.
    const top = container.querySelectorAll('[data-plate="b"] polygon')[2]!;
    expect(top.getAttribute('fill')).not.toBe(container.querySelectorAll('[data-plate="a"] polygon')[2]!.getAttribute('fill'));
  });

  it('while the pools are read there is no plate: the pad alone, with the line crossing it', () => {
    const { container } = render(<HarvestStack plates={[]} reading />);
    expect(container.querySelectorAll('[data-plate]')).toHaveLength(0);
    expect(container.querySelector('.harvest-scan')).not.toBeNull();
    expect(container.querySelector('text')).toBeNull();
  });

  it('nothing to claim is the pad alone, still: never a plate that reads as a reward', () => {
    const { container } = render(<HarvestStack plates={[]} />);
    expect(container.querySelectorAll('[data-plate]')).toHaveLength(0);
    expect(container.querySelector('.harvest-scan')).toBeNull();
  });
});
