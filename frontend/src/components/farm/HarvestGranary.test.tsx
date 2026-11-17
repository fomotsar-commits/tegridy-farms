// Harvest's figure draws the run, not the money: one storey per claim, every storey the same size
// whatever it pays, each saying only where its claim stands. A storey comes down onto its tower only
// once paid; one that did not land hangs dashed; nothing is drawn that was not read.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { BUNGALOWS } from '../../lib/bungalows';
import { doorArt } from '../../lib/doorArt';
import { muralSrc, resetPicturesForTests } from '../../lib/isoMural';
import { iso } from '../../lib/iso';
import {
  AMBER, BG, D, GHOST_PAINT, M, U, W_POD, W_POD_OVER, cityPlan, granaryLayout, isGhost, networksOf, type GranaryStorey,
} from '../../lib/harvest/granary';
import type { ClaimState } from '../../lib/harvest/types';
import { HarvestGranary } from './HarvestGranary';

type Kind = ClaimState['kind'] | null;

const ROOM = {
  bayla: { chain: 'solana', symbol: 'BAYLA', accent: '#8ef0d8' },
  bobo: { chain: 'solana', symbol: 'BOBO', accent: '#dcae60' },
  pepe: { chain: 'ethereum', symbol: 'PEPE', accent: '#5f9e6e' },
  drb: { chain: 'base', symbol: 'DRB', accent: '#d4b168' },
  jbm: { chain: 'base', symbol: 'JBM', accent: '#ffd078' },
} as const;
type Room = keyof typeof ROOM;

/** Storeys in run order, as the card builds them: n is the row number. */
function storeys(rooms: Room[], states: Kind[] = [], caution: number[] = []): GranaryStorey[] {
  return rooms.map((roomId, i) => ({
    key: `k${i + 1}`, n: i + 1, roomId, ...ROOM[roomId], caution: caution.includes(i + 1), state: states[i] ?? null,
  }));
}
const S2: Room[] = ['bayla', 'bayla', 'bayla', 'bayla', 'pepe', 'drb', 'jbm'];

const plate = (root: HTMLElement, key: string) => root.querySelector<SVGGElement>(`[data-plate="${key}"]`)!;
/** A storey's floor height, from the transform that places its group. */
const zOf = (root: HTMLElement, key: string) => -Number(/translateY\((-?[\d.]+)px\)/.exec(plate(root, key).style.transform)?.[1] ?? NaN) / U;
const states = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-plate]')).map((g) => `${g.getAttribute('data-plate')}:${g.getAttribute('data-state')}`);
/** A polygon's points, moved so its first point is the origin (to a tenth of a pixel: the markup rounds each point). */
const shapeOf = (el: Element | null) => {
  const p = (el?.getAttribute('points') ?? '').trim().split(/\s+/).map((q) => q.split(',').map(Number));
  return p.map(([x, y]) => `${(x! - p[0]![0]!).toFixed(1)},${(y! - p[0]![1]!).toFixed(1)}`).join(' ');
};

/** An Image that loads a microtask after its src is set (2:1 wide), or fails where `fail` says so; `made` counts them. */
const made = { n: 0 };
function stubImages(fail = false) {
  made.n = 0;
  vi.stubGlobal('Image', class {
    constructor() {
      made.n += 1;
    }
    naturalWidth = 0;
    naturalHeight = 0;
    decoding = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => {
        if (fail) return this.onerror?.();
        Object.assign(this, { naturalWidth: 1600, naturalHeight: 800 });
        this.onload?.();
      });
    }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
}
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

