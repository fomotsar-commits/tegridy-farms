/**
 * WAVE SEVEN, answer ten, ruling 2: WHAT A VISITOR TYPED BEFORE REACT ARRIVED.
 *
 * On a slow phone the static first frame is on screen for seconds, and its field
 * works: people paste an address into it. When React commits it replaces #root, and
 * again when the home page's chunk replaces the fallback, and each replacement
 * would throw the typed value away. A GET submit already survives that (it lands on
 * /?heat=<address>, which the hero reads); a value typed and NOT yet submitted
 * needs a hand across, and this is it.
 *
 * ONE VALUE, TAKEN ONCE. The hero reads it on mount and clears it, so a later visit
 * to `/` in the same session never resurrects an address from minutes ago. Capped
 * like the ?heat= param is, so nothing pathological reaches the input.
 */
let draft: string | null = null;

export function setFirstFrameDraft(value: string): void {
  const v = value.trim().slice(0, 64);
  draft = v === '' ? null : v;
}

/** The typed value, once; null when nothing was typed. */
export function takeFirstFrameDraft(): string | null {
  const v = draft;
  draft = null;
  return v;
}

/**
 * Called once from main.tsx, BEFORE createRoot replaces the static markup: read
 * whatever the visitor has already typed into index.html's own field.
 */
export function captureStaticFirstFrameDraft(doc: Document = document): void {
  const field = doc.querySelector<HTMLInputElement>('#first-frame input[name="heat"]');
  if (field && field.value) setFirstFrameDraft(field.value);
}
