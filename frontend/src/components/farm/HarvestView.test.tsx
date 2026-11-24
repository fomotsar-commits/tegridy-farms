// Harvest as it is drawn (HarvestView.tsx), from plain values: the card's order, words and hooks in
// every state. The reads and the run are HarvestCard.test.tsx's; the figure is HarvestGranary.test.tsx's.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS } from '../../lib/bungalows';
import { doorArt } from '../../lib/doorArt';
import { muralOf, muralSrc } from '../../lib/isoMural';
import { GHOST_PAINT, storeyPaint } from '../../lib/harvest/granary';
import type { ClaimState, HarvestClaim, HarvestEarning, HarvestHeld, HarvestUnread } from '../../lib/harvest/types';

vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

import { HarvestView, type RunRow } from './HarvestView';

afterEach(() => vi.unstubAllEnvs());

const MONEY = 'Each pool pays you from its own reward vault. The venue takes nothing; you pay the network fees.';
const CAUTION = 'This stake was made before the pool changed its reward rate, so this claim may not pay. If it does not, nothing is claimed.';
const REFUSED = 'Nothing was claimed, so it stays owed. Only the network fee was spent.';
/** An en dash or an em dash, built from their code points so this file holds neither. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
/** A no-break space, from its code point. */
const NBSP = String.fromCharCode(0xa0);

const bayla = (key: string, amountRaw: bigint, caution: string | null = null): HarvestClaim => ({
  key, chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'lock ladder', detail: null, amountRaw, decimals: 6, caution,
});
const PEPE: HarvestClaim = {
  key: 'evm:pepe', chain: 'ethereum', roomId: 'pepe', symbol: 'PEPE', where: 'lighthouse pool', detail: null, amountRaw: 10n ** 18n, decimals: 18, caution: null,
};
// Two BAYLA claims, 75 and 25 of one coin, so the bar's line divides 3 to 1; one PEPE claim, which no bar adds.
const CLAIMS = [bayla('ladder:1', 75_000_000n), bayla('ladder:2', 25_000_000n, CAUTION), PEPE];
const HELD: HarvestHeld[] = [{
  key: 'sf:bobo', chain: 'solana', roomId: 'bobo', symbol: 'BOBO', where: 'lighthouse pool', amountRaw: 52_100_000n, decimals: 6,
  reason: 'The reward vault cannot cover this yet, so a claim would fail. Nothing is lost: it stays owed.',
}];
const EARNING: HarvestEarning = {
  key: 'ladder:P', chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'lock ladder', decimals: 6,
  principalRaw: 996_380_000_000n, perDayRaw: 96_400_000n, apr: '3.5%', fundedToSecs: Date.UTC(2026, 11, 23) / 1000,
};
const UNREAD: HarvestUnread[] = [{ key: 'evm:mfer', chain: 'base', roomId: 'mfer', what: 'your MFER pool', detail: 'the Base network did not answer' }];

type Props = Parameters<typeof HarvestView>[0];
const rows = (states: ClaimState[]): RunRow[] => CLAIMS.map((claim, i) => ({ claim, state: states[i]! }));
const MID_RUN = rows([{ kind: 'claimed', tx: 'SIG1' }, { kind: 'sending' }, { kind: 'waiting' }]);
const DONE = rows([{ kind: 'claimed', tx: 'SIG1' }, { kind: 'reverted', reason: REFUSED, tx: 'SIG2' }, { kind: 'claimed', tx: '0xfeed' }]);

/** Every state the card is drawn in, by name. */
const STATES: Record<'reading' | 'ready' | 'running' | 'done' | 'nothing', Partial<Props>> = {
  reading: { claims: [], held: [], unread: [], reading: true, label: 'Reading your pools…', disabled: true },
  ready: {},
  running: { run: { rows: MID_RUN, done: false }, label: 'Claiming 2 of 3…', disabled: true },
  done: { run: { rows: DONE, done: true }, label: 'Check again' },
  nothing: { claims: [], held: [], unread: [], label: 'Nothing to claim', disabled: true },
};

const draw = (over: Partial<Props> = {}) => render(
  <MemoryRouter>
    <HarvestView className="" headingLevel={2} claims={CLAIMS} held={HELD} unread={UNREAD} run={null} reading={false}
      label="Harvest all · 3 claims" disabled={false} asks={2} onPress={() => {}} onReread={() => {}} {...over} />
  </MemoryRouter>,
);

