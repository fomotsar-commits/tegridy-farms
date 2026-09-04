// Which slices of the requested period the history could NOT speak for.
//
// A tax report that quietly drops six weeks is worse than no report: the reader
// gets a plausible year with a hole in it and no reason to doubt any of it. So
// every stretch this venue could not read is computed here, carried onto the
// export itself by lib/tax/csv.ts, and rendered above the figures rather than
// beneath them.
//
// The gaps below are not hypothetical. Every one of them is a state the F1
// indexer is genuinely in on this deployment:
//
//   unavailable   VITE_INDEXER_URL is unset — the resting state of the venue,
//                 so the WHOLE period is a gap and the report is a header with
//                 no rows. That is the correct output, not a failure of it.
//   backfilling   the indexer answered while still replaying history. What came
//                 back is a prefix of the truth and the missing part is not at a
//                 known end, so the whole period is a gap.
//   truncated     the client caps a page at MAX_PAGE_LIMIT rows, newest first.
//                 Older rows exist and were not read, so everything before the
//                 oldest row we DID read is unread.
//   head lag      the indexer's synced head is behind the period end, so the
//                 tail of the period was never indexed by anyone.
//   pre-genesis   the indexer starts at a deploy block. Anything before it was
//                 never in scope and never will be.
//
// The union of these is deliberately NOT collapsed into one range. Two gaps with
// different reasons are two different facts about the report, and a reader
// deciding whether they can use it needs to know whether the hole is "the
// service was down" or "this venue has never held that history".

/**
 * The read states this module branches on.
 *
 * Declared here rather than imported from `hooks/useIndexedQuery`, and the
 * reason is a real constraint rather than taste: `hooksAreMounted.test.ts` holds
 * every `useIndexed*` hook to being unreachable from outside `src/hooks` while
 * the indexer is unhosted, and a lib importing one — even for a type — breaks
 * that guard. A lib depending on a hook module is the wrong direction anyway.
 *
 * It is NOT an unchecked copy. `useTaxReport` assigns an `IndexedStatus`
 * straight into `CoverageInput.status`, so if the hook's union ever gains a
 * state that is missing here, that assignment stops compiling — the parity is
 * enforced at the one seam where the two meet.
 */
export type CoverageReadStatus = 'idle' | 'loading' | 'ready' | 'backfilling' | 'unavailable';

/**
 * WHICH READ a gap is about.
 *
 * Coverage stopped being one read's business the moment the page grew a second
 * source: "the explorer could not be reached" and "no indexer is configured"
 * are different facts with different fixes, and a reader deciding whether the
 * file is usable needs to know which one they are looking at. Every gap carries
 * it and every export prints it.
 */
export type CoverageSource = 'explorer' | 'indexer';

export type GapReason =
  | 'not-read'
  | 'explorer-unavailable'
  | 'head-unavailable'
  | 'indexer-unavailable'
  | 'indexer-backfilling'
  | 'page-truncated'
  | 'after-sync-head'
  | 'before-indexed-range';

export interface CoverageGap {
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, inclusive. */
  to: number;
  source: CoverageSource;
  reason: GapReason;
  /** Plain language, written for whoever reads the CSV, not for a developer. */
  detail: string;
}

export interface CoverageInput {
  /** Unix seconds, the period the report claims to be about. */
  periodStart: number;
  periodEnd: number;
  /** Required: a gap that does not say which read produced it is half a fact. */
  source: CoverageSource;
  status: CoverageReadStatus;
  /** Head the indexer reported, or null when it reported none. */
  syncedAt: number | null;
  /** Timestamp of the oldest row actually read, or null when none came back. */
  oldestRowAt: number | null;
  /** True when rows exist past the page that was read. */
  truncated: boolean;
  /**
   * Earliest timestamp this indexer covers at all, when the deployment knows
   * it. Null is itself honest: an unknown start means the pre-genesis gap
   * cannot be stated, and `page-truncated` carries the older end instead.
   */
  indexedFrom: number | null;
}

export interface Coverage {
  gaps: CoverageGap[];
  /** True only when the whole requested period was read with nothing missing. */
  complete: boolean;
  /**
   * Seconds of the period that fall inside at least one gap. Reported so a
   * surface can say "41 of 365 days are not covered" instead of a bare flag.
   */
  gapSeconds: number;
}

function clamp(gap: CoverageGap, start: number, end: number): CoverageGap | null {
  const from = Math.max(gap.from, start);
  const to = Math.min(gap.to, end);
  if (to < from) return null;
  return { ...gap, from, to };
}

/**
 * Total seconds covered by the union of the gaps.
 *
 * The union matters: "the indexer was unavailable" and "the page was truncated"
 * routinely describe the same seconds, and adding them would report more missing
 * time than the period contains.
 */
function unionSeconds(gaps: CoverageGap[]): number {
  if (gaps.length === 0) return 0;
  const sorted = [...gaps].sort((a, b) => a.from - b.from);
  let total = 0;
  let curFrom = sorted[0]!.from;
  let curTo = sorted[0]!.to;
  for (const g of sorted.slice(1)) {
    if (g.from <= curTo + 1) {
      if (g.to > curTo) curTo = g.to;
    } else {
      total += curTo - curFrom + 1;
      curFrom = g.from;
      curTo = g.to;
    }
  }
  return total + curTo - curFrom + 1;
}