beforeEach(() => resetPicturesForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Harvest's figure: the granary", () => {
  it('draws one storey per claim, ready before a run, as a picture hidden from assistive tech', () => {
    const { container, getByTestId } = render(<HarvestGranary storeys={storeys(S2)} />);
    expect(states(container)).toEqual(['k1:ready', 'k2:ready', 'k3:ready', 'k4:ready', 'k5:ready', 'k6:ready', 'k7:ready']);
    expect(getByTestId('harvest-stack').getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('a, button, [tabindex]')).toBeNull();
    expect(getByTestId('harvest-stack').getAttribute('viewBox')).toBe('-198 -286 514 518');
    expect(container.querySelectorAll('[data-site]')).toHaveLength(1);
    // Four buildings (BAYLA, PEPE, DRB, JBM), each one stack under its own hung roof.
    expect(container.querySelectorAll('[data-roof="kit"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-guides]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-shadow]')).toHaveLength(4);
  });

  it('the kit explodes: each storey starts stacked on its footing, then hangs in run order, each above the last', () => {
    // Seen as it mounts (with nothing to say it is seen, it stands finished: below), so its intro plays.
    stubObserver();
    const frame = stubFrames();
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'bayla', 'bayla'])} />);
    expect(introOf(container)).toBe('armed');
    expect(zOf(container, 'k2')).toBeCloseTo(0.55 + 1.7, 6);
    see(1);
    frame(16);
    frame(32);
    expect(introOf(container)).toBe('play');
    expect(zOf(container, 'k1')).toBeCloseTo(1.55, 6);
    expect(zOf(container, 'k2')).toBeCloseTo(4.3, 6);
    expect(zOf(container, 'k3')).toBeCloseTo(7.05, 6);
  });

  it('mid-run: the claimed storeys are down on the tower, the one at the wallet lifted clear, the rest hung above', async () => {
    const run: Kind[] = ['claimed', 'claimed', 'claimed', 'sending', 'waiting', 'waiting', 'waiting'];
    const { container } = render(<HarvestGranary storeys={storeys(S2, run)} />);
    expect(states(container)).toEqual(['k1:claimed', 'k2:claimed', 'k3:claimed', 'k4:sending', 'k5:waiting', 'k6:waiting', 'k7:waiting']);
    await waitFor(() => expect(zOf(container, 'k4')).toBeCloseTo(7.15, 6));
    expect([1, 2, 3].map((n) => zOf(container, `k${n}`).toFixed(2))).toEqual(['0.55', '2.25', '3.95']);
    // The revision cloud rings the storey at the wallet, and only it.
    expect(Array.from(container.querySelectorAll('[data-cloud]')).map((c) => c.closest('[data-plate]')!.getAttribute('data-plate'))).toEqual(['k4']);
    expect(container.querySelector('[data-cloud]')!.getAttribute('pathLength')).toBe('1');
  });

  it.each(['reverted', 'unconfirmed', 'declined', 'not-sent'] as const)('a claim that came to "%s" fades out and hangs as its dashed twin, never built', (state) => {
    const { container } = render(<HarvestGranary storeys={storeys(['drb', 'jbm'], ['claimed', state])} />);
    expect(plate(container, 'k2').getAttribute('data-state')).toBe(state);
    expect(plate(container, 'k2').style.opacity).toBe('0');
    expect(plate(container, 'k1').style.opacity).toBe('1');
    const twin = container.querySelector(`[data-ghosts] [data-ghost="k2"]`)!;
    expect(twin.getAttribute('data-state')).toBe(state);
    expect(container.querySelectorAll('[data-ghost]')).toHaveLength(1);
    expect(twin.querySelector('[data-plaque="02"]')).not.toBeNull();
  });

  it('a twin left hanging as its tower tops out arrives where its solid hung, then rises as the roof comes down', async () => {
    const four: Room[] = ['bayla', 'bayla', 'bayla', 'bayla'];
    const { container, rerender } = render(<HarvestGranary storeys={storeys(four, ['claimed', 'claimed', 'claimed', 'sending'])} />);
    await waitFor(() => expect(zOf(container, 'k4')).toBeCloseTo(7.15, 6));
    rerender(<HarvestGranary storeys={storeys(four, ['claimed', 'claimed', 'claimed', 'reverted'])} />);
    const twin = () => container.querySelector<SVGGElement>('[data-ghost="k4"]')!;
    const twinZ = () => -Number(/translateY\((-?[\d.]+)px\)/.exec(twin().style.transform)?.[1] ?? NaN) / U;
    // Under the roof still hung over it, never inside it; it does not also drop from LIFT above.
    expect(twinZ()).toBeCloseTo(7.15, 6);
    expect((twin().firstElementChild as SVGGElement).style.getPropertyValue('--ghost-from')).toBe('0px');
    // Then it rises to hang over the topped-out tower on the roof's own timing.
    await waitFor(() => expect(twinZ()).toBeCloseTo(8.65, 6));
    expect(twin().style.transition).toContain('750ms');
  });

  it('a twin left hanging mid-run arrives from LIFT above its place, where it hung at the wallet', async () => {
    const { container, rerender } = render(<HarvestGranary storeys={storeys(['drb', 'jbm'], ['sending', 'waiting'])} />);
    await waitFor(() => expect(zOf(container, 'k1')).toBeCloseTo(2.05, 6));
    rerender(<HarvestGranary storeys={storeys(['drb', 'jbm'], ['reverted', 'sending'])} />);
    const twin = container.querySelector<SVGGElement>('[data-ghost="k1"]')!;
    expect(-Number(/translateY\((-?[\d.]+)px\)/.exec(twin.style.transform)?.[1] ?? NaN) / U).toBeCloseTo(1.55, 6);
    expect((twin.firstElementChild as SVGGElement).style.getPropertyValue('--ghost-from')).toBe('-10px');
  });

  it('while the pools are read: no storey, no name, no roof; the bare footing with the line crossing it', () => {
    const { container } = render(<HarvestGranary storeys={[]} reading />);
    expect(container.querySelectorAll('[data-plate]')).toHaveLength(0);
    expect(container.querySelectorAll('.harvest-scan')).toHaveLength(1);
    expect(container.querySelector('text, [data-roof], [data-guides], [data-tower]')).toBeNull();
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('-70 -23 152 95');
  });

  it('nothing to claim: the bare footing, still; never a storey that reads as a reward', () => {
    const { container } = render(<HarvestGranary storeys={[]} />);
    expect(container.querySelectorAll('[data-plate]')).toHaveLength(0);
    expect(container.querySelector('.harvest-scan, text, [data-roof], [data-tower]')).toBeNull();
  });

  it('one group per network, its name on the ground where its buildings begin, in the order the run reaches it', () => {
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'drb', 'pepe', 'jbm'])} />);
    expect(Array.from(container.querySelectorAll('[data-tower]')).map((t) => t.getAttribute('data-tower'))).toEqual(['solana', 'base', 'ethereum']);
    const names = Array.from(container.querySelectorAll('[data-chain-name]'));
    expect(names.map((t) => t.textContent)).toEqual(['SOLANA', 'BASE', 'ETHEREUM']);
    expect(names.every((t) => t.closest('[data-street]') && !t.closest('[data-tower]'))).toBe(true);
  });

  it('a tower tops out (roof down, flag, smoke, halo) only once every claim on it has an answer and one was paid', () => {
    const run: Kind[] = ['claimed', 'claimed', 'claimed', 'reverted', 'reverted', 'claimed', 'waiting'];
    const { container } = render(<HarvestGranary storeys={storeys(S2, run)} />);
    const tower = (chain: string) => container.querySelector(`[data-tower="${chain}"]`)!;
    expect(tower('solana').hasAttribute('data-topped')).toBe(true);
    expect(tower('solana').querySelector('[data-roof]')!.getAttribute('data-roof')).toBe('topped');
    expect(tower('solana').querySelectorAll('[data-flag], [data-smoke], [data-halo]')).toHaveLength(3);
    // Nothing paid on Ethereum: its roof stays hung, in dashes, with no flag.
    expect(tower('ethereum').querySelector('[data-roof]')!.getAttribute('data-roof')).toBe('ghost');
    expect(tower('ethereum').querySelector('[data-flag], [data-smoke], [data-halo]')).toBeNull();
    // Base still has a claim waiting: no flag yet, though one is paid.
    expect(tower('base').hasAttribute('data-topped')).toBe(false);
    expect(tower('base').querySelector('[data-roof]')!.getAttribute('data-roof')).toBe('kit');
    expect(tower('base').querySelector('[data-flag]')).toBeNull();
    expect(container.querySelectorAll('[data-flag]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ridge]')).toHaveLength(4);
  });

  it('the caution mark is on a cautioned storey only, built or not (a claim paid may have paid less), never on a dashed one', () => {
    const cautioned = (run: Kind[]) => {
      const { container, unmount } = render(<HarvestGranary storeys={storeys(['bayla', 'bayla', 'bayla'], run, [2])} />);
      const where = Array.from(container.querySelectorAll('[data-caution]')).map((c) => c.closest('[data-plate], [data-ghost]')!.getAttribute('data-plate'));
      unmount();
      return where;
    };
    expect(cautioned([])).toEqual(['k2']);
    expect(cautioned(['claimed', 'waiting', 'waiting'])).toEqual(['k2']);
    expect(cautioned(['claimed', 'sending', 'waiting'])).toEqual(['k2']);
    expect(cautioned(['claimed', 'claimed', 'sending'])).toEqual(['k2']);
    expect(cautioned(['claimed', 'reverted', 'sending'])).toEqual([]);
  });

  it("each storey wears its room's door picture once the picture is read, and not before; one fetch per room", async () => {
    stubImages();
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'bayla', 'pepe'])} />);
    expect(container.querySelectorAll('image')).toHaveLength(0);
    await settle();
    const hrefs = Array.from(container.querySelectorAll('image')).map((i) => i.getAttribute('href'));
    const door = (id: string) => doorArt(BUNGALOWS.find((b) => b.id === id)!).src;
    expect(hrefs).toEqual([door('bayla'), door('bayla'), door('pepe')]);
    expect(container.querySelectorAll('[data-plate] image')).toHaveLength(3);
    expect(made.n).toBe(2);
  });

  it('from the 25th storey on a storey is brick in its room’s colour: 24 pictures at most', async () => {
    stubImages();
    const { container } = render(<HarvestGranary storeys={storeys(Array<Room>(25).fill('bayla'))} />);
    await settle();
    expect(container.querySelectorAll('[data-plate]')).toHaveLength(25);
    expect(container.querySelectorAll('[data-plate] image')).toHaveLength(24);
    expect(plate(container, 'k25').querySelector('image')).toBeNull();
  });

  it('asks for pictures only for the storeys that wear one: a room first met past the 24th storey is never fetched', async () => {
    stubImages();
    const { container } = render(<HarvestGranary storeys={storeys([...Array<Room>(24).fill('bayla'), 'pepe'])} />);
    await settle();
    expect(made.n).toBe(1);
    expect(container.querySelectorAll('[data-plate] image')).toHaveLength(24);
    expect(plate(container, 'k25').querySelector('image')).toBeNull();
  });

  it('takes the copy of a picture its wall spans as drawn, the height cap counted', async () => {
    vi.stubEnv('PROD', true);
    stubImages();
    // Twelve storeys in one room (viewBox 427 by 468) in a 1000 by 400 box: drawn at 0.85 a unit, not 2.34.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 400, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 400, toJSON: () => ({}) } as DOMRect);
    const { container } = render(<HarvestGranary storeys={storeys(Array<Room>(12).fill('bayla'))} />);
    await settle();
    const src = doorArt(BUNGALOWS.find((b) => b.id === 'bayla')!).src!;
    expect(muralSrc(src, 128, true)).not.toBe(muralSrc(src, 480, true));
    expect(new Set(Array.from(container.querySelectorAll('image')).map((i) => i.getAttribute('href')))).toEqual(new Set([muralSrc(src, 128, true)]));
  });

  it('under reduced motion the kit is drawn in place from its first frame', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'), media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'bayla', 'bayla'])} />);
    expect(zOf(container, 'k2')).toBeCloseTo(4.3, 6);
  });

  it('pools not read, and nothing to build: no footing at all, so nothing reads as nothing to claim', () => {
    const { container } = render(<HarvestGranary storeys={[]} unread />);
    expect(container.querySelectorAll('[data-plate], [data-tower], .harvest-scan')).toHaveLength(0);
    // The board and the site's ground plate on it alone (the defs' patterns aside): no footing, dashed or named.
    const drawn = Array.from(container.querySelectorAll('polygon')).filter((p) => !p.closest('defs'));
    expect(drawn.map((p) => (p.hasAttribute('data-site') ? 'site' : p.hasAttribute('data-board') ? 'board' : 'other'))).toEqual(['board', 'site']);
  });

  it('a claim that never reached the wallet (a network switch refused) arrives in place, not from where the wallet lifts it', async () => {
    const { container, rerender } = render(<HarvestGranary storeys={storeys(['drb', 'jbm'], ['waiting', 'waiting'])} />);
    await waitFor(() => expect(zOf(container, 'k1')).toBeCloseTo(1.55, 6));
    rerender(<HarvestGranary storeys={storeys(['drb', 'jbm'], ['unconfirmed', 'unconfirmed'])} />);
    const twin = container.querySelector<SVGGElement>('[data-ghost="k1"]')!;
    expect((twin.firstElementChild as SVGGElement).style.getPropertyValue('--ghost-from')).toBe('0px');
  });

  it('a twin hung before its tower tops out steps aside while the roof comes down: out of sight, moved, then back', async () => {
    // One building: the refused claim hangs over the storey that lands under it, and under the roof that comes down.
    const { container, rerender } = render(<HarvestGranary storeys={storeys(['drb', 'drb'], ['sending', 'waiting'])} />);
    await waitFor(() => expect(zOf(container, 'k1')).toBeCloseTo(2.05, 6));
    rerender(<HarvestGranary storeys={storeys(['drb', 'drb'], ['reverted', 'sending'])} />);
    const twin = () => container.querySelector<SVGGElement>('[data-ghost="k1"]')!;
    expect(twin().classList.contains('granary-ghost-hop')).toBe(false);
    rerender(<HarvestGranary storeys={storeys(['drb', 'drb'], ['reverted', 'claimed'])} />);
    // It never passes through the storey landing under it or the roof coming down: it moves only while unseen.
    expect(twin().classList.contains('granary-ghost-hop')).toBe(true);
    expect(twin().style.transition).toBe('transform 0s linear 300ms');
  });

  it('a picture that fails to load leaves its storey brick, never a hole', async () => {
    stubImages(true);
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'pepe'])} />);
    await settle();
    expect(container.querySelectorAll('image')).toHaveLength(0);
    expect(container.querySelectorAll('[data-plate]')).toHaveLength(2);
  });

  it('every storey is the same storey: a BAYLA and a PEPE storey have identical faces, and the drawing carries no amount', () => {
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'pepe'])} />);
    expect(shapeOf(plate(container, 'k1').querySelector('polygon'))).toBe(shapeOf(plate(container, 'k2').querySelector('polygon')));
    const walls = (key: string) => Array.from(plate(container, key).querySelectorAll('g[transform] > rect:last-child')).map((r) => `${r.getAttribute('width')}x${r.getAttribute('height')}`);
    expect(walls('k1')).toEqual(walls('k2'));
    // Its only words: each network's name, YOUR WALLET, each room's ticker, each storey's row number and ticker, each lane's number.
    expect(container.querySelector('svg')!.textContent).toBe('SOLANAETHEREUMYOUR WALLETBAYLA01BAYLAPEPE02PEPE0102');
  });

  it('pointing at a storey names its claim; leaving the drawing clears it; the storey pointed at whitens and lifts', () => {
    const onActive = vi.fn();
    const { container, rerender } = render(<HarvestGranary storeys={storeys(['bayla', 'bayla'])} onActive={onActive} />);
    fireEvent.mouseEnter(plate(container, 'k2'));
    expect(onActive).toHaveBeenLastCalledWith('k2');
    fireEvent.mouseLeave(container.querySelector('svg')!);
    expect(onActive).toHaveBeenLastCalledWith(null);
    rerender(<HarvestGranary storeys={storeys(['bayla', 'bayla'])} onActive={onActive} active="k2" />);
    expect(plate(container, 'k2').querySelector('polygon')!.getAttribute('stroke')).toBe('#ffffff');
    expect(plate(container, 'k1').querySelector('polygon')!.getAttribute('stroke')).not.toBe('#ffffff');
    expect((plate(container, 'k2').firstElementChild as SVGGElement).style.transform).toBe('translateY(-5px)');
  });
});

