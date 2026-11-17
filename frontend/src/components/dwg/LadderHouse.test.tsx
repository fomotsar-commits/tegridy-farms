import { describe, it, expect, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { BUNGALOWS } from '../../lib/bungalows';
import { publishLadderPick, type LadderPick } from '../../lib/ladderPick';
import { LadderHouse } from './LadderHouse';
import { rungZ } from './ladderScene';
import { U } from '../../lib/isoBungalow';

const room = BUNGALOWS.find((b) => b.id === 'bayla')!;
const RUNGS = [4_000, 4_600, 6_100, 8_300, 12_900, 21_900, 40_000].map((bps, i) => ({ bps, lock: `L${i}`, weight: `${(bps / 10_000).toFixed(2)}×` }));
const pick = (over: Partial<LadderPick> = {}): LadderPick => ({ rungs: RUNGS, picked: 0, held: null, meter: 'idle', ...over });

afterEach(() => publishLadderPick(room.id, null));

describe('the ladder house on a staking pool page (S-01)', () => {
  it('is decoration to a reader: hidden, with no <text> and not one word (its words are drawn from data)', () => {
    const { container } = render(<LadderHouse room={room} place="hero" pick={pick()} />);
    const host = container.querySelector('.s01-house')!;
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('text')).toHaveLength(0);
    expect(host.textContent).toBe('');
  });

  it('draws only the two rungs the contract fixes, and no pick, before a staircase publishes', () => {
    const { container } = render(<LadderHouse room={room} place="hero" />);
    expect(container.querySelectorAll('.s01-rung')).toHaveLength(2);
    expect(container.querySelector('.s01-pick')).toBeNull();
    expect(container.querySelector('.s01-tag')).toBeNull();
  });

  it('draws a rung for every lock the staircase published, and moves its pick to the rung pressed', () => {
    const { container } = render(<LadderHouse room={room} place="hero" />);
    act(() => publishLadderPick(room.id, pick({ picked: 0 })));
    expect(container.querySelectorAll('.s01-rung')).toHaveLength(RUNGS.length);
    const runOf = () => (container.querySelector('.s01-pick-run') as SVGElement).style.transform;
    expect(runOf()).toBe(`scaleY(${Math.round(rungZ(RUNGS[0]!.bps) * U * 100) / 100})`);
    expect(container.querySelector('.s01-tag')!.getAttribute('data-t')).toBe(RUNGS[0]!.weight);
    act(() => publishLadderPick(room.id, pick({ picked: 6 })));
    expect(runOf()).toBe(`scaleY(${Math.round(rungZ(RUNGS[6]!.bps) * U * 100) / 100})`);
    expect(container.querySelector('.s01-tag')!.getAttribute('data-u')).toBe(RUNGS[6]!.lock);
    expect(container.querySelectorAll('.s01-rung[data-climbed]')).toHaveLength(6);
  });

  it("takes the ladder card's own pick over the store's, so the card's figure never waits on a publish", () => {
    publishLadderPick(room.id, pick({ picked: 6 }));
    const { container } = render(<LadderHouse room={room} place="rail" pick={pick({ picked: 2 })} />);
    expect(container.querySelector('.s01-house')!.getAttribute('data-place')).toBe('rail');
    expect(container.querySelector('.s01-tag')!.getAttribute('data-u')).toBe(RUNGS[2]!.lock);
  });

  it('lights the house and marks each position only for a wallet read to hold one: not read is neither', () => {
    const lit = (c: HTMLElement) => c.querySelector('.s01-fig')!.getAttribute('data-lit');
    const unread = render(<LadderHouse room={room} place="hero" pick={pick({ held: null })} />);
    expect(lit(unread.container)).toBe('0');
    expect(unread.container.querySelectorAll('.s01-held')).toHaveLength(0);
    unread.unmount();
    const none = render(<LadderHouse room={room} place="hero" pick={pick({ held: [] })} />);
    expect(lit(none.container)).toBe('0');
    none.unmount();
    const holds = render(<LadderHouse room={room} place="hero" pick={pick({ held: [8_300, 40_000], meter: 'live' })} />);
    expect(lit(holds.container)).toBe('1');
    expect(holds.container.querySelectorAll('.s01-held')).toHaveLength(2);
    expect(holds.container.querySelector('.s01-meterbox')!.getAttribute('data-meter')).toBe('live');
  });
});
