// The burn card's contract: a figure only from a full read, an outage said in words, and
// copy that names this bungalow's token and no other. The hook is mocked one module up;
// its own reads are pinned in useBungalowBurn.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BUNGALOWS, type Bungalow } from '../../lib/bungalows';
import { BUNGALOW_BURN_FACTS, mintedRawOf, tallyBurn, type BurnTally } from '../../lib/bungalowBurn';
import type { BungalowBurn as BurnState } from '../../hooks/useBungalowBurn';

const hook = vi.hoisted(() => ({
  burn: { status: 'idle' } as unknown,
  isReading: false,
  refresh: vi.fn(),
}));
vi.mock('../../hooks/useBungalowBurn', () => ({
  useBungalowBurn: () => ({ burn: hook.burn, isReading: hook.isReading, refresh: hook.refresh }),
}));

const { BungalowBurn } = await import('./BungalowBurn');

const room = (id: string): Bungalow => BUNGALOWS.find((b) => b.id === id)!;
const E18 = 10n ** 18n;

function set(burn: BurnState, isReading = false) {
  hook.burn = burn;
  hook.isReading = isReading;
}

/** A read state built by the real maths, so the card is fed exactly what the hook would hand it. */
function read(id: string, reading: { supplyRaw: bigint; atBurnAddressRaw?: bigint }): BurnState {
  const fact = BUNGALOW_BURN_FACTS[id]!;
  const tally: BurnTally = tallyBurn(fact, { decimals: fact.decimals, ...reading });
  if (!tally.ok) throw new Error(`fixture mismatch: ${tally.reason}`);
  return { status: 'read', tally };
}

/** The headline percent, exactly: "contains 0%" would also pass on "100.00%". */
const headline = (card: HTMLElement) => card.querySelector('p > span')?.textContent ?? null;
/** The bar's fill. It is a picture of the percent, so it must not be drawn larger than the percent. */
const meterFill = (card: HTMLElement) => card.querySelector<HTMLElement>('[aria-hidden="true"] > div')!;

