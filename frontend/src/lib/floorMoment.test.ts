// THE FLASH's pour (island answers thirty-two and thirty-four). The pour is what went in: the
// token's stream in the token's hue, and beside it the pool's pairing coin in its own color. A SOL
// pool pours Solana's green exactly as it always has; a USDC pool pours USDC's blue, and a pool
// paired with an island coin pours that coin's hue. jsdom has no canvas, so the engine is handed
// one that records every color it is asked to draw with.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hueOf, pourOf, startFloorMoment } from './floorMoment';

const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
const SOL_GREEN = '20,241,149';
const SOL_DEEP = '58,123,213';
const SOL_POINT = '90,230,200';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Plays the whole moment on a recording canvas and returns every color the engine drew with, in order. */
function play(pairing: string | null | undefined, symbol = 'BRAINLET', reduced = false): string[] {
  const colors: string[] = [];
  const gradient = { addColorStop: (_at: number, color: string) => void colors.push(color) };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => (prop === 'createLinearGradient' || prop === 'createRadialGradient' ? () => gradient : () => undefined),
    set: (_t, prop, value) => {
      if ((prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'shadowColor') && typeof value === 'string') colors.push(value);
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as unknown as HTMLCanvasElement['getContext']);
  let next: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    next = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    next = null;
  });
  const moment = startFloorMoment({
    head: document.createElement('canvas'),
    fx: document.createElement('canvas'),
    ring: document.createElement('div'),
    state: 'playing',
    wallet: WALLET,
    symbol,
    ...(pairing === undefined ? {} : { pairing }),
    lps: 9,
    reduced,
  });
  // Eight seconds at 25 frames a second: the pour, the bubble, the flash, the brick, the landing, the beats.
  for (let now = 0; now <= 8000 && next; now += 40) {
    const cb: FrameRequestCallback = next;
    next = null;
    cb(now);
  }
  moment.stop();
  return colors;
}
const drew = (colors: string[], rgb: string) => colors.some((c) => c.replace(/\s+/g, '').includes(rgb));

describe('the pairing coin’s color', () => {
  it('no pairing named, or SOL in any case: Solana’s green, its deep blue and its point, to the number', () => {
    const sol = { rgb: [20, 241, 149], mid: [90, 200, 230], heart: [220, 255, 245], deep: [58, 123, 213], pointMid: [90, 230, 200] };
    for (const pairing of [undefined, null, 'SOL', 'sol', 'Sol']) expect(pourOf(pairing), String(pairing)).toEqual(sol);
  });

  it('USDC and USDT pour their own colors; the deep is the same color at six tenths, the point its own mid and heart', () => {
    expect(pourOf('USDC')).toEqual({ rgb: [39, 117, 202], mid: [96, 165, 250], heart: [226, 240, 255], deep: [23, 70, 121], pointMid: [96, 165, 250] });
    expect(pourOf('usdc')).toEqual(pourOf('USDC'));
    expect(pourOf('USDT')).toEqual({ rgb: [38, 161, 123], mid: [80, 200, 160], heart: [225, 250, 240], deep: [23, 97, 74], pointMid: [80, 200, 160] });
  });

  it('any other pairing coin pours its own hue: a BAYLA pairing is Bayla’s green, a BRAINLET pairing BRAINLET’s', () => {
    for (const coin of ['BAYLA', 'BRAINLET', 'BOBO', 'SOY', 'RIZZ']) {
      const hue = hueOf(coin);
      expect(pourOf(coin), coin).toEqual({ rgb: hue.rgb, mid: hue.mid, heart: hue.heart, deep: hue.rgb.map((v) => Math.round(v * 0.6)), pointMid: hue.mid });
    }
    expect(pourOf('BAYLA').rgb).toEqual([130, 255, 120]);
  });
});

describe('the pour the engine draws', () => {
  it('a SOL pool, and an add that names no pairing coin: Solana’s green, drawn the same, color for color', () => {
    const named = play('SOL');
    const unnamed = play(undefined);
    expect(named.length).toBeGreaterThan(500);
    expect(unnamed).toEqual(named);
    for (const rgb of [SOL_GREEN, SOL_DEEP, SOL_POINT]) expect(drew(named, rgb), rgb).toBe(true);
    // The token's own stream is beside it, in the token's hue.
    expect(drew(named, hueOf('BRAINLET').rgb.join(','))).toBe(true);
  });

  it('a USDC pool pours USDC’s blue, and none of Solana’s green', () => {
    const colors = play('USDC');
    expect(drew(colors, '39,117,202')).toBe(true);
    expect(drew(colors, '23,70,121')).toBe(true);
    expect(drew(colors, '96,165,250')).toBe(true);
    for (const rgb of [SOL_GREEN, SOL_DEEP, SOL_POINT]) expect(drew(colors, rgb), rgb).toBe(false);
    expect(drew(colors, hueOf('BRAINLET').rgb.join(','))).toBe(true);
  });

  it('a pool paired with $BAYLA pours Bayla’s green beside the token’s hue', () => {
    const colors = play('BAYLA');
    expect(drew(colors, '130,255,120')).toBe(true);
    expect(drew(colors, SOL_GREEN)).toBe(false);
    expect(drew(colors, hueOf('BRAINLET').rgb.join(','))).toBe(true);
  });

  it('Reduce Motion on: the same colors, by its shorter path', () => {
    const colors = play('USDC', 'BRAINLET', true);
    expect(drew(colors, '39,117,202')).toBe(true);
    expect(drew(colors, SOL_GREEN)).toBe(false);
  });

  it('only the pairing coin’s side changes: everything else the engine draws is the SOL pool’s, color for color', () => {
    const swap = (c: string) => c.replace(/\s+/g, '');
    const sol = play('SOL').map(swap);
    const usdc = play('USDC').map(swap);
    expect(usdc).toHaveLength(sol.length);
    const differ = sol.map((c, i) => [c, usdc[i]!] as const).filter(([a, b]) => a !== b);
    expect(differ.length).toBeGreaterThan(0);
    // Every color that differs was one of SOL's three on the SOL pool, and is one of USDC's three here.
    for (const [a, b] of differ) {
      expect([SOL_GREEN, SOL_DEEP, SOL_POINT, '90,200,230', '220,255,245'].some((rgb) => a.includes(rgb)), a).toBe(true);
      expect(['39,117,202', '23,70,121', '96,165,250', '226,240,255'].some((rgb) => b.includes(rgb)), b).toBe(true);
    }
  });
});
