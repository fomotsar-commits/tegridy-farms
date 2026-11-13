// Text beside a mark that moves along an instrument (components/solana/range/RangeDrag.tsx,
// RangeStrip.tsx, components/nftfinance/FloorBar.tsx, LoanTimeline.tsx).
//
// Each label sits on its own side of its mark, as before. Near an edge of the picture it slides
// inward instead of running off it, and two labels that meet push apart, so a mark dragged all
// the way to an end still shows its whole label.

/** How wide monospace text is drawn, in the picture's own units. Most monospace faces give a
 *  character 0.6 of the font size; this errs a little wide, so a label never ends past an edge. */
export function monoWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.62;
}

export type MarkLabel = {
  /** Where the mark is, across the picture. */
  at: number;
  /** How wide the label is drawn (monoWidth). */
  width: number;
  /** Which side of its mark the label sits on when there is room. */
  side: 'left' | 'right';
};

/**
 * Where each label starts (its left edge, for textAnchor="start"), in the order given.
 * `gap` is the room a label keeps from its own mark and from the next label; `edge`, from the
 * picture's sides. Labels too wide to fit together keep their order and overlap the least.
 */
export function placeLabels(labels: MarkLabel[], span: number, gap = 4, edge = 4): number[] {
  const row = labels
    .map((l, i) => ({ i, width: l.width, left: l.side === 'left' ? l.at - gap - l.width : l.at + gap }))
    .sort((a, b) => a.left - b.left);
  // Left to right, each label stays on the picture and starts past the one before it...
  let after = -Infinity;
  for (const l of row) {
    l.left = Math.max(Math.min(Math.max(l.left, edge), span - edge - l.width), after);
    after = l.left + l.width + gap;
  }
  // ...and right to left, none runs past the right side: the one before moves over for it.
  let room = span - edge;
  for (const l of [...row].reverse()) {
    l.left = Math.min(l.left, room - l.width);
    room = l.left - gap;
  }
  const out: number[] = [];
  for (const l of row) out[l.i] = l.left;
  return out;
}

/**
 * Which side of its mark a label has room on: the preferred side if the whole label fits there,
 * else the other side, else whichever side has more room (placeLabels then slides it on).
 */
export function sideWithRoom(
  at: number,
  width: number,
  span: number,
  prefer: 'left' | 'right' = 'right',
  gap = 4,
  edge = 4,
): 'left' | 'right' {
  const room = { left: at - gap - edge, right: span - edge - gap - at };
  const other = prefer === 'right' ? 'left' : 'right';
  if (room[prefer] >= width) return prefer;
  if (room[other] >= width) return other;
  return room[prefer] >= room[other] ? prefer : other;
}

/**
 * Labels centred under their marks, for marks that may crowd (the loan timeline's reminder
 * ticks on a phone). Unlike placeLabels nothing slides: in the order given, a label that would
 * run off the picture or come within `gap` of one already shown (or of a `taken` stretch) is
 * left out. Returns each label's left edge, or null for one left out.
 */
export function fitCentred(
  labels: { at: number; width: number }[],
  span: number,
  taken: Array<[number, number]> = [],
  gap = 6,
  edge = 4,
): Array<number | null> {
  const shown = [...taken];
  return labels.map((l) => {
    const left = l.at - l.width / 2;
    const right = left + l.width;
    if (left < edge || right > span - edge) return null;
    if (shown.some(([a, b]) => left < b + gap && right > a - gap)) return null;
    shown.push([left, right]);
    return left;
  });
}
