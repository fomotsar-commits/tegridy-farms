/**
 * scrollIntoView, for a move the page makes on its own: the answer to a press, or a read landing.
 * When the move shifts the screen, a tap on the spot of the last press, within HOLD_MS, is dropped:
 * it is the second half of a double tap, and what is under that finger now is not what it was aimed
 * at (a token picked, the address box's keyboard opened). Taps anywhere else, and keys, still work.
 * A mouse counts its own clicks, so only its second click of a double click (detail 2) is dropped.
 */
const HOLD_MS = 500; // a double tap's gap (300 ms on Android and iOS), then the second tap itself
const NEAR_PX = 25; // the radius of Google's fast-button ghost-click buster

let press = { x: NaN, y: NaN };
let held = { x: NaN, y: NaN, until: 0 };
let mouse = false; // the pointer that went down last

function drop(e: MouseEvent | TouchEvent) {
  if (performance.now() > held.until) return;
  if (mouse && 'detail' in e && e.detail < 2) return;
  const p = 'changedTouches' in e ? e.changedTouches[0] : e;
  // NaN (no finger yet, or a key pressed last) is near nothing.
  if (!p || !(Math.abs(p.clientX - held.x) <= NEAR_PX && Math.abs(p.clientY - held.y) <= NEAR_PX)) return;
  e.preventDefault();
  e.stopPropagation();
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    press = { x: e.clientX, y: e.clientY };
    mouse = e.pointerType === 'mouse';
  }, { capture: true, passive: true });
  document.addEventListener('keydown', () => { press = { x: NaN, y: NaN }; }, { capture: true, passive: true });
  // touchend: a phone makes no click and no focus from it. mousedown: no focus. click: no press.
  for (const type of ['touchend', 'mousedown', 'click'] as const) document.addEventListener(type, drop, { capture: true, passive: false });
}

export function bringIntoView(el: Element | null | undefined, how: ScrollIntoViewOptions): void {
  if (!el?.scrollIntoView) return;
  const top = el.getBoundingClientRect().top;
  el.scrollIntoView(how);
  if (Math.abs(el.getBoundingClientRect().top - top) >= 1) held = { ...press, until: performance.now() + HOLD_MS };
}
