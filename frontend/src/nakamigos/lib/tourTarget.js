// Where the first-visit tour points, and where its card sits.
//
// A tour step names its target by selector, and the same selector can match
// more than one element: the header's Gallery tab and the phone's bottom-bar
// Gallery tab both carry data-tour="gallery". On a phone the header's tab row
// is hidden, and the tour used to take the first match anyway, so it drew its
// spotlight round a box of no size at the top of the screen and pointed at
// nothing (it did before the 2026-11-14 redesign too).

const isRendered = (r) => r.width > 0 && r.height > 0;
const isWhollyInView = (r, vw, vh) => r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;

/**
 * The element a step should point at: the first match the visitor can see
 * whole, else the first match that is drawn at all, else null (the card then
 * sits in the middle of the screen). Selectors are tried in the order given.
 */
export function pickTourTarget(selectorGroup, { doc = document, vw = window.innerWidth, vh = window.innerHeight } = {}) {
  const candidates = [];
  for (const sel of selectorGroup.split(",")) {
    const s = sel.trim();
    if (!s) continue;
    for (const el of doc.querySelectorAll(s)) {
      if (!candidates.includes(el)) candidates.push(el);
    }
  }
  let firstRendered = null;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (!isRendered(r)) continue;
    if (isWhollyInView(r, vw, vh)) return el;
    if (!firstRendered) firstRendered = el;
  }
  return firstRendered;
}

/**
 * Where the card goes for a target's box. It goes on the side the step asks
 * for ("bottom" or "bottom-end" ask for below), and flips to the other side
 * when there is no room for it there, so a target near the foot of the screen
 * (the phone's bottom bar, the Keys button) is not covered by its own card.
 * `arrowLeft` keeps the card's pointer over the target's middle.
 */
export function placeTourCard(rect, position, { vw, vh, width = 320, height = 220, gap = 14, margin = 16 }) {
  const wantsBelow = !position.startsWith("top");
  const roomBelow = vh - rect.bottom - gap >= height + margin;
  const roomAbove = rect.top - gap >= height + margin;
  const below = wantsBelow ? (roomBelow || !roomAbove) : !roomAbove && roomBelow;

  let left = position === "bottom-end" ? rect.right - width : rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, vw - width - margin));

  const pos = { left };
  if (below) pos.top = Math.max(margin, Math.min(rect.bottom + gap, vh - height));
  else pos.bottom = Math.max(margin, Math.min(vh - rect.top + gap, vh - height));

  const centre = rect.left + rect.width / 2;
  const arrowLeft = Math.max(margin, Math.min(centre - left, width - margin));
  return { pos, side: below ? "bottom" : "top", arrowLeft };
}