/** An element's opacity attribute, as a number. */
const opacityOf = (el: Element | null) => Number(el?.getAttribute('opacity') ?? NaN);
const SMALL = { width: 300, height: 260, x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 260, toJSON: () => ({}) } as DOMRect;

describe("Harvest's figure: the terrace, its light and its lettering", () => {
  it('twelve claims in one room stand as three stacks of four on one footing, under one name, every storey in row order', () => {
    const { container } = render(<HarvestGranary storeys={storeys(Array<Room>(12).fill('bayla'))} />);
    expect(container.querySelectorAll('[data-tower]')).toHaveLength(1);
    const stacks = container.querySelectorAll('[data-tower="solana"] > [data-room="bayla"] > [data-stack]');
    expect(Array.from(stacks).map((s) => [s.getAttribute('data-stack'), s.querySelectorAll('[data-plate]').length])).toEqual([['0', 4], ['1', 4], ['2', 4]]);
    expect(container.querySelectorAll('[data-roof="kit"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-chain-name]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-room-name]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-contact]')).toHaveLength(1);
    expect(Array.from(container.querySelectorAll('[data-plate]')).map((g) => g.getAttribute('data-plate'))).toEqual(Array.from({ length: 12 }, (_, i) => `k${i + 1}`));
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('-198 -286 427 468');
  });

  it('a finished stack keeps its roof hung, and the shadow under it, until its network has every answer', () => {
    const seven = Array<Room>(7).fill('bayla');
    const roofs = (run: Kind[]) => {
      const { container, unmount } = render(<HarvestGranary storeys={storeys(seven, run)} />);
      const out = Array.from(container.querySelectorAll('[data-tower="solana"] [data-stack]'))
        .map((s) => `${s.querySelector('[data-roof]')!.getAttribute('data-roof')}:${s.querySelectorAll('[data-shadow]').length}`);
      unmount();
      return out;
    };
    expect(roofs(['claimed', 'claimed', 'claimed', 'claimed', 'claimed', 'sending', 'waiting'])).toEqual(['kit:1', 'kit:1']);
    expect(roofs(Array<Kind>(7).fill('claimed'))).toEqual(['topped:0', 'topped:0']);
  });

  it('a window is dark glass until its claim is paid, then it burns; the same markup for every coin', () => {
    const ready = render(<HarvestGranary storeys={storeys(S2)} />);
    expect(ready.container.querySelectorAll('[data-window]')).toHaveLength(14);
    expect(ready.container.querySelectorAll('[data-window="lit"]')).toHaveLength(0);
    const panes = Array.from(ready.container.querySelectorAll('[data-window] [fill$="-pane)"]'));
    expect(panes).toHaveLength(14);
    expect(panes.every((p) => p.getAttribute('fill-opacity') === '0')).toBe(true);
    ready.unmount();
    const run = render(<HarvestGranary storeys={storeys(S2, ['claimed', 'claimed', 'claimed', 'sending', 'waiting', 'waiting', 'waiting'])} />);
    const lit = Array.from(run.container.querySelectorAll('[data-window="lit"]'));
    expect(lit).toHaveLength(6);
    expect(lit.every((w) => w.closest('[data-plate]')!.getAttribute('data-state') === 'claimed')).toBe(true);
    run.unmount();
    const two = render(<HarvestGranary storeys={storeys(['bayla', 'pepe'], ['claimed', 'claimed'])} />);
    const windows = (key: string) => Array.from(plate(two.container, key).querySelectorAll('[data-window]')).map((w) => w.outerHTML);
    expect(windows('k1')).toHaveLength(2);
    expect(windows('k1')).toEqual(windows('k2'));
  });

  it('a paid storey’s light falls on stone and ground only: its stack’s throw, the pools past its building, the next footing’s face, the crown once topped', () => {
    const S3: Kind[] = ['claimed', 'claimed', 'claimed', 'sending', 'waiting', 'waiting', 'waiting'];
    const S4: Kind[] = ['claimed', 'claimed', 'claimed', 'reverted', 'reverted', 'claimed', 'waiting'];
    for (const run of [[], S3, S4] as Kind[][]) {
      const list = storeys(S2, run);
      const towers = granaryLayout(networksOf(list));
      const { container, unmount } = render(<HarvestGranary storeys={list} />);
      for (const t of towers) {
        const stack = container.querySelector(`[data-tower="${t.chain}"] > [data-room="${t.lot.roomId}"] > [data-stack="${t.stack}"]`)!;
        expect(opacityOf(stack.querySelector('[data-throw]')) > 0, `${t.lot.roomId} throw`).toBe(t.built > 0);
      }
      // Two pools past each building's last stack, building by building along the street.
      const lasts = towers.filter((t) => t.last);
      const pools = Array.from(container.querySelectorAll('[data-pool]'));
      expect(pools).toHaveLength(2 * lasts.length);
      pools.forEach((p, i) => expect(opacityOf(p) > 0).toBe(lasts[Math.floor(i / 2)]!.built > 0));
      // The wash lies on a footing's face only, thrown by the building before it on the street, whatever its network.
      const wash = (room: string) => container.querySelector(`[data-room="${room}"] [data-wash]`);
      const builtIn = (room: string) => lasts.find((t) => t.lot.roomId === room)!.built > 0;
      expect(wash('bayla')).toBeNull();
      expect(opacityOf(wash('pepe')) > 0).toBe(builtIn('bayla'));
      expect(opacityOf(wash('drb')) > 0).toBe(builtIn('pepe'));
      expect(opacityOf(wash('jbm')) > 0).toBe(builtIn('drb'));
      expect(Array.from(container.querySelectorAll('[data-crown]')).map((c) => c.closest('[data-tower]')!.getAttribute('data-tower')))
        .toEqual(towers.filter((t) => t.topped).map((t) => t.chain));
      unmount();
    }
  });

  it('each solid storey has one profile line, heavier than the lines inside it; its weight follows its state alone', () => {
    const { container, rerender } = render(<HarvestGranary storeys={storeys(['bayla', 'pepe'])} />);
    expect(container.querySelectorAll('[data-profile]')).toHaveLength(2);
    const profile = (key: string) => plate(container, key).querySelector('[data-profile]')!;
    expect(shapeOf(profile('k1'))).toBe(shapeOf(profile('k2')));
    for (const a of ['stroke', 'stroke-width', 'stroke-opacity']) expect(profile('k1').getAttribute(a)).toBe(profile('k2').getAttribute(a));
    const inside = Number(plate(container, 'k1').querySelector('polygon')!.getAttribute('stroke-width'));
    expect(Number(profile('k1').getAttribute('stroke-width'))).toBeGreaterThan(inside);
    rerender(<HarvestGranary storeys={storeys(['bayla', 'pepe'])} active="k2" />);
    expect(profile('k2').getAttribute('stroke')).toBe('#ffffff');
    expect(profile('k1').getAttribute('stroke')).not.toBe('#ffffff');
  });

  it('whatever hangs over a hung storey shades its top; a built storey and a dashed one carry no shade; the board, and each footing’s contact', () => {
    const shaded = (list: GranaryStorey[]) => {
      const { container, unmount } = render(<HarvestGranary storeys={list} />);
      const out = Array.from(container.querySelectorAll('[data-shade]')).map((s) => s.closest('[data-plate], [data-ghost]')!.getAttribute('data-plate') ?? 'twin');
      const counts = [container.querySelectorAll('[data-board]').length, container.querySelectorAll('[data-contact]').length];
      unmount();
      return { out, counts };
    };
    // One contact a building: BAYLA, PEPE, DRB, JBM.
    expect(shaded(storeys(S2))).toEqual({ out: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'], counts: [1, 4] });
    // A claim paid but still hung (one before it in its stack is at the wallet) is shaded too.
    expect(shaded(storeys(['drb', 'drb', 'drb'], ['sending', 'claimed', 'waiting']))).toEqual({ out: ['k1', 'k2', 'k3'], counts: [1, 1] });
    expect(shaded(storeys(['drb', 'jbm', 'pepe'], ['claimed', 'reverted', 'claimed']))).toEqual({ out: [], counts: [1, 3] });
    for (const bare of [{ reading: true }, { unread: true }, {}]) {
      const { container, unmount } = render(<HarvestGranary storeys={[]} {...bare} />);
      expect(container.querySelectorAll('[data-board]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-contact], [data-shade]')).toHaveLength(0);
      unmount();
    }
  });

  it('drawn small, each storey is lettered with a number tile and no ticker, its caution mark kept', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(SMALL);
    const { container } = render(<HarvestGranary storeys={storeys(S2, [], [4])} />);
    await waitFor(() => expect(container.querySelector('svg')!.getAttribute('data-lettering')).toBe('m'));
    for (const p of Array.from(container.querySelectorAll('[data-plate]'))) expect(p.querySelectorAll('[data-plaque]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ticker]')).toHaveLength(0);
    expect(Array.from(container.querySelectorAll('[data-caution]')).map((c) => c.closest('[data-plate]')!.getAttribute('data-plate'))).toEqual(['k4']);
    // Its words: each network's name, YOUR WALLET, each room's ticker, each storey's row number, the caution's mark; no lane number.
    expect(container.querySelector('svg')!.textContent).toBe('SOLANAETHEREUMBASEYOUR WALLETBAYLA01020304!PEPE05DRB06JBM07');
    expect(container.querySelector('[data-room-name]')!.getAttribute('font-size')).toBe('8.6');
    expect(container.querySelector('[data-chain-name]')!.getAttribute('font-size')).toBe('11');
    // YOUR WALLET is raised to draw 10 px on screen at this size (S2's 514 by 518 drawn at 0.50 a unit); its halo keeps its proportion.
    const name = container.querySelector('[data-wallet-name]')!;
    const size = Number(name.getAttribute('font-size'));
    expect(size * Math.min(300 / 514, 260 / 518)).toBeGreaterThanOrEqual(10);
    expect(Number(name.getAttribute('stroke-width')) / size).toBeCloseTo(3 / 10.4, 2);
  });

  it('YOUR WALLET draws 10 px tall or more on screen however the drawing is laid out, a phone’s drawing at half a sheet px a unit included', async () => {
    // Laid out at width by height: the drawn scale (meet), and the name's type on screen.
    const onScreen = async (list: GranaryStorey[], width: number, height: number) => {
      const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...SMALL, width, height, right: width, bottom: height });
      const { container, unmount } = render(<HarvestGranary storeys={list} />);
      await settle();
      const [, , w, h] = container.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);
      const drawnAt = Math.min(width / w!, height / h!);
      const px = Number(container.querySelector('[data-wallet-name]')!.getAttribute('font-size')) * drawnAt;
      unmount();
      rect.mockRestore();
      return { drawnAt, px };
    };
    // S2 on a phone (326 by 368), the delta's S8 on a phone, S2 and S1 on a desktop.
    for (const [list, width, height] of [[storeys(S2), 326, 368], [storeys(S8), 326, 368], [storeys(S2), 560, 576], [storeys(['bayla']), 560, 576]] as const) {
      const { drawnAt, px } = await onScreen(list, width, height);
      expect(drawnAt, `${list.length} at ${width}`).toBeGreaterThanOrEqual(0.5);
      expect(px, `${list.length} at ${width}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('unmeasured, or drawn at a sheet px a unit or more, each storey carries its plaque: number and ticker', async () => {
    const first = render(<HarvestGranary storeys={storeys(S2)} />);
    expect(first.container.querySelector('svg')!.getAttribute('data-lettering')).toBe('l');
    expect(first.container.querySelectorAll('[data-ticker]')).toHaveLength(7);
    expect(first.container.querySelector('[data-room-name]')!.getAttribute('font-size')).toBe('6.6');
    expect(first.container.querySelector('[data-chain-name]')!.getAttribute('font-size')).toBe('9.2');
    expect([first.container.querySelector('[data-wallet-name]')!.getAttribute('font-size'), first.container.querySelector('[data-wallet-name]')!.getAttribute('stroke-width')]).toEqual(['7.4', '2.2']);
    first.unmount();
    // S2's viewBox (514 by 518) laid out at one sheet px a unit.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...SMALL, width: 514, height: 518, right: 514, bottom: 518 });
    const { container } = render(<HarvestGranary storeys={storeys(S2)} />);
    await settle();
    expect(container.querySelector('svg')!.getAttribute('data-lettering')).toBe('l');
    expect(container.querySelectorAll('[data-ticker]')).toHaveLength(7);
  });

  it('the lettering is cut by the size the drawing is laid out at, never by the lean of the turn round it', async () => {
    // S2 (514 by 518) laid out 600 by 510 (the height cap binds: 0.98 a unit, under 1); leaning 2 degrees its box reads 531 tall.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...SMALL, width: 600, height: 531, right: 600, bottom: 531 });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      return el instanceof SVGSVGElement ? new Proxy(style, { get: (o, k) => (k === 'height' ? '510px' : Reflect.get(o, k, o)) }) : style;
    });
    const { container } = render(<HarvestGranary storeys={storeys(S2)} />);
    await settle();
    expect(container.querySelector('svg')!.getAttribute('data-lettering')).toBe('m');
  });
});

/* ─────────────── the city ─────────────── */

const S3_RUN: Kind[] = ['claimed', 'claimed', 'claimed', 'sending', 'waiting', 'waiting', 'waiting'];
const S4_DONE: Kind[] = ['claimed', 'claimed', 'claimed', 'reverted', 'claimed', 'claimed', 'claimed'];
const S8: Room[] = ['bayla', 'bayla', 'bayla', 'bayla', 'bobo', 'bobo', 'bayla', 'pepe', 'drb', 'jbm'];
/** The lanes in the street's order: each one's claim and state. */
const lanesOf = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-lanes] > [data-lane]')).map((g) => `${g.getAttribute('data-lane')}:${g.getAttribute('data-state')}`);
const keysOf = (root: HTMLElement, hook: string) => Array.from(root.querySelectorAll(`[${hook}]`)).map((el) => el.getAttribute(hook));
/** A polyline's points, as the markup writes them. */
const pointsOf = (el: Element | null) => (el?.getAttribute('points') ?? '').trim().split(/\s+/);
const sheet = (x: number, y: number, z: number) => iso([x, y, z], U).map((v) => Math.round(v * 100) / 100).join(',');
/**
 * Where a lane whose claim did not land ends, worked here from its route: half the whole of it (out of its
 * building, along the street, up the wallet's step, over the threshold to its door), measured from its building.
 */
const halfway = (plan: ReturnType<typeof cityPlan>, l: { x: number; y: number }): [number, number, number] => {
  const out = l.y - (D + M);
  const along = l.x - (plan.face + W_POD_OVER);
  const half = (out + along + W_POD + W_POD_OVER) / 2;
  // Past the stub out of its building and short of the wallet's step: it ends on the street.
  expect(half).toBeGreaterThan(out);
  expect(half).toBeLessThan(out + along);
  return [l.x - (half - out), l.y, 0];
};

describe("Harvest's figure: the city", () => {
  it('a building a room along one street, its ticker on its footing, its network named on the ground; one lane a claim to YOUR WALLET, a door per network', () => {
    const { container } = render(<HarvestGranary storeys={storeys(S2)} />);
    expect(container.querySelectorAll('[data-wallet]')).toHaveLength(1);
    expect(Array.from(container.querySelectorAll('[data-wallet-name]')).map((n) => n.textContent)).toEqual(['YOUR WALLET']);
    expect(lanesOf(container)).toEqual(states(container));
    expect(keysOf(container, 'data-door')).toEqual(['solana', 'ethereum', 'base']);
    expect(keysOf(container, 'data-net')).toEqual(['solana', 'solana', 'solana', 'solana', 'ethereum', 'base', 'base']);
    const towers = Array.from(container.querySelectorAll('[data-tower]'));
    expect(towers.map((t) => [t.getAttribute('data-tower'), Array.from(t.querySelectorAll(':scope > [data-room]')).map((r) => r.getAttribute('data-room'))]))
      .toEqual([['solana', ['bayla']], ['ethereum', ['pepe']], ['base', ['drb', 'jbm']]]);
    expect(Array.from(container.querySelectorAll('[data-room-name]')).map((n) => n.textContent)).toEqual(['BAYLA', 'PEPE', 'DRB', 'JBM']);
    expect(Array.from(container.querySelectorAll('[data-chain-name]')).map((n) => n.textContent)).toEqual(['SOLANA', 'ETHEREUM', 'BASE']);
    expect(container.querySelector('[data-tower] [data-chain-name], [data-tower] [data-wallet], [data-tower] [data-lane]')).toBeNull();
    // Back to front: the street and the wallet under every building, then the lanes, then their numbers.
    const svg = container.querySelector('svg')!;
    const at = ['[data-street]', '[data-wallet]', '[data-tower]', '[data-lanes]', '[data-lane-tags]'].map((s) => Array.from(svg.children).indexOf(svg.querySelector(`:scope > ${s}`)!));
    expect(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]!))).toBe(true);
  });

  it('before a press nothing has arrived and nothing moves: no plate, no march, no run, every lane hollow, the wallet and its doors dark', () => {
    const { container } = render(<HarvestGranary storeys={storeys(S2)} />);
    expect(container.querySelectorAll('[data-landed], [data-lane-march], [data-lane-run], [data-lane-glow], [data-lane-stop]')).toHaveLength(0);
    expect(container.querySelector('[data-wallet]')!.getAttribute('data-lit')).toBe('off');
    expect(new Set(Array.from(container.querySelectorAll('[data-lane-core]')).map((c) => c.getAttribute('stroke')))).toEqual(new Set([BG]));
    expect(Array.from(container.querySelectorAll('[data-door]')).map((d) => d.getAttribute('fill-opacity'))).toEqual(['0.05', '0.05', '0.05']);
    expect(container.querySelectorAll('[data-spot]')).toHaveLength(3);
  });

  it('mid-run: one plate a claim paid, stacked on its network’s spot; one march, the claim at the wallet; the wallet and that network’s door lit', () => {
    const { container } = render(<HarvestGranary storeys={storeys(S2, S3_RUN)} />);
    expect(keysOf(container, 'data-landed')).toEqual(['k1', 'k2', 'k3']);
    expect(Array.from(container.querySelectorAll('[data-lane-march]')).map((m) => m.closest('[data-lane]')!.getAttribute('data-lane'))).toEqual(['k4']);
    expect(Array.from(container.querySelectorAll('[data-lane-run]')).map((m) => m.closest('[data-lane]')!.getAttribute('data-lane'))).toEqual(['k1', 'k2', 'k3']);
    expect(container.querySelector('[data-wallet]')!.getAttribute('data-lit')).toBe('on');
    expect(Array.from(container.querySelectorAll('[data-door]')).map((d) => `${d.getAttribute('data-door')}:${d.getAttribute('fill-opacity')}`)).toEqual(['solana:0.16', 'ethereum:0.05', 'base:0.05']);
    // One on another: each plate's top 3 px over the one before (0.12 thick, 0.03 apart).
    const tops = Array.from(container.querySelectorAll('[data-landed]')).map((g) => Number(pointsOf(g.querySelector('polygon:last-of-type'))[0]!.split(',')[1]));
    expect(tops.slice(1).map((t, i) => Math.round((tops[i]! - t) * 100) / 100)).toEqual([3, 3]);
  });

  it('done: one plate per claim paid and none for the refused one, whose lane is dashed, has no core and stops short of the wallet behind a bar', () => {
    const { container } = render(<HarvestGranary storeys={storeys(S2, S4_DONE)} />);
    expect(keysOf(container, 'data-landed')).toEqual(['k1', 'k2', 'k3', 'k5', 'k6', 'k7']);
    const refused = container.querySelector('[data-lane="k4"]')!;
    expect(refused.getAttribute('data-state')).toBe('reverted');
    expect(refused.querySelector('[data-lane-line]')!.getAttribute('stroke-dasharray')).toBe('4 2.5');
    expect(pointsOf(refused.querySelector('[data-lane-line]'))).toHaveLength(3);
    expect(refused.querySelectorAll('[data-lane-stop]')).toHaveLength(1);
    expect(refused.querySelector('[data-lane-core], [data-lane-run], [data-lane-glow], [data-lane-march]')).toBeNull();
    expect(pointsOf(container.querySelector('[data-lane="k5"] [data-lane-line]'))).toHaveLength(5);
  });

  it('each lane runs from its own building’s front to its own network’s door, and nowhere else', () => {
    for (const run of [[], S4_DONE] as Kind[][]) {
      const list = storeys(S2, run);
      const plan = cityPlan(granaryLayout(networksOf(list)));
      const { container, unmount } = render(<HarvestGranary storeys={list} />);
      for (const l of plan.lanes) {
        const line = pointsOf(container.querySelector(`[data-lane="${l.storey.key}"] [data-lane-line]`));
        expect(line[0]).toBe(sheet(l.x, D + M, 0));
        expect(line[line.length - 1]).toBe(l.storey.state === 'reverted' ? sheet(...halfway(plan, l)) : sheet(plan.face, l.y, W_POD));
        const door = container.querySelector(`[data-door="${l.storey.chain}"]`)!;
        expect(door).not.toBeNull();
      }
      unmount();
    }
  });

  it('every lane is one width and every plate one size whatever it pays: two coins in one state wear one paint', () => {
    for (const run of [[], S3_RUN, S4_DONE] as Kind[][]) {
      const { container, unmount } = render(<HarvestGranary storeys={storeys(S2, run)} />);
      for (const part of ['data-lane-line', 'data-lane-bed', 'data-lane-core', 'data-lane-glow', 'data-lane-march']) {
        expect(new Set(Array.from(container.querySelectorAll(`[${part}]`)).map((el) => el.getAttribute('stroke-width'))).size, part).toBeLessThanOrEqual(1);
      }
      const paint = (el: Element) => ['stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray'].map((a) => el.getAttribute(a)).join('|');
      expect(new Set(Array.from(container.querySelectorAll('[data-lane][data-state="claimed"] [data-lane-line]')).map(paint)).size).toBeLessThanOrEqual(1);
      expect(new Set(Array.from(container.querySelectorAll('[data-landed]')).map((g) => Array.from(g.querySelectorAll('polygon')).map(shapeOf).join('|'))).size).toBeLessThanOrEqual(1);
      unmount();
    }
    // At rest two coins on one network wear one paint; two networks differ in the line's colour alone.
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'bayla', 'drb', 'jbm'])} />);
    const line = (key: string) => container.querySelector(`[data-lane="${key}"] [data-lane-line]`)!;
    for (const a of ['stroke', 'stroke-opacity', 'stroke-width']) expect(line('k3').getAttribute(a)).toBe(line('k4').getAttribute(a));
    for (const a of ['stroke-opacity', 'stroke-width']) expect(line('k1').getAttribute(a)).toBe(line('k3').getAttribute(a));
    expect(line('k1').getAttribute('stroke')).not.toBe(line('k3').getAttribute('stroke'));
  });

  it('reading, nothing to claim and a pool not read draw no wallet, no street, no lane; with claims the board is drawn lighter', () => {
    for (const bare of [{ reading: true }, { unread: true }, {}]) {
      const { container, unmount } = render(<HarvestGranary storeys={[]} {...bare} />);
      expect(container.querySelectorAll('[data-wallet], [data-lanes], [data-lane], [data-street], [data-room], [data-lane-n]')).toHaveLength(0);
      expect(container.querySelector('[data-site]')!.getAttribute('fill-opacity')).toBe('0.94');
      unmount();
    }
    const { container } = render(<HarvestGranary storeys={storeys(['bayla'])} />);
    expect(container.querySelector('[data-site]')!.getAttribute('fill-opacity')).toBe('0.84');
  });

  it('each network’s plates stack in the order its claims were paid (the run’s), never the street’s', () => {
    const { container } = render(<HarvestGranary storeys={storeys(S8, Array<Kind>(10).fill('claimed'))} />);
    expect(keysOf(container, 'data-landed')).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10']);
    expect(Array.from(container.querySelectorAll('[data-landed]')).map((g) => g.previousElementSibling?.getAttribute('data-spot') ?? 'on')).toEqual([
      'solana', 'on', 'on', 'on', 'on', 'on', 'on', 'ethereum', 'base', 'on',
    ]);
  });

  it('a lane whose claim did not land ends halfway along its route from its building, its stop bar there, never at a door', () => {
    const cases: [Room[], Kind[]][] = [
      [S2, S4_DONE],
      [['bayla', 'pepe', 'drb', 'jbm'], ['reverted', 'unconfirmed', 'declined', 'not-sent']],
      [S8, ['claimed', 'reverted', 'claimed', 'claimed', 'unconfirmed', 'claimed', 'claimed', 'claimed', 'claimed', 'declined']],
    ];
    for (const [rooms, run] of cases) {
      const list = storeys(rooms, run);
      const plan = cityPlan(granaryLayout(networksOf(list)));
      const { container, unmount } = render(<HarvestGranary storeys={list} />);
      for (const l of plan.lanes.filter((x) => isGhost(x.storey.state))) {
        const end = halfway(plan, l);
        const g = container.querySelector(`[data-lane="${l.storey.key}"]`)!;
        expect(pointsOf(g.querySelector('[data-lane-line]'))).toEqual([sheet(l.x, D + M, 0), sheet(l.x, l.y, 0), sheet(...end)]);
        // Its stop bar stands across the lane where it ends.
        const bar = g.querySelector('[data-lane-stop]')!;
        const mid = ['x', 'y'].map((a) => (Number(bar.getAttribute(`${a}1`)) + Number(bar.getAttribute(`${a}2`))) / 2);
        const at = iso(end, U);
        expect(mid[0]).toBeCloseTo(at[0], 1);
        expect(mid[1]).toBeCloseTo(at[1], 1);
        // On the street, short of the wallet's step: it never climbs to a door.
        expect(end[0]).toBeGreaterThan(plan.face + W_POD_OVER);
      }
      unmount();
    }
  });

  it('the lane of the claim at the wallet is amber, a light dashed line inside it, and nothing on it moves', () => {
    const { container } = render(<HarvestGranary storeys={storeys(S2, S3_RUN)} />);
    const lane = container.querySelector('[data-lane="k4"]')!;
    expect(lane.getAttribute('data-state')).toBe('sending');
    expect(lane.querySelector('[data-lane-line]')!.getAttribute('stroke')).toBe(AMBER);
    expect(lane.querySelector('[data-lane-line]')!.getAttribute('stroke-dasharray')).toBeNull();
    expect(lane.querySelector('[data-lane-march]')!.getAttribute('stroke-dasharray')).toBe('3 5');
    // No class on any part of it: index.css moves none of them.
    expect(lane.querySelectorAll('[class]')).toHaveLength(0);
  });

  it('a claim not confirmed draws no plate in the wallet, leaves its network’s door dark, and its lane is dashed in its own paint', () => {
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'pepe', 'drb'], ['claimed', 'unconfirmed', 'claimed'])} />);
    expect(keysOf(container, 'data-landed')).toEqual(['k1', 'k3']);
    expect(Array.from(container.querySelectorAll('[data-door]')).map((d) => `${d.getAttribute('data-door')}:${d.getAttribute('fill-opacity')}`))
      .toEqual(['solana:0.16', 'ethereum:0.05', 'base:0.16']);
    const lane = container.querySelector('[data-lane="k2"]')!;
    expect(lane.getAttribute('data-state')).toBe('unconfirmed');
    expect(lane.querySelector('[data-lane-line]')!.getAttribute('stroke-dasharray')).toBe(GHOST_PAINT.unconfirmed.dash);
    expect(lane.querySelectorAll('[data-lane-stop]')).toHaveLength(1);
    expect(lane.querySelector('[data-lane-run], [data-lane-core]')).toBeNull();
  });

  it('a lane carries its row’s number where it leaves its building only while the figure is drawn at a sheet px a unit or more', async () => {
    const big = render(<HarvestGranary storeys={storeys(S8)} />);
    // The street's order: each building's lanes together (BAYLA's row 07 stands before BOBO's 05 and 06).
    expect(keysOf(big.container, 'data-lane-n')).toEqual(['01', '02', '03', '04', '07', '05', '06', '08', '09', '10']);
    expect(lanesOf(big.container).map((l) => l.split(':')[0])).toEqual(['k1', 'k2', 'k3', 'k4', 'k7', 'k5', 'k6', 'k8', 'k9', 'k10']);
    big.unmount();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(SMALL);
    const { container } = render(<HarvestGranary storeys={storeys(S8)} />);
    await waitFor(() => expect(container.querySelector('svg')!.getAttribute('data-lettering')).toBe('m'));
    expect(container.querySelectorAll('[data-lane-n], [data-lane-tags]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-lane]')).toHaveLength(10);
  });
});

/* ─────────────── its life on screen ─────────────── */

type Seen = { isIntersecting: boolean; intersectionRatio: number };
/** The IntersectionObserver the drawing makes, driven by the test: see(ratio) reports its share in view. */
const watcher = { tell: null as ((entries: Seen[]) => void) | null, made: 0 };
function stubObserver() {
  watcher.tell = null;
  watcher.made = 0;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(tell: (entries: Seen[]) => void) {
      watcher.tell = tell;
      watcher.made += 1;
    }
    observe() {}
    unobserve() {}
    disconnect() {
      watcher.tell = null;
    }
  });
}
const see = (ratio: number) => act(() => {
  watcher.tell?.([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]);
});

/** Frames by hand: a frame asked for runs only at frame(t), at time t; performance.now() reads the same clock (at(t) sets it). */
function stubFrames() {
  let now = 0;
  let id = 0;
  let queue: [number, FrameRequestCallback][] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push([++id, cb]);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (h: number) => {
    queue = queue.filter(([i]) => i !== h);
  });
  const frame = (t: number) => act(() => {
    now = t;
    const due = queue;
    queue = [];
    for (const [, cb] of due) cb(t);
  });
  return Object.assign(frame, { at: (t: number) => { now = t; } });
}

/** matchMedia saying yes to any query holding one of `on`: 'pointer: fine', 'reduce', 'print'. */
const media = (...on: string[]) => vi.stubGlobal('matchMedia', (q: string) => ({
  matches: on.some((w) => q.includes(w)), media: q, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
}));

/** The figure as the card holds it: the card, its heading, the band, and the plain element the model turns in. */
function InCard({ list }: { list: GranaryStorey[] }) {
  return (
    <div data-card="">
      <p data-heading="">Harvest</p>
      <div className="hv"><div className="hv-turn"><HarvestGranary storeys={list} /></div></div>
    </div>
  );
}
const introOf = (root: HTMLElement) => root.querySelector('svg')!.getAttribute('data-intro');
const THREE: Room[] = ['bayla', 'bayla', 'bayla'];
/** Three ready on one network: where they hang, and where they stand stacked on the footing before the kit rises. */
const HUNG = [1.55, 4.3, 7.05];
const STACKED = [0.55, 2.25, 3.95];
const zs = (root: HTMLElement) => ['k1', 'k2', 'k3'].map((k) => Number(zOf(root, k).toFixed(2)));

describe("Harvest's figure: its life on screen", () => {
  afterEach(() => vi.useRealTimers());

  it('with no observer (jsdom), printed or under reduced motion, the drawing stands finished from its first frame: never armed, never blank', () => {
    // jsdom has no IntersectionObserver: nothing can say the drawing is seen, so nothing waits on it.
    expect(typeof IntersectionObserver).toBe('undefined');
    const plain = render(<HarvestGranary storeys={storeys(THREE)} />);
    expect(introOf(plain.container)).toBeNull();
    expect(zs(plain.container)).toEqual(HUNG);
    plain.unmount();
    for (const on of ['print', 'reduce']) {
      media(on);
      stubObserver();
      const { container, unmount } = render(<HarvestGranary storeys={storeys(THREE)} />);
      expect(introOf(container), on).toBeNull();
      expect(zs(container), on).toEqual(HUNG);
      see(0.01);
      expect(introOf(container), on).toBeNull();
      unmount();
    }
  });

  it('printed while armed, the drawing is finished before the page is laid out for print, and never armed again', () => {
    stubObserver();
    stubFrames();
    const { container } = render(<HarvestGranary storeys={storeys(THREE)} />);
    see(0.3);
    expect(introOf(container)).toBe('armed');
    act(() => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(introOf(container)).toBeNull();
    expect(zs(container)).toEqual(HUNG);
    see(0);
    see(1);
    expect(introOf(container)).toBeNull();
  });

  it('a card in view as it mounts is armed from its first frame, never the finished drawing first, and plays once', () => {
    stubObserver();
    const frame = stubFrames();
    const { container } = render(<HarvestGranary storeys={storeys(THREE)} />);
    // The first frame committed: armed (index.css hides it), the kit stacked on its footing.
    expect(introOf(container)).toBe('armed');
    expect(zs(container)).toEqual(STACKED);
    see(1);
    expect(introOf(container)).toBe('armed');
    frame(16);
    expect(introOf(container)).toBe('armed');
    expect(zs(container)).toEqual(STACKED);
    frame(32);
    expect(introOf(container)).toBe('play');
    expect(zs(container)).toEqual(HUNG);
    // Once for this mount: off screen and back, it is never armed again.
    see(0);
    see(1);
    expect(introOf(container)).toBe('play');
    expect(zs(container)).toEqual(HUNG);
    frame(48);
    frame(64);
    expect(introOf(container)).toBe('play');
    expect(zs(container)).toEqual(HUNG);
  });

  it('the sheet draws itself only when it is looked at', () => {
    stubObserver();
    const frame = stubFrames();
    const { container } = render(<HarvestGranary storeys={storeys(THREE)} />);
    // Off screen as it mounts: it stands finished, set there at once (a print or a full-page picture shows it whole).
    see(0);
    expect(introOf(container)).toBeNull();
    expect(zs(container)).toEqual(HUNG);
    expect(plate(container, 'k1').style.transition).toBe('none');
    // Its first pixel in view: armed, the kit stacked on its footing.
    see(0.01);
    expect(introOf(container)).toBe('armed');
    expect(zs(container)).toEqual(STACKED);
    // Nine tenths in view, two frames on: it plays, each part rising once the sheet is inked.
    see(0.9);
    frame(16);
    frame(32);
    expect(introOf(container)).toBe('play');
    expect(zs(container)).toEqual(HUNG);
    expect(plate(container, 'k1').style.transition).toContain('800ms cubic-bezier(0.22, 1, 0.36, 1) 460ms');
    expect(plate(container, 'k3').style.transition).toContain('800ms cubic-bezier(0.22, 1, 0.36, 1) 580ms');
  });

  it('an armed sheet never waits on screen: 0.9 s after its first pixel it plays', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    stubObserver();
    const frame = stubFrames();
    const { container } = render(<HarvestGranary storeys={storeys(THREE)} />);
    see(0.2);
    act(() => {
      vi.advanceTimersByTime(899);
    });
    frame(16);
    frame(32);
    expect(introOf(container)).toBe('armed');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    frame(48);
    frame(64);
    expect(introOf(container)).toBe('play');
  });

  it('reduced motion: no intro, hung at once, nothing watches for it and nothing listens to the pointer', () => {
    media('reduce', 'pointer: fine');
    stubObserver();
    const listen = vi.spyOn(document, 'addEventListener');
    const { container } = render(<InCard list={storeys(THREE)} />);
    expect(introOf(container)).toBeNull();
    expect(zs(container)).toEqual(HUNG);
    expect(listen.mock.calls.map(([type]) => type)).not.toContain('pointermove');
    expect(watcher.made).toBe(0);
  });

  it('data-where is the layout’s word: a paid storey still hung is aloft, built once every storey before it in its stack answered', () => {
    // One building, one stack: DRB's second claim is paid while its first is at the wallet.
    const { container, rerender } = render(<HarvestGranary storeys={storeys(['drb', 'drb'], ['sending', 'claimed'])} />);
    expect(plate(container, 'k2').getAttribute('data-state')).toBe('claimed');
    expect(['k1', 'k2'].map((k) => plate(container, k).getAttribute('data-where'))).toEqual(['aloft', 'aloft']);
    rerender(<HarvestGranary storeys={storeys(['drb', 'drb'], ['claimed', 'claimed'])} />);
    expect(['k1', 'k2'].map((k) => plate(container, k).getAttribute('data-where'))).toEqual(['built', 'built']);
    rerender(<HarvestGranary storeys={storeys(['drb', 'drb'], ['claimed', 'reverted'])} />);
    expect(plate(container, 'k2').getAttribute('data-where')).toBe('ghost');
    // In two buildings (DRB, then JBM) a paid claim in the second lands while the first is still at the wallet.
    rerender(<HarvestGranary storeys={storeys(['drb', 'jbm'], ['sending', 'claimed'])} />);
    expect(['k1', 'k2'].map((k) => plate(container, k).getAttribute('data-where'))).toEqual(['aloft', 'built']);
  });

  it('data-thud is absent before a stack’s first storey is built and flips a, b, a with each one built on that stack', () => {
    const five = Array<Room>(5).fill('bayla');
    const run = (n: number): Kind[] => five.map((_, i) => (i < n ? 'claimed' : i === n ? 'sending' : 'waiting'));
    const { container, rerender } = render(<HarvestGranary storeys={storeys(five, run(0))} />);
    const thuds = () => Array.from(container.querySelectorAll('[data-stack]')).map((s) => s.getAttribute('data-thud'));
    // Five on one network stand as stacks of three and two.
    expect(thuds()).toEqual([null, null]);
    const seen: (string | null)[][] = [];
    for (let n = 1; n <= 5; n++) {
      rerender(<HarvestGranary storeys={storeys(five, run(n))} />);
      seen.push(thuds());
    }
    expect(seen).toEqual([['a', null], ['b', null], ['a', null], ['a', 'a'], ['a', 'b']]);
  });

  it('every hung part carries its place in the run: a storey its row less one, a stack’s roof and guides its last row, its shadow its first row less one', () => {
    const { container } = render(<HarvestGranary storeys={storeys(Array<Room>(5).fill('bayla'))} />);
    const k = (el: Element | null) => (el as SVGElement | null)?.style.getPropertyValue('--k');
    expect(Array.from(container.querySelectorAll('[data-plate]')).map(k)).toEqual(['0', '1', '2', '3', '4']);
    const stack = (j: number) => container.querySelector(`[data-stack="${j}"]`)!;
    expect([0, 1].map((j) => k(stack(j).querySelector('[data-roof]')))).toEqual(['3', '5']);
    expect([0, 1].map((j) => k(stack(j).querySelector('[data-guides]')))).toEqual(['3', '5']);
    expect([0, 1].map((j) => k(stack(j).querySelector('[data-shadow]')))).toEqual(['0', '3']);
  });

  it('dust is the same for every storey: five puffs at its foot, three at a roof’s cornice, none on a dashed twin or a bare footing', () => {
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'pepe', 'drb'], ['claimed', 'claimed', 'reverted'])} />);
    // Each puff from the first, to a tenth of a pixel, with its size.
    const puffs = (el: Element) => {
      const cs = Array.from(el.querySelectorAll('[data-dust] circle'));
      const at = (c: Element | undefined, a: string) => Number(c?.getAttribute(a));
      return cs.map((c) => `${(at(c, 'cx') - at(cs[0], 'cx')).toFixed(1)},${(at(c, 'cy') - at(cs[0], 'cy')).toFixed(1)},${c.getAttribute('r')}`);
    };
    expect(plate(container, 'k1').querySelectorAll('[data-dust]')).toHaveLength(1);
    expect(puffs(plate(container, 'k1'))).toHaveLength(5);
    expect(puffs(plate(container, 'k1'))).toEqual(puffs(plate(container, 'k2')));
    // Last in the lift group: a plate's first child is still that group.
    expect(plate(container, 'k1').firstElementChild!.lastElementChild!.hasAttribute('data-dust')).toBe(true);
    const roofs = Array.from(container.querySelectorAll('[data-roof]'));
    expect(roofs.map((r) => r.querySelectorAll('[data-dust] circle').length)).toEqual([3, 3, 3]);
    expect(container.querySelector('[data-ghost]')).not.toBeNull();
    expect(container.querySelector('[data-ghost] [data-dust]')).toBeNull();
    const bare = render(<HarvestGranary storeys={[]} />);
    expect(bare.container.querySelector('[data-dust]')).toBeNull();
  });

  it('the lamp that strikes is the bloom round each pane, the same for every coin, and its flare stays inside the wide bloom’s reach', () => {
    const { container } = render(<HarvestGranary storeys={storeys(['bayla', 'pepe'], ['claimed', 'claimed'])} />);
    const windows = Array.from(container.querySelectorAll('[data-window]'));
    expect(windows).toHaveLength(4);
    for (const w of windows) {
      const lamps = w.querySelectorAll(':scope > [data-lamp]');
      expect(lamps).toHaveLength(1);
      const blooms = Array.from(w.querySelectorAll(':scope > ellipse')).map((e) => Number(e.getAttribute('rx')));
      // The strike's largest scale, from index.css: the lamp at its peak never reaches past the widest bloom (no light on an unpaid storey).
      const peak = Math.max(...Array.from(blocksOf('@keyframes granary-strike').join('').matchAll(/scale\(([\d.]+)\)/g), (m) => Number(m[1])));
      expect(peak).toBeGreaterThan(1);
      expect(Number(lamps[0]!.getAttribute('rx')) * peak).toBeLessThanOrEqual(Math.max(...blooms));
    }
    // Each storey's second window strikes after its first, as it lights after it.
    expect(windows.map((w) => (w as SVGElement).style.getPropertyValue('--lamp'))).toEqual(['0ms', '120ms', '0ms', '120ms']);
  });

  it('the turn: only once the pointer rests, 2 degrees at most, on the element round the drawing and never on the drawing', () => {
    media('pointer: fine');
    stubObserver();
    const frame = stubFrames();
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...SMALL, x: 500, left: 500, width: 400, right: 900 });
    const { container } = render(<InCard list={storeys(S2)} />);
    // The pointer is listened to only while the drawing is on screen.
    see(1);
    const svg = container.querySelector('svg')!;
    const turn = container.querySelector<HTMLElement>('.hv-turn')!;
    const move = (on: Element, x: number, t: number) => {
      frame.at(t);
      act(() => {
        on.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x }));
      });
    };
    const skew = () => Number(/skewY\((-?[\d.]+)deg\)/.exec(turn.style.transform)?.[1] ?? 0);
    // The pointer crosses to the heading: while it moves, nothing turns.
    for (let t = 0; t <= 300; t += 30) {
      move(container.querySelector('[data-heading]')!, 340 - t, t);
      frame(t + 12);
      expect(turn.style.transform).toBe('');
    }
    // It rests: 80 ms on the model eases round to face it, the left rising; never past 2 degrees.
    const seen: number[] = [];
    for (let t = 400; t < 3000; t += 16) {
      frame(t);
      seen.push(skew());
    }
    expect(seen[0]).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(2);
    expect(seen[seen.length - 1]).toBeCloseTo(2, 2);
    // The pointer leaves the card: once it rests, the model eases back to none.
    move(document.body, 5, 3000);
    for (let t = 3016; t < 6000; t += 16) frame(t);
    expect(turn.style.transform).toBe('');
    expect(svg.style.transform).toBe('');
  });

  it('the pointer is listened to only while the drawing is on screen', () => {
    media('pointer: fine');
    stubObserver();
    stubFrames();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const moves = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'pointermove').length;
    render(<InCard list={storeys(THREE)} />);
    expect(moves(add)).toBe(0);
    see(1);
    expect(moves(add)).toBe(1);
    see(0.5);
    expect(moves(add)).toBe(1);
    see(0);
    expect(moves(remove)).toBe(1);
    see(1);
    expect(moves(add)).toBe(2);
  });

  it('when the page scrolls under a resting pointer, the card’s middle and span are measured again', () => {
    media('pointer: fine');
    stubObserver();
    const frame = stubFrames();
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...SMALL, x: 500, left: 500, width: 400, right: 900 });
    const { container } = render(<InCard list={storeys(S2)} />);
    see(1);
    const turn = container.querySelector<HTMLElement>('.hv-turn')!;
    const heading = container.querySelector('[data-heading]')!;
    const move = (x: number, t: number) => {
      frame.at(t);
      act(() => {
        heading.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x }));
      });
    };
    const skew = () => Number(/skewY\((-?[\d.]+)deg\)/.exec(turn.style.transform)?.[1] ?? 0);
    // In over the drawing's middle (700): it faces the pointer already.
    move(700, 0);
    for (let t = 100; t < 1500; t += 16) frame(t);
    expect(skew()).toBe(0);
    // The page scrolls: the drawing now stands 200 px further left, its middle at 500.
    rect.mockReturnValue({ ...SMALL, x: 300, left: 300, width: 400, right: 700 });
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    move(700, 1500);
    for (let t = 1600; t < 4000; t += 16) frame(t);
    // 200 px right of its middle, over 600 of span: a third of the way round, the right side rising.
    expect(skew()).toBeCloseTo(-0.667, 2);
  });

  it('the beat is written only while something hangs: a ready or waiting storey, or a roof still hung', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    media('pointer: fine');
    stubObserver();
    stubFrames();
    const beaten = (root: HTMLElement) => Array.from(root.querySelectorAll<SVGElement>('svg *')).filter((el) => el.style.getPropertyValue('--beat') !== '');
    // Every claim paid: each roof is on, nothing hangs.
    const done = render(<HarvestGranary storeys={storeys(['bayla', 'pepe'], ['claimed', 'claimed'])} />);
    see(1);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(done.container.querySelectorAll('[data-roof="kit"], [data-plate][data-state="ready"], [data-plate][data-state="waiting"]')).toHaveLength(0);
    expect(beaten(done.container)).toEqual([]);
    done.unmount();
    // A claim at the wallet: its roof still hangs, so the rigging runs.
    const live = render(<HarvestGranary storeys={storeys(['bayla', 'bayla'], ['claimed', 'sending'])} />);
    see(1);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect((live.container.querySelector('[data-roof="kit"]') as SVGElement).style.getPropertyValue('--beat')).toBe('1');
  });

  it('the beat: on a fine pointer, with the drawing on screen, each hung part takes --beat every 0.4 s; never the svg, never past 8 storeys, never off screen', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    media('pointer: fine');
    stubObserver();
    stubFrames();
    const beatOf = (el: Element) => (el as SVGElement).style.getPropertyValue('--beat');
    const seven = render(<HarvestGranary storeys={storeys(S2)} />);
    see(1);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const plates = Array.from(seven.container.querySelectorAll('[data-plate]'));
    expect(plates.map(beatOf)).toEqual(Array<string>(7).fill('1'));
    expect(Array.from(seven.container.querySelectorAll('[data-roof]')).map(beatOf)).toEqual(['1', '1', '1', '1']);
    expect(Array.from(seven.container.querySelectorAll('[data-guides] line')).every((l) => beatOf(l) === '1')).toBe(true);
    expect(beatOf(seven.container.querySelector('svg')!)).toBe('');
    // The lanes, the wallet and its plates never drift.
    expect(Array.from(seven.container.querySelectorAll('[data-lanes] *, [data-wallet], [data-wallet] *, [data-street] *')).filter((el) => beatOf(el) !== '')).toEqual([]);
    // Off screen the beat stops where it is.
    see(0);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(beatOf(plates[0]!)).toBe('1');
    seven.unmount();
    for (const [n, ratio] of [[9, 1], [7, 0]] as const) {
      const { container, unmount } = render(<HarvestGranary storeys={storeys(Array<Room>(n).fill('bayla'))} />);
      see(ratio);
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(Array.from(container.querySelectorAll('[data-plate]')).map(beatOf).filter(Boolean), `${n} at ${ratio}`).toEqual([]);
      unmount();
    }
  });

  it('once its figure is gone, a late report from its observer starts nothing: no beat, no timer, no frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    media('pointer: fine');
    stubObserver();
    const frame = stubFrames();
    const ask = vi.spyOn(globalThis, 'requestAnimationFrame');
    const { unmount } = render(<HarvestGranary storeys={storeys(THREE)} />);
    const late = watcher.tell!;
    unmount();
    ask.mockClear();
    act(() => {
      late([{ isIntersecting: true, intersectionRatio: 0.3 }]);
      late([{ isIntersecting: true, intersectionRatio: 1 }]);
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    frame(16);
  });

  it('the grid, the board, the kerb and each footing are named for the pen, each line ruled from a dash no shorter than itself', () => {
    const { container } = render(<HarvestGranary storeys={storeys([...Array<Room>(12).fill('bayla'), 'pepe', 'drb', 'jbm'])} />);
    const grid = container.querySelector<SVGGElement>('[data-grid]')!;
    const lines = Array.from(grid.querySelectorAll('line'));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.map((l) => l.style.getPropertyValue('--i'))).toEqual(lines.map((_, i) => String(i)));
    const lenOf = (el: Element) => Number((el as SVGElement).style.getPropertyValue('--len'));
    const span = (l: Element) => Math.hypot(Number(l.getAttribute('x2')) - Number(l.getAttribute('x1')), Number(l.getAttribute('y2')) - Number(l.getAttribute('y1')));
    expect(lenOf(grid)).toBeGreaterThanOrEqual(Math.max(...lines.map(span)));
    const perimeter = (el: Element) => {
      const p = (el.getAttribute('points') ?? '').trim().split(/\s+/).map((q) => q.split(',').map(Number));
      return p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]!; return sum + Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!); }, 0);
    };
    const inked = [container.querySelector('[data-site]')!, container.querySelector('[data-board]')!];
    // One footing a building, each under its room's ticker: BAYLA, PEPE, DRB and JBM.
    const rooms = Array.from(container.querySelectorAll('[data-tower] > [data-room]'));
    expect(rooms.map((r) => r.getAttribute('data-room'))).toEqual(['bayla', 'pepe', 'drb', 'jbm']);
    for (const room of rooms) {
      const footing = room.querySelectorAll('[data-footing]');
      expect(footing).toHaveLength(1);
      expect(footing[0]!.querySelectorAll(':scope > polygon')).toHaveLength(5);
      expect(footing[0]!.querySelector('[data-room-name]')).not.toBeNull();
      inked.push(...Array.from(footing[0]!.querySelectorAll(':scope > polygon[stroke]')));
    }
    expect(inked).toHaveLength(2 + 4 * 3);
    for (const el of inked) expect(lenOf(el)).toBeGreaterThanOrEqual(perimeter(el));
    // The street's lines: the kerb and a tick for each network.
    const street = Array.from(container.querySelectorAll('[data-street] line'));
    expect(street).toHaveLength(1 + 3);
    for (const l of street) expect(lenOf(l)).toBeGreaterThanOrEqual(span(l));
  });
});

/** index.css without its comments. */
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The bodies of every block opened by `head`, braces balanced. */
function blocksOf(head: string): string[] {
  const out: string[] = [];
  for (let at = CSS.indexOf(head); at >= 0; at = CSS.indexOf(head, at + 1)) {
    const open = CSS.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < CSS.length; i++) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}' && (depth -= 1) === 0) break;
    }
    out.push(CSS.slice(open + 1, i));
  }
  return out;
}
/** Every innermost rule: its selector list and its declarations. */
const RULES = Array.from(CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({ sel: m[1]!.trim(), body: m[2]! }));

describe("Harvest's figure: its motion in index.css", () => {
  it('turns with no transition and floats with no animation (each measured to repaint the drawing every frame)', () => {
    expect(CSS).not.toMatch(/@keyframes\s+granary-float\b/);
    expect(RULES.filter((r) => /\.hv-turn\b/.test(r.sel) && /transition/.test(r.body))).toEqual([]);
    // On touch the turn rides the scroll, the compositor's alone, where the browser has a view timeline.
    const touch = blocksOf('@media (prefers-reduced-motion: no-preference)').flatMap((b) => (b.includes('(hover: none), (pointer: coarse)') ? [b] : []));
    expect(touch.join('')).toMatch(/@supports \(animation-timeline: view\(\)\)\s*\{\s*\.hv-turn\s*\{[^}]*animation: granary-turn linear both;\s*animation-timeline: view\(\);/);
    // The float and the running guides: fine pointers only, from the beat the script writes.
    const fine = blocksOf('@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').join('');
    expect(fine).toMatch(/\[data-roof='kit'\]\s*\{\s*translate: 0 calc\(sin\(/);
    expect(fine).toMatch(/\[data-stack\]:has\(\[data-plate\]\[data-state='sending'\]\) \[data-guides\] line\s*\{\s*stroke-dashoffset/);
  });

  it('under reduced motion every motion stands at its end: no turn, no seat, thud, strike or dust, the flag unfurled and still', () => {
    const rm = blocksOf('@media (prefers-reduced-motion: reduce)').join('');
    expect(rm).toMatch(/\.hv-turn\s*\{\s*transform: none;\s*animation: none;/);
    expect(rm).toMatch(/\.granary \[data-plate\], \.granary \[data-roof\], \.granary \[data-stack\], \.granary \[data-lamp\]\s*\{\s*animation: none;/);
    expect(rm).toMatch(/\.granary-flag-unfurl\s*\{\s*animation: none;/);
    expect(rm).toMatch(/\.granary \[data-dust\]\s*\{\s*display: none;/);
  });

  it('on a phone the cloud breathes six times and holds; every flag flies three times and rests', () => {
    const touch = blocksOf('@media (hover: none), (pointer: coarse)').join('');
    expect(touch).toMatch(/\.hv-cloud\s*\{\s*animation: hv-cloud-draw 0\.7s ease-out both, harvest-breathe 1\.4s ease-in-out 0\.7s 6;/);
    const flag = RULES.filter((r) => r.sel === '.granary-flag-unfurl' && /granary-fly/.test(r.body));
    expect(flag.map((r) => /granary-fly 1\.5s ease-in-out 2\.1s (\w+)/.exec(r.body)?.[1])).toEqual(['3']);
  });

  it('while armed only the drawing, its title and its haze wait: never a row, the button or a word of the card', () => {
    const armed = RULES.filter((r) => r.sel.includes("data-intro='armed'"));
    expect(armed.length).toBeGreaterThanOrEqual(3);
    for (const r of armed) {
      for (const one of r.sel.split(/,(?![^(]*\))/)) expect(one.trim()).toMatch(/(\.granary\[data-intro='armed'\]|\.hv-vt|::before)$/);
    }
  });

  it('printed, the drawing stands finished: nothing moves or waits, the model straight', () => {
    const print = blocksOf('@media print').join('');
    expect(print).toMatch(/\.granary, \.granary \*[^{]*\{\s*animation: none !important;\s*transition: none !important;/);
    expect(print).toMatch(/\.granary\[data-intro\][^{]*\{\s*opacity: 1 !important;/);
    expect(print).toMatch(/\.hv-turn\s*\{\s*transform: none !important;/);
  });

  it('the city moves only once a claim is paid: one green run, one plate set down; the lane at the wallet stands still; under reduced motion all at their ends', () => {
    // No march: nothing moves along the lane of the claim at the wallet, on any screen.
    expect(CSS).not.toMatch(/city-march/);
    expect(RULES.filter((r) => /data-lane-march/.test(r.sel))).toEqual([]);
    expect(RULES.find((r) => r.sel === '.granary [data-lane-run]')?.body).toMatch(/stroke-dasharray: 1;\s*animation: city-run 700ms cubic-bezier\(0\.22, 1, 0\.36, 1\) 750ms both;/);
    expect(RULES.find((r) => r.sel === '.granary [data-landed]')?.body).toMatch(/animation: city-plate-in 380ms cubic-bezier\(0\.65, 0, 0\.35, 1\) 1450ms both;/);
    const rm = blocksOf('@media (prefers-reduced-motion: reduce)').join('');
    expect(rm).toMatch(/\.granary \[data-lane-run\], \.granary \[data-landed\]\s*\{\s*animation: none;/);
    expect(rm).toMatch(/\.granary \[data-lane-run\]\s*\{\s*stroke-dasharray: none;/);
    // Nothing of the city loops.
    expect(RULES.filter((r) => /city-/.test(r.body) && /infinite/.test(r.body)).map((r) => r.sel)).toEqual([]);
  });

  it('on a phone the brick at the wallet breathes as often as the cloud, then holds (the button’s class, as its own rule stands later)', () => {
    const touch = blocksOf('@media (hover: none), (pointer: coarse)').join('');
    const breaths = /\.hv-cloud\s*\{[^}]*harvest-breathe 1\.4s ease-in-out 0\.7s (\d+);/.exec(touch)?.[1];
    expect(breaths).toBe('6');
    expect(touch).toMatch(new RegExp(`\\.hv-cta \\.hv-course i\\[data-s='sending'\\]\\s*\\{\\s*animation-iteration-count: ${breaths};`));
  });

  it('first seen, the street’s kerb and the wallet are inked with the board, before the footings; the lanes come with the ground, before the kit', () => {
    const play = (part: string) => RULES.find((r) => r.sel === `.granary[data-intro='play'] ${part}`)?.body ?? '';
    const start = (body: string) => Number(/ (\d+)ms backwards/.exec(body)?.[1] ?? NaN);
    const footings = start(play('[data-tower] [data-footing] polygon'));
    expect(footings).toBe(170);
    expect(play('[data-street] line')).toMatch(/granary-rule/);
    expect(start(play('[data-street] line'))).toBeLessThan(footings);
    expect(start(play('[data-wallet]'))).toBeLessThan(footings);
    expect(start(play(':is([data-lanes], [data-lane-tags])'))).toBeLessThan(460);
    expect(start(play('[data-street] text'))).toBeLessThan(460);
  });

  it('the card caps its drawing: 20rem on a quiet card under 35rem and 22rem from 35rem; 36rem in the wide band', () => {
    expect(RULES.find((r) => r.sel === '.hv[data-quiet]' && /--fig-max/.test(r.body))?.body).toMatch(/--fig-max: 20rem;/);
    expect(blocksOf('@container harvest (width >= 35rem)').join('')).toMatch(/\.hv\[data-quiet\]\s*\{\s*--fig-max: 22rem;/);
    expect(blocksOf('@container harvest (width >= 55rem)').join('')).toMatch(/\.hv\s*\{[^}]*--fig-max: 36rem;/);
  });
});
