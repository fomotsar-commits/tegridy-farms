import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { parseEther } from 'viem';
import type { LendingMarket } from '../../lib/gondi/lenderPitch';
import { COLLECTIONS } from '../nftfinance/nftLendingShared';
import { LoanWall } from './LoanWall';
import { WallAxo } from './WallAxo';

const col = COLLECTIONS[0]!.address;
const market = (over: Partial<LendingMarket> = {}): LendingMarket => ({ floor: 0.05, sales30d: 76, bids: { bestBid: 0.0394, nearFloor: 0 }, ...over });
const wall = (c: HTMLElement) => c.querySelector('.l01-wall')!;

describe('the wall on the Lend tab (L-01)', () => {
  it('is decoration to a reader: hidden, with no <text> and not one word (its words are drawn from data)', () => {
    const { container } = render(<LoanWall collection={col} market={market()} loading={false} principalWei={parseEther('0.03')} shares={[]} />);
    expect(container.querySelector('.l01-wallslot')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('text')).toHaveLength(0);
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
  });

  it('says it is reading while the market read is out: no level, no loan, no zone', () => {
    const { container } = render(<LoanWall collection={col} market={undefined} loading principalWei={parseEther('0.03')} shares={[]} />);
    expect(wall(container).getAttribute('data-mode')).toBe('reading');
    expect(wall(container).hasAttribute('data-zone')).toBe(false);
    expect(container.querySelectorAll('.l01-loan')).toHaveLength(0);
  });

  it('draws nothing at a height when the floor was not read, and says so in amber', () => {
    const { container } = render(<LoanWall collection={col} market={market({ floor: null })} loading={false} principalWei={parseEther('0.03')} shares={[]} />);
    expect(wall(container).getAttribute('data-mode')).toBe('nts');
    expect(container.querySelectorAll('.l01-loan')).toHaveLength(0);
    expect(container.querySelector('.l01-wall-stamp')!.getAttribute('data-t')).toBe('NOT TO SCALE');
    expect(container.querySelector('.l01-vt-key')!.getAttribute('data-tone')).toBe('warn');
  });

  it('draws the loan as a level only to scale and only once an amount is typed, in the zone FloorBar names', () => {
    const none = render(<LoanWall collection={col} market={market()} loading={false} principalWei={null} shares={[]} />);
    expect(wall(none.container).getAttribute('data-mode')).toBe('scaled');
    expect(none.container.querySelectorAll('.l01-loan')).toHaveLength(0);
    none.unmount();
    const under = render(<LoanWall collection={col} market={market()} loading={false} principalWei={parseEther('0.03')} shares={[]} />);
    expect(under.container.querySelectorAll('.l01-loan')).toHaveLength(2);
    expect(wall(under.container).getAttribute('data-zone')).toBe('covered');
    under.unmount();
    const over = render(<LoanWall collection={col} market={market()} loading={false} principalWei={parseEther('0.06')} shares={[]} />);
    expect(wall(over.container).getAttribute('data-zone')).toBe('over-floor');
  });

  it('tags the loan with what the lender puts up, rounded up from the exact wei, to scale or not', () => {
    // 0.03 WETH and one wei is a float of 0.03: only the exact wei carried to the tag rounds it up to 0.0301.
    const loanTag = (c: HTMLElement) => c.querySelector('.l01-tag[data-k="loan"]')!.getAttribute('data-v');
    const scaled = render(<LoanWall collection={col} market={market()} loading={false} principalWei={parseEther('0.03') + 1n} shares={[]} />);
    expect(loanTag(scaled.container)).toBe('0.0301');
    scaled.unmount();
    const nts = render(<LoanWall collection={col} market={market({ floor: null })} loading={false} principalWei={parseEther('0.030049')} shares={[]} />);
    expect(loanTag(nts.container)).toBe('0.0301');
  });

  it('names the picked collection whole on its wall label: name, ticker and the whole address', () => {
    const picked = COLLECTIONS[1]!;
    const { container } = render(<LoanWall collection={picked.address} market={market()} loading={false} principalWei={null} shares={[]} />);
    const plate = container.querySelector('.l01-plate')!;
    expect(plate.getAttribute('data-t')).toBe(`${picked.name.toUpperCase()} · ${picked.symbol}`);
    expect(plate.getAttribute('data-v')).toBe(picked.address);
  });
});

describe("the hero's wall model (L-01)", () => {
  it('hangs one identical frame per lending collection, and is decoration to a reader', () => {
    const { container } = render(<WallAxo />);
    const host = container.querySelector('.l01-axo')!;
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('text')).toHaveLength(0);
    const pictures = [...container.querySelectorAll('image')];
    expect(pictures).toHaveLength(COLLECTIONS.length);
    expect(new Set(pictures.map((p) => `${p.getAttribute('width')}x${p.getAttribute('height')}`)).size).toBe(1);
    expect([...container.querySelectorAll('.l01-axo-label[data-k="plate"]')].map((l) => l.getAttribute('data-t'))).toEqual(COLLECTIONS.map((c) => c.symbol));
  });
});