const FINE = [
  'Harvest reads every island pool for the wallets you have connected: each lighthouse pool and the lock ladder on Solana, and each lighthouse pool on Ethereum and Base. It claims every reward it read above zero, one transaction per pool position: Solana first, then Ethereum and Base, switching network once between them. A wallet that can sign several at once is asked once per network; any other, once per claim. Claiming moves no stake and changes no lock.',
  'A pool it could not read is listed as not read, never as nothing to claim. It leaves alone a reward the pool cannot pay yet (its vault is short or empty; nothing is lost, it stays owed), a reward paid in another coin, and the classic farm, whose claim can also extend a lock. Claim those on their own page.',
  'On Solana each claim is test-run first, and one its pool would refuse is not put to your wallet. A claim paid stays paid if another one does not go through, unless your wallet bundles the Ethereum or Base claims into one transaction: then they are paid or refused together. If you cancel in your wallet, Harvest stops and sends nothing more. A claim whose outcome could not be read also stops it, so you can check before anything is sent twice.',
  'The drawing is this harvest as a street: one building for each room with something to claim, its ticker on its footing, in the order the claims are sent, and each network’s name on the ground where its buildings begin. Each claim is one storey in its room’s colours, with its row’s number. A caution mark on its front is its row’s caution: it may pay less than shown, or nothing. A room’s storeys stand in stacks of up to four, side by side on its footing, in the order the claims are sent. Every storey is the same size whatever it pays, so more storeys means more claims, never more money. From its building each claim has one lane to the glass building marked YOUR WALLET; every lane is the same width, and no lane goes anywhere else. Before you press, the storeys hang above their footing in the order they will be sent, and the lanes are empty. The one at your wallet lifts clear, ringed in amber, and its lane turns amber. A storey comes down onto its stack, its windows light, its lane turns green and one plate is set down in your wallet, only once its claim is paid; every plate is the same size. One drawn in dashes was refused, not confirmed, cancelled or not sent, as its row says: it is never part of the building, and nothing of it enters your wallet. Once every claim on a network was paid, refused or cancelled, a roof goes on each of its stacks that holds a paid storey, and a flag goes up; over a stack where none was paid the roof stays hung, in dashes. Until then every roof stays hung. A pool that could not be read, or a reward left alone, is not drawn; its row stays in the list.',
  'The totals bar adds one coin’s claims together; two coins are never added, because no price is read here. The line above its total is divided between that coin’s claims to scale, the one place an amount is drawn to size, which is fair because they are the same coin; it fills green as each claim goes through, in stripes where its row has a caution. After a run the total counts only the claims that went through. For a lock ladder on Solana the bar also says what your locks earn a day and that as a yearly rate on what you locked: your weight (each lock times its boost) over all stakers’ weight, times what the pool pays a day. Those two are the same figures as on the pool’s own page. They hold only at today’s rate: they fall when others lock, rise when they leave, and stop on the date shown unless the pool is refilled. Where they cannot be worked out they are left out, never shown as a zero.',
];

