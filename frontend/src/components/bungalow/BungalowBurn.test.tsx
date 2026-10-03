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
    expect(card.textContent).toContain('1.64%');
    expect(card.textContent).toContain('6.91T of the 420.69T PEPE ever minted');
    expect(row('Burnt')).toBe('6,917,644,892,056 PEPE');
    expect(row('Sent to the burn address')).toBe('6,917,544,537,127 PEPE');
    expect(row('Destroyed outright')).toBe('100,354,928 PEPE');
    expect(row('Ever minted')).toBe('420,690,000,000,000 PEPE');
    expect(row('Not burnt')).toBe('413,772,355,107,943 PEPE');
    expect(card.textContent).toContain('Read from Ethereum when this card loaded');
  });

  it('QR: counts the burn address only, and says why a fall in supply is left out', () => {
    set(read('qr', { supplyRaw: 100_000_000_000n * E18, atBurnAddressRaw: 6_669_949_934n * E18 }));
    render(<BungalowBurn bungalow={room('qr')} />);
    expect(row('Burnt')).toBe('6,669,949,934 QR');
    expect(screen.queryByText('Destroyed outright')).toBeNull();
    expect(screen.queryByText('Sent to the burn address')).toBeNull();
    expect(screen.getByRole('region').textContent).toContain('a fall in supply is not counted');
  });

  it('BAYLA: on Solana the burn is the supply that was destroyed', () => {
    set(read('bayla', { supplyRaw: 989_301_008_790751n }));
    render(<BungalowBurn bungalow={room('bayla')} />);
    const card = screen.getByRole('region', { name: 'BAYLA burn' });
    expect(card.textContent).toContain('1.06%');
    expect(row('Burnt')).toBe('10,698,991 BAYLA');
    expect(row('Not burnt')).toBe('989,301,008 BAYLA');
    expect(screen.queryByText('Sent to the burn address')).toBeNull();
    expect(card.textContent).toContain('Read from Solana when this card loaded');
  });

  it('a read zero prints as zero', () => {
    set(read('bnkr', { supplyRaw: 100_000_000_000n * E18, atBurnAddressRaw: 0n }));
    render(<BungalowBurn bungalow={room('bnkr')} />);
    expect(screen.getByRole('region').textContent).toContain('0%');
    expect(row('Burnt')).toBe('0 BNKR');
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
