import type { ReactNode } from 'react';

/**
 * The mark on a card you have money in.
 *
 * Owner, 2026-10-14: "have a glow around the staking or lp card position if a
 * person has staked so its easier to spot". Every card already pulses purple,
 * so the one you are in wears a steady green ring instead (`position-glow`,
 * index.css) and this pill says it in words, for anyone who does not see green.
 *
 * Same two lines on every staking and LP card (positionGlow.parity.test.ts
 * holds the siblings together): `positionHost(...)` on the card's outer box,
 * `<PositionMark inPosition={…} />` as its first child.
 */
export function positionHost(base: string, inPosition: boolean): string {
  return inPosition ? `${base} position-glow` : base;
}

export function PositionMark({
  inPosition,
  children = 'You’re in',
}: {
  /** True once a read found this wallet's stake or pool share here. Never while unread. */
  inPosition: boolean;
  children?: ReactNode;
}) {
  if (!inPosition) return null;
  return (
    <span
      data-testid="position-mark"
      className="pointer-events-none absolute right-3 top-3 z-20 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
      style={{ background: 'var(--color-kyle)', color: '#04120a', boxShadow: '0 0 12px var(--color-kyle-60)' }}
    >
      {children}
    </span>
  );
}