describe('Harvest view', () => {
  it('keeps the pools it left alone and the ones it could not read listed under the run, mid-run and done', () => {
    for (const state of ['running', 'done'] as const) {
      const onReread = vi.fn();
      const { unmount } = draw({ ...STATES[state], onReread });
      expect(within(screen.getByRole('list', { name: 'This harvest' })).getAllByRole('listitem')).toHaveLength(3);
      expect(within(screen.getByRole('list', { name: 'Left alone' })).getByText('52.1 BOBO')).toBeTruthy();
      const notRead = screen.getByRole('list', { name: 'Not read' });
      expect(notRead.textContent).toContain('Could not read your MFER pool (the Base network did not answer). Not a zero.');
      // Try again only reads again (the run keeps its own claims), so it stays live while a run is on screen.
      fireEvent.click(within(notRead).getByRole('button', { name: 'Try again' }));
      expect(onReread).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('the money line is the card’s one line of prose, straight under the heading, in every state', () => {
    for (const [name, over] of Object.entries(STATES)) {
      const { unmount } = draw(over);
      const heading = screen.getByRole('heading', { level: 2, name: 'Harvest' });
      expect(heading.nextElementSibling?.textContent, name).toBe(MONEY);
      expect(document.body.textContent, name).not.toContain('Claim every pool’s rewards at once.');
      unmount();
    }
  });

  it('the drawing turns in its own element; while it waits to be seen only the drawing is held back, never a row, the button or a word', () => {
    // An observer that never reports: the drawing stays armed.
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    try {
      const { container } = draw();
      const svg = container.querySelector('svg[data-testid="harvest-stack"]')!;
      const turn = svg.parentElement!;
      expect(turn.className).toBe('hv-turn');
      expect(Array.from(turn.children)).toEqual([svg]);
      expect(turn.parentElement!.querySelector(':scope > [data-view-title]')).not.toBeNull();
      expect(Array.from(container.querySelectorAll('[data-intro]'))).toEqual([svg]);
      expect(svg.getAttribute('data-intro')).toBe('armed');
      // What the tests and the e2e specs read stands outside the drawing and its title: the rows, the buttons, the totals, the money line.
      const read = Array.from(container.querySelectorAll('li, button, a, [data-testid], .hv-money, .hv-cta-note, h2')).filter((el) => el !== svg);
      expect(read.length).toBeGreaterThan(8);
      for (const el of read) expect(el.closest('.hv-turn, .hv-vt'), el.outerHTML.slice(0, 60)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the button comes before the list it claims, before a press and during a run', () => {
    for (const [over, name, list] of [[STATES.ready, 'Harvest all · 3 claims', 'Ready to claim'], [STATES.running, 'Claiming 2 of 3…', 'This harvest']] as const) {
      const { unmount } = draw(over);
      const button = screen.getByRole('button', { name });
      expect(button.compareDocumentPosition(screen.getByRole('list', { name: list })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }
  });

  it('the BAYLA bar divides its line between BAYLA’s claims to scale, numbered by marks, its words unchanged', () => {
    const { unmount } = draw();
    const bar = screen.getByRole('group', { name: 'BAYLA total' });
    // The segment numbers are drawn by CSS from data-n, so the bar's words are what they were (ladder:2's caution says "at most").
    expect(bar.textContent).toBe('BAYLA · 2 claims100BAYLA total, at most');
    const segs = Array.from(bar.querySelectorAll<HTMLElement>('[data-seg]'));
    expect(segs.map((s) => [s.getAttribute('data-seg'), s.style.flexGrow, s.getAttribute('data-s')])).toEqual([['ladder:1', '0.75', 'ready'], ['ladder:2', '0.25', 'ready']]);
    expect(Array.from(bar.querySelectorAll('em[data-n]')).map((e) => [e.getAttribute('data-n'), e.textContent])).toEqual([['01', ''], ['02', '']]);
    // One claim of PEPE: no bar, and so no line; two coins never share one.
    expect(screen.queryByRole('group', { name: 'PEPE total' })).toBeNull();
    unmount();
    const done = draw(STATES.done);
    const after = screen.getByRole('group', { name: 'BAYLA total' });
    expect(Array.from(after.querySelectorAll('[data-seg]')).map((s) => s.getAttribute('data-s'))).toEqual(['claimed', 'reverted']);
    done.unmount();
    // A part narrower than 4.5% of the line carries no number: 2.5 of 100 BAYLA.
    draw({ claims: [bayla('a', 97_500_000n), bayla('b', 2_500_000n)], held: [], unread: [] });
    expect(Array.from(screen.getByRole('group', { name: 'BAYLA total' }).querySelectorAll('em[data-n]')).map((e) => e.getAttribute('data-n'))).toEqual(['01']);
  });

  it('each row carries its state and its caution, and wears its room’s door card; its number is a mark, not a word', () => {
    draw(STATES.running);
    const items = within(screen.getByRole('list', { name: 'This harvest' })).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['claimed', 'sending', 'waiting']);
    expect(items.map((li) => li.hasAttribute('data-caution'))).toEqual([false, true, false]);
    const plaque = items[1]!.querySelector('[data-n]')!;
    expect([plaque.getAttribute('data-n'), plaque.getAttribute('aria-hidden'), plaque.textContent]).toEqual(['02', 'true', '']);
    const door = items[1]!.querySelector('img')!;
    expect(door.getAttribute('alt')).toBe('');
    expect(door.getAttribute('src')).toBe(muralOf('bayla', 128)!.src);
    // A pool left alone wears its room's door card too, greyed, with an empty plaque.
    const held = within(screen.getByRole('list', { name: 'Left alone' })).getByRole('listitem');
    expect(held.hasAttribute('data-held')).toBe(true);
    expect(held.querySelector('img')!.getAttribute('src')).toBe(muralOf('bobo', 128)!.src);
  });

  it('a row pointed at lights its segment of the coin’s line, and lets go of it', () => {
    draw();
    const items = within(screen.getByRole('list', { name: 'Ready to claim' })).getAllByRole('listitem');
    const seg = () => screen.getByRole('group', { name: 'BAYLA total' }).querySelector('[data-seg="ladder:2"]')!;
    fireEvent.mouseEnter(items[1]!);
    expect(items[1]!.hasAttribute('data-hot')).toBe(true);
    expect(seg().hasAttribute('data-hot')).toBe(true);
    fireEvent.mouseLeave(items[1]!);
    expect(items[1]!.hasAttribute('data-hot')).toBe(false);
    expect(seg().hasAttribute('data-hot')).toBe(false);
  });

  it('while it runs, a course of bricks along the button, one per claim, says where each stands', () => {
    const { unmount } = draw(STATES.running);
    const button = screen.getByRole('button', { name: 'Claiming 2 of 3…' });
    expect(Array.from(button.querySelectorAll('[data-s]')).map((b) => b.getAttribute('data-s'))).toEqual(['claimed', 'sending', 'waiting']);
    unmount();
    draw(STATES.done);
    expect(screen.getByRole('button', { name: 'Check again' }).querySelectorAll('[data-s]')).toHaveLength(0);
  });

  it('the drawing’s key stands under it whenever a storey is drawn, and never over a bare footing', () => {
    for (const [name, over] of Object.entries(STATES)) {
      const { container, unmount } = draw(over);
      const title = container.querySelector('[data-view-title]');
      expect(Boolean(title), name).toBe(name !== 'reading' && name !== 'nothing');
      if (title) expect([title.getAttribute('aria-hidden'), title.textContent]).toEqual(['true', '1 storey = 1 claim']);
      unmount();
    }
  });

  it('sets itself out by what it holds: short, bare, quiet, and the sheet frame a mark only', () => {
    const one = draw({ claims: [PEPE], held: [], unread: [], label: 'Harvest all · 1 claim' });
    const grid = () => screen.getByRole('heading', { name: 'Harvest' }).closest('[data-short], [data-bare], [data-quiet]');
    expect(grid()?.hasAttribute('data-short')).toBe(true);
    expect([one.container.querySelector('[data-frame]')?.getAttribute('aria-hidden'), one.container.querySelector('[data-frame]')?.textContent]).toEqual(['true', '']);
    one.unmount();
    const reading = draw(STATES.reading);
    expect(grid()?.hasAttribute('data-bare')).toBe(true);
    reading.unmount();
    draw({ headingLevel: 3 });
    expect(screen.getByRole('heading', { level: 3, name: 'Harvest' }).closest('[data-quiet]')).toBeTruthy();
    expect(grid()?.hasAttribute('data-short')).toBe(false);
  });

  it('draws the figure afresh once a finished harvest is put away (Check again), and never mid-run', () => {
    const at = (run: Props['run']) => (
      <MemoryRouter>
        <HarvestView className="" headingLevel={2} claims={CLAIMS} held={HELD} unread={UNREAD} run={run} reading={false}
          label="Harvest all · 3 claims" disabled={false} asks={2} onPress={() => {}} onReread={() => {}} />
      </MemoryRouter>
    );
    const { rerender } = render(at(null));
    const first = screen.getByTestId('harvest-stack');
    rerender(at({ rows: MID_RUN, done: false }));
    rerender(at({ rows: DONE, done: true }));
    expect(screen.getByTestId('harvest-stack')).toBe(first);
    rerender(at(null));
    expect(screen.getByTestId('harvest-stack')).not.toBe(first);
  });

  it('a drawing with no storey keeps to the bare footing’s size, and draws no footing where a pool was not read', () => {
    // The footing drawn with nothing on it says "nothing to claim": dashed, three faces.
    const footing = (c: HTMLElement) => c.querySelectorAll('[data-testid="harvest-stack"] polygon[stroke-dasharray="3 3"]').length;
    // A pool not read and nothing claimable: rows to list, nothing to build, and no drawing at all, so never the nothing-to-claim picture.
    const { container, unmount } = draw({ claims: [], held: [], label: 'Nothing to claim', disabled: true });
    expect(container.querySelector('.hv-fig')).toBeNull();
    expect(footing(container)).toBe(0);
    unmount();
    const nothing = draw(STATES.nothing);
    expect(footing(nothing.container)).toBe(3);
    nothing.unmount();
    const ready = draw();
    expect(ready.container.querySelector('[data-testid="harvest-stack"]')!.closest('.hv-fig')!.hasAttribute('data-empty')).toBe(false);
  });

  it('How it works says what the drawing and the line mean, word for word', () => {
    draw();
    const details = screen.getByText('How it works').closest('details')!;
    expect(Array.from(details.querySelectorAll('p')).map((p) => p.textContent)).toEqual(FINE);
  });

  it('YOUR WALLET is a mark on the drawing, hidden from assistive tech: no word of the card outside the drawing and How it works', () => {
    const { container } = draw();
    const svg = container.querySelector('svg[data-testid="harvest-stack"]')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(svg.querySelectorAll('[data-wallet-name]')).map((n) => n.textContent)).toEqual(['YOUR WALLET']);
    for (const part of Array.from(container.querySelectorAll('.hv > *')).filter((el) => !el.matches('.hv-fine, .hv-fig'))) {
      expect(part.textContent).not.toContain('YOUR WALLET');
    }
    expect(container.querySelector('.hv-fig')!.textContent!.replace(svg.textContent!, '')).not.toContain('YOUR WALLET');
  });

  it('How it works counts storeys, never a tower’s height: a fifth claim opens a second stack, lower than one of four', () => {
    draw();
    const text = screen.getByText('How it works').closest('details')!.textContent!;
    expect(text).toContain('so more storeys means more claims, never more money');
    expect(text).toContain('stacks of up to four');
    expect(text).not.toContain('a taller tower');
  });

  it('carries no em dash and no en dash, in any state', () => {
    for (const [name, over] of Object.entries(STATES)) {
      const { container, unmount } = draw(over);
      const labels = Array.from(container.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')).join(' ');
      expect(`${container.textContent} ${labels}`, name).not.toMatch(DASHES);
      unmount();
    }
  });

  it('an amount is cut, never rounded up: in its row and in its coin’s total', () => {
    draw({ claims: [bayla('a', 1_284_500_000n), bayla('b', 686_060_000n), bayla('c', 4_259n)], held: [], unread: [] });
    const items = within(screen.getByRole('list', { name: 'Ready to claim' })).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.hv-amt')!.textContent)).toEqual(['1,284.5 BAYLA', '686.06 BAYLA', '0.00425 BAYLA']);
    // 1,970.564259 BAYLA in all.
    expect(screen.getByRole('group', { name: 'BAYLA total' }).textContent).toBe('BAYLA · 3 claims1,970.56BAYLA total');
  });

  it('after a run the bar adds up what was claimed, and says how many of its claims were', () => {
    const done = draw(STATES.done);
    // 75 claimed, 25 refused.
    expect(screen.getByRole('group', { name: 'BAYLA total' }).textContent).toBe('BAYLA · 1 of 2 claimed75BAYLA claimed');
    done.unmount();
    draw({ run: { rows: rows([{ kind: 'claimed', tx: 'SIG1' }, { kind: 'claimed', tx: 'SIG2' }, { kind: 'claimed', tx: '0xfeed' }]), done: true }, label: 'Check again' });
    expect(screen.getByRole('group', { name: 'BAYLA total' }).textContent).toBe('BAYLA · 2 claims100BAYLA claimed, at most');
  });

  it('a total that counts a claim that may pay less says at most, before the press and after a run; one that counts none says what it did', () => {
    // The unit under a coin's big figure; the group keeps its name whatever the unit says.
    const unit = () => screen.getByRole('group', { name: 'BAYLA total' }).querySelector('.hv-lg + .hv-u')!.textContent;
    // Before the press: BAYLA's total counts ladder:2, which carries a caution.
    const ready = draw();
    expect(unit()).toBe('BAYLA total, at most');
    ready.unmount();
    // After a run in which that claim came to Claimed.
    const paid = draw({ run: { rows: rows([{ kind: 'claimed', tx: 'SIG1' }, { kind: 'claimed', tx: 'SIG2' }, { kind: 'claimed', tx: '0xfeed' }]), done: true }, label: 'Check again' });
    expect(unit()).toBe('BAYLA claimed, at most');
    paid.unmount();
    // Refused, it is not counted: the claimed total is what was paid.
    const refused = draw(STATES.done);
    expect(unit()).toBe('BAYLA claimed');
    refused.unmount();
    // No claim with a caution: the words as they were, before and after.
    const plain = [bayla('a', 75_000_000n), bayla('b', 25_000_000n)];
    const before = draw({ claims: plain, held: [], unread: [] });
    expect(unit()).toBe('BAYLA total');
    before.unmount();
    draw({ claims: plain, held: [], unread: [], run: { rows: plain.map((claim) => ({ claim, state: { kind: 'claimed', tx: 'S' } })), done: true }, label: 'Check again' });
    expect(unit()).toBe('BAYLA claimed');
  });

  it('pools not read for one reason are one line naming each, with one Try again; another reason keeps its own line; a reason that says it is no zero is not told twice', () => {
    const stakes = 'Your stakes could not be read right now.';
    const outage = 'The pool could not be read right now. That is an outage, not a zero.';
    const u = (roomId: string, what: string, detail: string): HarvestUnread => ({ key: `sf:${roomId}`, chain: 'solana', roomId, what, detail });
    const onReread = vi.fn();
    const many = draw({
      unread: [u('bayla', 'your BAYLA stakes', stakes), { ...UNREAD[0]! }, u('bobo', 'your BOBO stakes', stakes), u('rizz', 'your RIZZ stakes', outage), u('soy', 'your SOY stakes', stakes)],
      onReread,
    });
    const list = screen.getByRole('list', { name: 'Not read' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Could not read your BAYLA stakes, your BOBO stakes and your SOY stakes (Your stakes could not be read right now). Not a zero. Try again',
      'Could not read your MFER pool (the Base network did not answer). Not a zero. Try again',
      'Could not read your RIZZ stakes (The pool could not be read right now. That is an outage, not a zero). Try again',
    ]);
    const again = within(list).getAllByRole('button', { name: 'Try again' });
    expect(again).toHaveLength(3);
    for (const button of again) fireEvent.click(button);
    expect(onReread).toHaveBeenCalledTimes(3);
    many.unmount();
    // Two for one reason: named with "and".
    draw({ unread: [u('bobo', 'your BOBO stakes', stakes), u('soy', 'your SOY stakes', stakes)] });
    expect(within(screen.getByRole('list', { name: 'Not read' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Could not read your BOBO stakes and your SOY stakes (Your stakes could not be read right now). Not a zero. Try again',
    ]);
  });

  it('nothing to claim and a pool not read: no drawing at all, no plate, board or view title; the heading, the money line, the button, the note and the not-read line are the card', () => {
    const undrawn = draw({ claims: [], held: [], label: 'Check again' });
    expect(undrawn.container.querySelector('.hv-fig, .hv-turn, [data-testid="harvest-stack"], [data-site], [data-board], [data-view-title]')).toBeNull();
    const card = undrawn.container.querySelector('.hv')!;
    expect(card.hasAttribute('data-undrawn')).toBe(true);
    expect(Array.from(card.children).map((el) => el.className.split(' ')[0])).toEqual(['hv-head', 'hv-act', 'hv-list', 'hv-fine']);
    expect(screen.getByRole('heading', { name: 'Harvest' }).nextElementSibling?.textContent).toBe(MONEY);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.getByText('Not every pool was read.')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Not read' })).getAllByRole('listitem')).toHaveLength(1);
    undrawn.unmount();
    // Reading (a pool not read is being read again), and nothing to claim, keep their drawings.
    for (const over of [{ ...STATES.reading, unread: UNREAD }, STATES.nothing]) {
      const { container, unmount } = draw(over);
      expect(container.querySelectorAll('[data-testid="harvest-stack"]')).toHaveLength(1);
      expect(container.querySelector('.hv')!.hasAttribute('data-undrawn')).toBe(false);
      unmount();
    }
  });

  it('the claim at the wallet tells you to check your wallet, never that it has arrived there', () => {
    draw(STATES.running);
    const items = within(screen.getByRole('list', { name: 'This harvest' })).getAllByRole('listitem');
    expect(items[1]!.querySelector('.hv-st')!.textContent).toBe(`Check your wallet${String.fromCharCode(0x2026)}`);
    expect(document.body.textContent).not.toContain('At your wallet');
  });

  it('a daily figure and its APR name their pool and the stake they are on', () => {
    draw({ earning: [EARNING] });
    const bar = screen.getByRole('group', { name: 'BAYLA total' });
    expect(within(bar).getByText('BAYLA a day')).toBeTruthy();
    expect(bar.querySelector('.hv-basis')!.textContent).toMatch(new RegExp(`^lock ladder · on${NBSP}996,380 BAYLA · at today’s rate, funded to .*2026$`));
  });

  it('beside the button it says when not every pool was read, before, during and after a run', () => {
    for (const [name, over] of [['ready', {}], ['running', STATES.running], ['done', STATES.done]] as const) {
      const { container, unmount } = draw(over);
      expect(container.querySelector('.hv-actrow')!.textContent, name).toContain('Not every pool was read.');
      unmount();
    }
    const { container } = draw({ unread: [] });
    expect(container.querySelector('.hv-actrow')!.textContent).not.toContain('not read');
    // The wallet's line keeps its own words.
    expect(screen.getByText('Your wallet asks 2 times.')).toBeTruthy();
  });

  it('the arrow key marks a press that harvests, and no other', () => {
    const key = (name: string, over: Partial<Props>) => {
      const { unmount } = draw(over);
      const has = screen.getByRole('button', { name }).querySelector('svg') !== null;
      unmount();
      return has;
    };
    expect(key('Harvest all · 3 claims', {})).toBe(true);
    expect(key('Claiming 2 of 3…', STATES.running)).toBe(false);
    expect(key('Check again', STATES.done)).toBe(false);
    expect(key('Reading your pools…', STATES.reading)).toBe(false);
    expect(key('Nothing to claim', STATES.nothing)).toBe(false);
  });

  it('while a run is going a pool left alone names its page without linking away from the run', () => {
    const page = () => screen.queryByRole('link', { name: "The BOBO pool's page" });
    const running = draw(STATES.running);
    expect(page()).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Left alone' })).getByText('Its page')).toBeTruthy();
    running.unmount();
    for (const over of [{}, STATES.done]) {
      const { unmount } = draw(over);
      expect(page()?.getAttribute('href')).toBe('/earn/bobo');
      unmount();
    }
  });

  it('a claim that may pay less marks its part of the coin’s line, so a paid part never reads as paid in full', () => {
    draw(STATES.done);
    const segs = Array.from(screen.getByRole('group', { name: 'BAYLA total' }).querySelectorAll('[data-seg]'));
    expect(segs.map((s) => s.hasAttribute('data-caution'))).toEqual([false, true]);
  });

  it('a claim’s detail keeps "on" with its figure, so a narrow row never breaks between them', () => {
    draw({ claims: [{ ...bayla('a', 1n), detail: 'on 942,285 BAYLA locked' }], held: [], unread: [] });
    expect(screen.getByRole('listitem').querySelector('.hv-where')!.textContent).toBe(`lock ladder${NBSP}· Solana${NBSP}· on${NBSP}942,285 BAYLA locked`);
  });

  it('no line of a row’s where-line starts with a dot: each middle dot keeps to the word before it, the words as they were', () => {
    draw({ claims: [{ ...bayla('a', 1n), detail: 'on 942,285 BAYLA locked' }], unread: [] });
    const lines = Array.from(document.querySelectorAll('.hv-where')).map((w) => w.textContent!);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.split('·').length).toBeGreaterThan(1);
      expect(line).not.toMatch(/ ·/);
      expect(line.split(`${NBSP}·`).length).toBe(line.split('·').length);
    }
    expect(lines.map((l) => l.split(NBSP).join(' '))).toEqual(['lock ladder · Solana · on 942,285 BAYLA locked', 'lighthouse pool · Solana']);
  });

  it('nothing to claim and a pool not read: the button checks again, with no arrow, and no line says there is nothing', () => {
    const onPress = vi.fn();
    draw({ claims: [], held: [], label: 'Check again', disabled: false, onPress });
    const again = screen.getByRole('button', { name: 'Check again' });
    expect(again.querySelector('svg')).toBeNull();
    expect(screen.queryByText('Nothing to claim right now.')).toBeNull();
    expect(screen.getByText('Not every pool was read.')).toBeTruthy();
    fireEvent.click(again);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a row reached by keyboard lights its part of the coin’s line, and lets go when focus leaves', () => {
    draw(STATES.done);
    const first = within(screen.getByRole('list', { name: 'This harvest' })).getAllByRole('listitem')[0]!;
    const seg = () => screen.getByRole('group', { name: 'BAYLA total' }).querySelector('[data-seg="ladder:1"]')!;
    const link = within(first).getByRole('link');
    fireEvent.focus(link);
    expect(first.hasAttribute('data-hot')).toBe(true);
    expect(seg().hasAttribute('data-hot')).toBe(true);
    fireEvent.blur(link);
    expect(first.hasAttribute('data-hot')).toBe(false);
    expect(seg().hasAttribute('data-hot')).toBe(false);
  });

  it('each row’s state wears its storey’s colour: amber at the wallet, green paid, coral refused, orange not confirmed', () => {
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    const colours = () => within(screen.getByRole('list', { name: 'This harvest' })).getAllByRole('listitem')
      .map((li) => (li.querySelector('.hv-st') as HTMLElement | null)?.style.color ?? null);
    const running = draw(STATES.running);
    expect(colours().slice(0, 2)).toEqual([rgb(storeyPaint('claimed', false).plate), rgb(storeyPaint('sending', false).edge)]);
    running.unmount();
    draw({ run: { rows: rows([{ kind: 'unconfirmed', reason: 'No answer came back for it.' }, { kind: 'reverted', reason: REFUSED, tx: 'SIG2' }, { kind: 'claimed', tx: '0xfeed' }]), done: true }, label: 'Check again' });
    expect(colours().slice(0, 2)).toEqual([rgb(GHOST_PAINT.unconfirmed.colour), rgb(GHOST_PAINT.reverted.colour)]);
  });

  it('a door card takes the small copy of its room’s picture where the build made one', () => {
    vi.stubEnv('PROD', true);
    const src = doorArt(BUNGALOWS.find((b) => b.id === 'bayla')!).src!;
    expect(muralSrc(src, 128, true)).not.toBe(muralSrc(src, 480, true));
    draw();
    const door = within(screen.getByRole('list', { name: 'Ready to claim' })).getAllByRole('listitem')[0]!.querySelector('img')!;
    expect(door.getAttribute('src')).toBe(muralSrc(src, 128, true));
  });
});

/** index.css without its comments, as its innermost rules: each selector of a list, and the declarations. */
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
const RULES = Array.from(CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({ sel: m[1]!.split(',').map((s) => s.trim()), body: m[2]! }));
const bodiesOf = (sel: string) => RULES.filter((r) => r.sel.includes(sel)).map((r) => r.body).join('\n');

describe('Harvest view: its targets in index.css', () => {
  it('a row’s transaction link reaches 5 px above and below its one line of words, a 24 px target within its own width, as Its page does', () => {
    expect(bodiesOf('.hv-st a')).toMatch(/position: relative;/);
    expect(bodiesOf('.hv-st a::after')).toMatch(/content: '';\s*position: absolute;\s*inset: -5px 0;/);
    expect(bodiesOf('a.hv-page::after')).toMatch(/content: '';\s*position: absolute;\s*inset: -5px 0;/);
  });

  it('a card with no drawing keeps no row for one, at every width: the heading, the totals if any, the button, the list', () => {
    expect(bodiesOf('.hv[data-undrawn]')).toMatch(/grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-areas: 'head' 'act' 'list' 'fine';/);
    expect(bodiesOf('.hv[data-undrawn]:has(> .hv-tally)')).toMatch(/grid-template-areas: 'head' 'tally' 'act' 'list' 'fine';/);
    // After the wide band's own templates, so it holds there too.
    expect(CSS.lastIndexOf('.hv[data-undrawn]')).toBeGreaterThan(CSS.indexOf('@container harvest (width >= 55rem)'));
  });
});
