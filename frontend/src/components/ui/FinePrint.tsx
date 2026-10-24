import type { ReactNode } from 'react';

/**
 * The small print, one press away.
 *
 * Owner, 2026-10-13: "use minimal words to get the point across and for any
 * disclaimers and things like such just have drop downs so the entire page
 * isnt crowded". So a page says what a thing does in a line, and how it works,
 * what it cannot read and every caveat sit in here, closed.
 *
 * A native <details>: no state, keyboard- and screen-reader-native, and the
 * text stays in the DOM, so find-in-page opens it and tests still read it.
 * The summary is the tap target, so it keeps 44px of height.
 */
export function FinePrint({
  summary = 'Details',
  children,
  className = '',
  testId,
}: {
  /** What the reader gets by opening it, in a word or three. */
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <details className={`group fine-print ${className}`} data-testid={testId}>
      <summary className="inline-flex min-h-[44px] cursor-pointer select-none list-none items-center gap-1.5 text-[12px] font-medium text-white/70 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-90"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span>{summary}</span>
      </summary>
      <div className="space-y-2 pb-2 text-[12px] leading-relaxed text-white/75">{children}</div>
    </details>
  );
}
