// Cost-basis methods, and why the choice is never made for the reader.
//
// FIFO and specific identification produce DIFFERENT NUMBERS from identical
// history — routinely a different sign on the same year. A report that does not
// name its method is not conservative or neutral; it is unusable, because
// nobody downstream can reproduce it or tell whether it matches what was filed
// last year. So the method is a required input everywhere in this directory, it
// is stamped on every export by lib/tax/csv.ts, and there is deliberately no
// default constant that a caller could fall into by omitting an argument.
//
// NOT TAX ADVICE. Which method a person is permitted to use, and whether they
// may change it between years, is a question about their jurisdiction and their
// prior filings. This module implements the arithmetic of each; it does not know
// which one is allowed to be applied to anyone.

export type CostBasisMethod = 'fifo' | 'lifo' | 'hifo' | 'spec-id';

export interface CostBasisMethodInfo {
  id: CostBasisMethod;
  /** Short label. Appears in the picker AND on the export header. */
  label: string;
  /** One sentence of what the matcher does. Never advice about choosing. */
  describes: string;
}

export const COST_BASIS_METHODS: readonly CostBasisMethodInfo[] = [
  {
    id: 'fifo',
    label: 'FIFO — first in, first out',
    describes: 'Each disposal consumes the oldest unsold lot of that asset first.',
  },
  {
    id: 'lifo',
    label: 'LIFO — last in, first out',
    describes: 'Each disposal consumes the newest unsold lot of that asset first.',
  },
  {
    id: 'hifo',
    label: 'HIFO — highest cost first',
    describes:
      'Each disposal consumes the unsold lot with the highest cost per unit first, ties broken by the older lot.',
  },
  {
    id: 'spec-id',
    label: 'Specific identification',
    describes:
      'Each disposal consumes the lots you nominated for it. A disposal with no nomination is left unmatched rather than being matched by a fallback rule.',
  },
] as const;

export function isCostBasisMethod(value: string): value is CostBasisMethod {
  return COST_BASIS_METHODS.some((m) => m.id === value);
}

export function methodInfo(method: CostBasisMethod): CostBasisMethodInfo {
  // Non-null: the type is closed and the table above covers it exhaustively,
  // which the test next to this file pins.
  return COST_BASIS_METHODS.find((m) => m.id === method)!;
}

/**
 * The sentence every export carries about its own method.
 *
 * Lives here rather than in the CSV writer so the picker and the export cannot
 * describe the same choice differently.
 */
export function methodStatement(method: CostBasisMethod): string {
  const info = methodInfo(method);
  return `Cost-basis method: ${info.label}. ${info.describes}`;
}

/**
 * The disclaimer, verbatim, on every surface and every export.
 *
 * One exported constant rather than a sentence retyped per component: a
 * disclaimer that drifts between the screen and the file is one a reader can
 * reasonably say they never saw.
 */
export const NOT_TAX_ADVICE =
  'This is not tax advice. These figures are generated from indexed on-chain history and are neither ' +
  'reviewed nor filed by anyone. Cost-basis rules, holding periods and reporting duties differ by ' +
  'jurisdiction and by your own prior filings. Check the output against your records and take advice ' +
  'from someone qualified before relying on any of it.';
