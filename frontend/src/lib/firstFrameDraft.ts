/**
 * WAVE SEVEN, answer ten, ruling 2: WHAT A VISITOR TYPED BEFORE REACT ARRIVED.
 *
 * On a slow phone the static first frame is on screen for seconds, and its field
 * works: people paste an address into it. When React commits it replaces #root, and
 * again when the home page's chunk replaces the fallback, and each replacement
 * would throw the typed value away, and the focus with it. A GET submit already
 * survives that (it lands on /?heat=<address>, which the hero reads); a value typed
 * and NOT yet submitted needs a hand across, and this is it.
 *
 * READ DURING RENDER, CLEARED AFTER COMMIT. This used to be taken (read and cleared)
 * inside the hero's useState initializer, and in a production build the handoff never
 * once worked: the home page's first render suspends, React throws that render away
 * with its state, and the retry's initializer found the value already gone. So a
 * render only ever PEEKS, which is safe to repeat, and the hero clears it from an
 * effect, which runs once and only for a render that reached the screen.
 *
 * NEVER RESURRECTED. The fallback clears it when the visitor leaves `/` before the
 * hero mounts, so a later visit in the same session does not come back to an address
 * from minutes ago. Capped like the ?heat= param is, so nothing pathological reaches
 * the input.
 */
export interface FirstFrameDraft {
  /** What is in the field, trimmed and capped; null when it is empty. */
  value: string | null;
  /** Whether the field had focus, so the next field can take it back. */
  focused: boolean;
}

let draft: FirstFrameDraft = { value: null, focused: false };

export function setFirstFrameDraft(value: string): void {
  const v = value.trim().slice(0, 64);
  draft = { ...draft, value: v === '' ? null : v };
}

export function setFirstFrameFocus(focused: boolean): void {
  draft = { ...draft, focused };
}

/**
 * A blur handler for a field that React may be about to remove. Chromium fires blur
 * on a focused node as it is removed, while it is still connected, so at event time a
 * swap is indistinguishable from the visitor tapping away. The check waits one
 * microtask: React's commit, including the next field's layout effect that reads this
 * store, finishes first, and by then a swapped-out field is disconnected.
 */
export function blurFirstFrameField(field: Element): void {
  queueMicrotask(() => {
    if (field.isConnected) setFirstFrameFocus(false);
  });
}

/** The current draft; safe to call from render, any number of times. */
export function peekFirstFrameDraft(): FirstFrameDraft {
  return draft;
}

export function clearFirstFrameDraft(): void {
  draft = { value: null, focused: false };
}

/**
 * Called once from main.tsx, BEFORE createRoot replaces the static markup. React's
 * commit is scheduled, not immediate, so a single read here would miss whatever is
 * typed in between: the field is followed until it is gone.
 */
export function captureStaticFirstFrameDraft(doc: Document = document): void {
  const field = doc.querySelector<HTMLInputElement>('#first-frame input[name="heat"]');
  if (!field) return;
  setFirstFrameDraft(field.value);
  setFirstFrameFocus(doc.activeElement === field);
  field.addEventListener('input', () => setFirstFrameDraft(field.value));
  field.addEventListener('focus', () => setFirstFrameFocus(true));
  field.addEventListener('blur', () => blurFirstFrameField(field));
}
