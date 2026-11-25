/**
 * scrollIntoView, for a move the page makes on its own: the answer to a press, or a read landing.
 * When the move shifts the screen, a tap on the spot of the last press, within HOLD_MS, is dropped
 * if it lands on something other than what that press pressed: it is the second half of a double
 * tap, and what is under that finger now is not what it was aimed at (a token picked, the address
 * box's keyboard opened). A tap that lands on what it pressed (a bar fixed to the screen, which no
 * move shifts), taps anywhere else, and keys still work. A mouse counts its own clicks, so only its
 * second click of a double click (detail 2) is dropped. A move made without scrollIntoView (a line
 * drawn above what was pressed, focus going back after a form closes) calls holdPress() itself.
 */
const HOLD_MS = 500; // a double tap's gap (300 ms on Android and iOS), then the second tap itself
// How far from the press a second tap is held. 30 px off is held (at 25 px it picked RIZZ, Fable
// read 2026-11-24); at 45 px the tokens a task press brings under the thumb, 39 and 44 px off,
// did not answer for half a second (Fable re-read, 2026-11-25).
const NEAR_PX = 30;

let press: { x: number; y: number; on: Element | null } = { x: NaN, y: NaN, on: null };
let held = { ...press, until: 0 };
let mouse = false; // the pointer that went down last

function drop(e: MouseEvent | TouchEvent) {
  if (performance.now() > held.until) return;
  if (mouse && 'detail' in e && e.detail < 2) return;
  const p = 'changedTouches' in e ? e.changedTouches[0] : e;
  // NaN (no finger yet, or a key pressed last) is near nothing.
  if (!p || !(Math.hypot(p.clientX - held.x, p.clientY - held.y) <= NEAR_PX)) return;
  // Still on what it pressed: nothing moved under this finger. A touch's events all go to what the
  // touch began on, so a finger that was down on a fixed bar while the page moved ends on the bar.
  if (e.target instanceof Node && held.on?.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    press = { x: e.clientX, y: e.clientY, on: e.target instanceof Element ? e.target : null };
    mouse = e.pointerType === 'mouse';
  }, { capture: true, passive: true });
  document.addEventListener('keydown', () => { press = { x: NaN, y: NaN, on: null }; }, { capture: true, passive: true });
  // touchend: a phone makes no click and no focus from it. mousedown: no focus. click: no press.
  for (const type of ['touchend', 'mousedown', 'click'] as const) document.addEventListener(type, drop, { capture: true, passive: false });
}

/** For half a second, a tap on the spot of the last press that lands on something else does nothing. */
export function holdPress(): void {
  held = { ...press, until: performance.now() + HOLD_MS };
}

export function bringIntoView(el: Element | null | undefined, how: ScrollIntoViewOptions): void {
  if (!el?.scrollIntoView) return;
  const top = el.getBoundingClientRect().top;
  el.scrollIntoView(how);
  if (Math.abs(el.getBoundingClientRect().top - top) >= 1) holdPress();
}