export function computeCoverage(input: CoverageInput): Coverage {
  const { periodStart, periodEnd, source } = input;
  const raw: CoverageGap[] = [];

  if (input.status === 'idle' || input.status === 'loading') {
    raw.push({
      from: periodStart,
      to: periodEnd,
      source,
      reason: 'not-read',
      detail:
        'No history has been read for this period yet, so nothing below is a statement about what happened in it.',
    });
  }

  if (input.status === 'unavailable') {
    raw.push(
      source === 'explorer'
        ? {
            from: periodStart,
            to: periodEnd,
            source,
            reason: 'explorer-unavailable',
            detail:
              'The explorer proxy answered without data, so nothing about this wallet was concluded and the ' +
              'entire period is uncovered. An empty report here means the read failed — it does not mean ' +
              'there were no transactions.',
          }
        : {
            from: periodStart,
            to: periodEnd,
            source,
            reason: 'indexer-unavailable',
            detail:
              'The indexed history could not be read at all, so the entire period is uncovered. An empty report ' +
              'here means the service could not answer — it does not mean there were no transactions.',
          },
    );
  }

  if (input.status === 'backfilling') {
    raw.push({
      from: periodStart,
      to: periodEnd,
      source,
      reason: 'indexer-backfilling',
      detail:
        'The indexer is still replaying history, so what came back is an incomplete prefix and the missing ' +
        'part is not at a known end of the period. Treat the whole period as uncovered until it has synced.',
    });
  }

  if (input.status === 'ready' || input.status === 'backfilling') {
    if (input.truncated && input.oldestRowAt !== null && input.oldestRowAt > periodStart) {
      raw.push({
        from: periodStart,
        to: input.oldestRowAt - 1,
        source,
        reason: 'page-truncated',
        detail:
          source === 'explorer'
            ? 'The read is bounded, and rows older than this point exist in at least one of the transaction ' +
              'lists and were not fully read — so this stretch was never looked at, and transactions in it ' +
              'are not classified even where some of their legs did come back.'
            : 'More rows exist before the oldest one that was read — the read is capped at one page, newest ' +
              'first — so this stretch was never looked at.',
      });
    }
    if (input.syncedAt !== null && input.syncedAt < periodEnd) {
      raw.push({
        from: input.syncedAt + 1,
        to: periodEnd,
        source,
        reason: 'after-sync-head',
        detail:
          source === 'explorer'
            ? 'The block this read was pinned to is older than the end of this period, so anything after it ' +
              'either had not happened yet or had not reached the explorer when the read was taken.'
            : 'The indexer had not reached the end of this period, so anything after its synced head is not ' +
              'indexed by anyone yet.',
      });
    }
    if (input.syncedAt === null) {
      raw.push({
        from: periodStart,
        to: periodEnd,
        source,
        reason: 'after-sync-head',
        detail:
          source === 'explorer'
            ? 'The chain head this read was taken against is unknown, so how much of this period it covers ' +
              'cannot be established.'
            : 'The indexer did not report how far it has synced, so how much of this period it actually holds ' +
              'cannot be established.',
      });
    }
    if (input.indexedFrom !== null && input.indexedFrom > periodStart) {
      raw.push({
        from: periodStart,
        to: input.indexedFrom - 1,
        source,
        reason: 'before-indexed-range',
        detail:
          'This venue’s indexer starts after this point and has never held history from before it. Nothing ' +
          'will ever fill this stretch from here — export it from wherever those transactions happened.',
      });
    }
  }

  const gaps = raw
    .map((g) => clamp(g, periodStart, periodEnd))
    .filter((g): g is CoverageGap => g !== null);

  return {
    gaps,
    complete: gaps.length === 0,
    gapSeconds: unionSeconds(gaps),
  };
}

/**
 * Coverage over SEVERAL reads.
 *
 * Gaps are concatenated rather than intersected: a period the explorer read and
 * the indexer did not is still a period one of this report's sources could not
 * speak for, and collapsing that would let one source quietly vouch for the
 * other. So `complete` needs EVERY enabled source complete, while `gapSeconds`
 * is the UNION — two sources failing over the same year must not report two
 * years missing.
 *
 * A source that is not enabled contributes nothing at all: it was not asked, so
 * it has no opinion. That is why useTaxReport omits the indexer entry entirely
 * when none is configured rather than passing it as `unavailable`, which would
 * bury every real finding under a permanent whole-period gap.
 */
export function computeCoverageUnion(inputs: CoverageInput[]): Coverage {
  const gaps = inputs.flatMap((i) => computeCoverage(i).gaps);
  return { gaps, complete: gaps.length === 0, gapSeconds: unionSeconds(gaps) };
}

/** One line per gap, in the wording that goes onto the export. */
export function gapLines(coverage: Coverage): string[] {
  if (coverage.complete) {
    return ['COVERAGE: no gaps were detected in the requested period.'];
  }
  return coverage.gaps.map(
    (g) =>
      `GAP ${new Date(g.from * 1000).toISOString()} → ${new Date(g.to * 1000).toISOString()} [${g.source}/${g.reason}] ${g.detail}`,
  );
}
