import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { bringIntoView } from './bringIntoView';

let now = 1000;
let top = 400;
let target: HTMLElement;
let pressed: Mock<(e: Event) => void>;
const finger = { clientX: 75, clientY: 439 };

/** A press at `at` that moves `target` up the screen by `by` px, as a phone's jump does. */
function pressThatMoves(at = finger, by = 255, pointerType = 'touch') {
  document.body.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType, bubbles: true }));
  target.scrollIntoView = () => { top -= by; };
  bringIntoView(target, { block: 'nearest' });
}
/** A tap (its pointerdown, then `type`) on the button now under the finger: whether it was pressed. */
function tapAt(at = finger, type: 'click' | 'mousedown' = 'click', pointerType = 'touch', detail = 1) {
  const button = document.querySelector('button')!;
  button.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType, bubbles: true }));
  const e = new MouseEvent(type, { ...at, bubbles: true, cancelable: true, detail });
  button.dispatchEvent(e);
  return { pressed: pressed.mock.calls.length > 0, blocked: e.defaultPrevented };
}

beforeEach(() => {
  now += 10_000;
  top = 400;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  document.body.innerHTML = '<div id="t"></div><button type="button">RIZZ</button>';
  target = document.getElementById('t')!;
  target.getBoundingClientRect = () => new DOMRect(0, top, 100, 48);
  pressed = vi.fn<(e: Event) => void>();
  document.querySelector('button')!.addEventListener('click', pressed);
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
    document.querySelector('button')!.dispatchEvent(touch);
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
});

// A new move on the Pools page that calls scrollIntoView itself would bring the double tap back.
it('every move the Pools page makes goes through bringIntoView', () => {
  const src = path.resolve(__dirname, '..');
  const lp = path.join(src, 'components/solana/lp');
  const files = [...readdirSync(lp).filter((f) => f.endsWith('.tsx') && !f.includes('.test.')).map((f) => path.join(lp, f)), path.join(src, 'pages/PoolsPage.tsx')];
  const raw = files.filter((f) => /\.scrollIntoView\b/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(src, f));
  expect(raw).toEqual([]);
});
