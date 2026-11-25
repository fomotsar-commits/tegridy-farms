import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { bringIntoView, holdPress } from './bringIntoView';

let now = 1000;
let top = 400;
let target: HTMLElement;
let pressed: Mock<(e: Event) => void>;
const finger = { clientX: 75, clientY: 439 };
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;

/** A press at `at` on `on` that moves `target` up the screen by `by` px, as a phone's jump does. */
function pressThatMoves(at = finger, by = 255, pointerType = 'touch', on = 'Open a pool') {
  button(on).dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType, bubbles: true }));
  target.scrollIntoView = () => { top -= by; };
  bringIntoView(target, { block: 'nearest' });
}
/** A tap (its pointerdown, then `type`) on the button `on`, now under the finger: whether it was pressed. */
function tapAt(at = finger, type: 'click' | 'mousedown' = 'click', pointerType = 'touch', detail = 1, on = 'RIZZ') {
  pressed.mockClear();
  button(on).dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType, bubbles: true }));
  const e = new MouseEvent(type, { ...at, bubbles: true, cancelable: true, detail });
  button(on).dispatchEvent(e);
  return { pressed: pressed.mock.calls.length > 0, blocked: e.defaultPrevented };
}

beforeEach(() => {
  now += 10_000;
  top = 400;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  document.body.innerHTML = '<button type="button">Open a pool</button><div id="t"></div><button type="button">BOBO</button><button type="button">RIZZ</button><button type="button">Close</button><nav style="position: fixed; bottom: 0"><button type="button">Earn</button></nav>';
  target = document.getElementById('t')!;
  target.getBoundingClientRect = () => new DOMRect(0, top, 100, 48);
  pressed = vi.fn<(e: Event) => void>();
  for (const b of document.querySelectorAll('button')) b.addEventListener('click', pressed);
});
afterEach(() => vi.restoreAllMocks());

describe('a move the page makes holds a second tap on the same spot', () => {
  it('the second tap of a double tap presses nothing; a tap anywhere else does', () => {
    pressThatMoves();
    now += 300;
    expect(tapAt({ clientX: 80, clientY: 445 })).toEqual({ pressed: false, blocked: true });
    expect(tapAt({ clientX: 176, clientY: 377 })).toEqual({ pressed: true, blocked: false });
  });

  it('no focus from the finger either (the address box would open a keyboard), and no click from a touch', () => {
    pressThatMoves();
    expect(tapAt(finger, 'mousedown').blocked).toBe(true);
    const touch = new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [{ clientX: 75, clientY: 439 } as Touch] });
    button('RIZZ').dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(true);
  });

  // e2e-solana's press() puts every target in the middle of the screen and clicks it with a mouse,
  // so two presses in a row land on one spot: held, a press after a move did nothing (#1301's CI).
  it('a mouse is held only on a double click: one fast click on the same spot still presses', () => {
    pressThatMoves(finger, 255, 'mouse');
    expect(tapAt(finger, 'mousedown', 'mouse', 1).blocked).toBe(false);
    expect(tapAt(finger, 'click', 'mouse', 1)).toEqual({ pressed: true, blocked: false });
    expect(tapAt(finger, 'mousedown', 'mouse', 2).blocked).toBe(true);
    expect(tapAt(finger, 'click', 'mouse', 2).blocked).toBe(true);
  });

  it('only for half a second: after that the same spot presses what is under it', () => {
    pressThatMoves();
    now += 501;
    expect(tapAt()).toEqual({ pressed: true, blocked: false });
  });

  it('a move that shifts nothing on the screen holds nothing', () => {
    pressThatMoves(finger, 0);
    expect(tapAt()).toEqual({ pressed: true, blocked: false });
  });

  it('a key press holds nothing: there is no finger on the screen', () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { ...finger, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    target.scrollIntoView = () => { top -= 255; };
    bringIntoView(target, { block: 'start' });
    expect(tapAt()).toEqual({ pressed: true, blocked: false });
  });

  // At 25 px a second tap 30 px off picked RIZZ at 430 and opened the keyboard at 390 (Fable read,
  // 2026-11-24). At 45 px a tap on the token next over did nothing: SOY 39 px off after Add
  // liquidity, BAYLA 44 px off after Open a pool, at 430x740 (Fable re-read, 2026-11-25).
  it('as far as a double tap spreads, no further: 30 px off is held, a token 39 px off is not', () => {
    pressThatMoves();
    expect(tapAt({ clientX: 75 + 30, clientY: 439 }).blocked).toBe(true);
    expect(tapAt({ clientX: 75 + 20, clientY: 439 + 20 }).blocked).toBe(true);
    expect(tapAt({ clientX: 75, clientY: 439 + 39 })).toEqual({ pressed: true, blocked: false });
    expect(tapAt({ clientX: 75 + 22, clientY: 439 + 22 })).toEqual({ pressed: true, blocked: false });
  });

  // A finger down on the bottom bar while a read landed and moved the page: its tap did nothing,
  // about one in ten to twenty times (Fable read, 2026-11-24). The bar does not move with the page.
  it('a tap that lands on what it pressed is not held: a bar fixed to the screen', () => {
    pressThatMoves(finger, 255, 'touch', 'Earn');
    expect(tapAt(finger, 'click', 'touch', 1, 'Earn')).toEqual({ pressed: true, blocked: false });
    const touch = new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [{ ...finger } as Touch] });
    button('Earn').dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
  });
});

describe('holdPress: a move made without scrollIntoView', () => {
  // A pick draws "Open a pool and Add liquidity act on the token in the box below." above the
  // tokens, one row tall: in WebKit a double tap on RIZZ then picked BOBO (Fable read, 2026-11-24).
  it('a line drawn above what was pressed: the second tap does not press what slid under the finger', () => {
    button('RIZZ').dispatchEvent(new PointerEvent('pointerdown', { ...finger, pointerType: 'touch', bubbles: true }));
    holdPress();
    expect(tapAt(finger, 'click', 'touch', 1, 'BOBO')).toEqual({ pressed: false, blocked: true });
    expect(tapAt(finger, 'click', 'touch', 1, 'RIZZ')).toEqual({ pressed: true, blocked: false });
  });

  // Close puts focus back on the form's opener, and the page jumps to it: a double tap on Close
  // opened the form again (Fable read, 2026-11-24).
  it('a press whose button is gone: the second tap does not press what is there now', () => {
    const close = button('Close');
    close.dispatchEvent(new PointerEvent('pointerdown', { ...finger, pointerType: 'touch', bubbles: true }));
    holdPress();
    close.remove();
    expect(tapAt(finger, 'click', 'touch', 1, 'Open a pool')).toEqual({ pressed: false, blocked: true });
    now += 501;
    expect(tapAt(finger, 'click', 'touch', 1, 'Open a pool')).toEqual({ pressed: true, blocked: false });
  });
});

// A new move on the Pools page that calls scrollIntoView itself would bring the double tap back.
it('every move the Pools page makes goes through bringIntoView', () => {
  const src = path.resolve(__dirname, '..');
  const lp = path.join(src, 'components/solana/lp');
  const files = [...readdirSync(lp).filter((f) => f.endsWith('.tsx') && !f.includes('.test.')).map((f) => path.join(lp, f)), path.join(src, 'pages/PoolsPage.tsx')];
  const raw = files.filter((f) => /\.scrollIntoView\b/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(src, f));
  expect(raw).toEqual([]);
});