/** The value printed beside a ledger label. */
function row(label: string): string {
  const dt = screen.getByText(label, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? '';
}

beforeEach(() => set({ status: 'idle' }));

describe('BungalowBurn, a full read', () => {
  it('PEPE: prints the percent, the short figure, and both ways it was burnt', () => {
    set(read('pepe', {
      supplyRaw: 420_689_899_645_071_695787564425681079n,
      atBurnAddressRaw: 6_917_544_537_127_740524900319904797n,
    }));
    render(<BungalowBurn bungalow={room('pepe')} />);

    const card = screen.getByRole('region', { name: 'PEPE burn' });
    expect(within(card).getByRole('heading', { level: 2, name: 'PEPE burnt' })).toBeTruthy();
    expect(headline(card)).toBe('1.64%');
    expect(meterFill(card).style.width).toBe('1.6443%');
    expect(meterFill(card).style.minWidth).toBe('4px');
    expect(card.textContent).toContain('6.91T of the 420.69T PEPE ever minted');
    expect(card.textContent).toContain('Burnt counts PEPE sent to the burn address and PEPE destroyed outright');
    expect(row('Burnt')).toBe('6,917,644,892,056 PEPE');
    expect(row('Sent to the burn address')).toBe('6,917,544,537,127 PEPE');
    expect(row('Destroyed outright')).toBe('100,354,928 PEPE');
    expect(row('Ever minted')).toBe('420,690,000,000,000 PEPE');
    // Whole Ever minted minus whole Burnt: the two rows add up to the third.
    expect(row('Not burnt')).toBe('413,772,355,107,944 PEPE');
    expect(card.textContent).toContain('Read from Ethereum. The burn is rounded down to whole tokens.');
    expect(card.textContent).not.toContain('when this card loaded');
  });

  it('QR: counts the burn address only, and says why a fall in supply is left out', () => {
    set(read('qr', { supplyRaw: 100_000_000_000n * E18, atBurnAddressRaw: 6_669_949_934n * E18 }));
    render(<BungalowBurn bungalow={room('qr')} />);
    expect(row('Burnt')).toBe('6,669,949,934 QR');
    expect(screen.queryByText('Destroyed outright')).toBeNull();
    expect(screen.queryByText('Sent to the burn address')).toBeNull();
    expect(row('Not burnt')).toBe('93,330,050,066 QR');
    expect(screen.queryByText('Supply fall, not counted')).toBeNull();
    expect(screen.getByRole('region').textContent).toContain('a fall in supply is not counted as burnt');
    expect(screen.getByRole('region').textContent).toContain('Read from Base.');
    expect(headline(screen.getByRole('region'))).toBe('6.66%');
  });

  it('DRB after someone burns 5B outright: the fall is shown, not counted, and "Not burnt" is withheld', () => {
    // burn() is open to anyone on these three. The card cannot tell it from a bridge-out, so it
    // must not print more DRB as "not burnt" than exists.
    set(read('drb', { supplyRaw: 95_000_000_000n * E18, atBurnAddressRaw: 1_315_291_862n * E18 }));
    render(<BungalowBurn bungalow={room('drb')} />);
    expect(row('Burnt')).toBe('1,315,291,862 DRB');
    expect(row('Supply fall, not counted')).toBe('5,000,000,000 DRB');
    expect(screen.queryByText('Not burnt')).toBeNull();
  });

  it('BAYLA: on Solana the burn is the supply that was destroyed', () => {
    set(read('bayla', { supplyRaw: 989_301_008_790751n }));
    render(<BungalowBurn bungalow={room('bayla')} />);
    const card = screen.getByRole('region', { name: 'BAYLA burn' });
    expect(headline(card)).toBe('1.06%');
    expect(row('Burnt')).toBe('10,698,991 BAYLA');
    expect(row('Not burnt')).toBe('989,301,009 BAYLA');
    expect(screen.queryByText('Sent to the burn address')).toBeNull();
    expect(card.textContent).toContain('Read from Solana. The burn is rounded down to whole tokens.');
  });

  it('a read zero prints as zero', () => {
    set(read('bnkr', { supplyRaw: 100_000_000_000n * E18, atBurnAddressRaw: 0n }));
    render(<BungalowBurn bungalow={room('bnkr')} />);
    expect(headline(screen.getByRole('region'))).toBe('0%');
    expect(row('Burnt')).toBe('0 BNKR');
    expect(meterFill(screen.getByRole('region')).style.width).toBe('0%');
    expect(meterFill(screen.getByRole('region')).style.minWidth).toBe('0px');
  });

  it('a burn too small to draw still shows a sliver, and never a wider bar than its percent', () => {
    set(read('brainlet', { supplyRaw: 999_998_668_613490n }));
    render(<BungalowBurn bungalow={room('brainlet')} />);
    const card = screen.getByRole('region', { name: 'BRAINLET burn' });
    expect(headline(card)).toBe('0.0001%');
    expect(meterFill(card).style.width).toBe('0.0001%');
    expect(meterFill(card).style.minWidth).toBe('4px');
  });

  it.each([
    ['toweli', 'The burn address on Etherscan', 'https://etherscan.io/token/'],
    ['mfer', 'The burn address on Basescan', 'https://basescan.org/token/'],
    ['soy', 'The supply on Solscan', 'https://solscan.io/token/'],
  ])('%s: links where a reader can check it', (id, label, prefix) => {
    const fact = BUNGALOW_BURN_FACTS[id]!;
    set(read(id, id === 'soy' ? { supplyRaw: mintedRawOf(fact) } : { supplyRaw: mintedRawOf(fact), atBurnAddressRaw: 0n }));
    render(<BungalowBurn bungalow={room(id)} />);
    const link = screen.getByRole('link', { name: `${label} (opens in new tab)` });
    expect(link.getAttribute('href')).toContain(prefix + room(id).address);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('BungalowBurn, no full read', () => {
  it('an outage is said in words and no figure is printed', () => {
    set({ status: 'unread' });
    render(<BungalowBurn bungalow={room('drb')} />);
    const card = screen.getByRole('region', { name: 'DRB burn' });
    expect(within(card).getByRole('status').textContent).toBe(
      'The DRB burn could not be read right now. That is an outage, not a zero.',
    );
    expect(card.querySelector('dl')).toBeNull();
    expect(card.textContent).not.toMatch(/[0-9]/);
  });

  it('a reading that contradicts the record shows no figure either', () => {
    set({ status: 'mismatch', reason: 'supply-above-minted' });
    render(<BungalowBurn bungalow={room('jbm')} />);
    const card = screen.getByRole('region', { name: 'JBM burn' });
    expect(within(card).getByRole('status').textContent).toContain('does not match the record');
    expect(card.textContent).not.toMatch(/[0-9]/);
  });

  it('while reading it shows neither a figure nor an outage', () => {
    set({ status: 'loading' }, true);
    render(<BungalowBurn bungalow={room('rizz')} />);
    const card = screen.getByRole('region', { name: 'RIZZ burn' });
    expect(card.textContent).toContain('Reading the RIZZ burn');
    expect(within(card).queryByRole('status')).toBeNull();
    expect(card.textContent).not.toMatch(/[0-9]/);
    expect((within(card).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a lot with no token renders nothing', () => {
    set({ status: 'idle' });
    const { container } = render(<BungalowBurn bungalow={room('nb1')} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('BungalowBurn, the frame', () => {
  it('Refresh reads again and is a full-size tap target', () => {
    set({ status: 'unread' });
    render(<BungalowBurn bungalow={room('brainlet')} />);
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button.className).toContain('min-h-[44px]');
    // At the right even when the header wraps onto a second line on a phone.
    expect(button.className).toContain('ml-auto');
    fireEvent.click(button);
    expect(hook.refresh).toHaveBeenCalledTimes(1);
  });

  // The door sweep fails any other bungalow whose page says TOWELI, and the em-dash budget
  // of every settled bungalow is zero, in every state the card can be in.
  const tokenRooms = BUNGALOWS.filter((b) => b.address);
  const states: [string, (b: Bungalow) => BurnState][] = [
    ['read', (b) => read(b.id, b.chain === 'solana'
      ? { supplyRaw: mintedRawOf(BUNGALOW_BURN_FACTS[b.id]!) / 2n }
      : { supplyRaw: mintedRawOf(BUNGALOW_BURN_FACTS[b.id]!) / 2n, atBurnAddressRaw: 12_345n * E18 })],
    ['loading', () => ({ status: 'loading' })],
    ['unread', () => ({ status: 'unread' })],
    ['mismatch', () => ({ status: 'mismatch', reason: 'decimals' })],
  ];

  it('speaks only this bungalow\'s token, with no em dash, in every state', () => {
    expect(tokenRooms.length).toBe(12);
    for (const b of tokenRooms) {
      for (const [name, make] of states) {
        set(make(b));
        const { container, unmount } = render(<BungalowBurn bungalow={b} />);
        const text = container.textContent ?? '';
        expect(text, `${b.id} ${name}`).toContain(b.symbol);
        expect(text, `${b.id} ${name}`).not.toContain('—');
        if (b.id !== 'toweli') expect(text, `${b.id} ${name}`).not.toContain('TOWELI');
        unmount();
      }
    }
  });
});
