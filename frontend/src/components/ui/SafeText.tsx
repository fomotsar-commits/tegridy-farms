// ─── R069 — SafeText ─────────────────────────────────────────────────
//
// Wrapper for rendering on-chain user-submitted strings. Two jobs:
//   1. Run the string through `sanitizeUserText` so BiDi overrides and
//      control chars are stripped at render time as defence-in-depth
//      (they should also have been stripped on write, but renders
//      consume strings that pre-date this change).
//   2. Cap visible length with an opt-in "show more / show less" toggle
//      so a 5KB pasted novel doesn't blow up a card layout.
//
// We never use `dangerouslySetInnerHTML` — React's text-node escaping
// already handles HTML / quote injection, and any "rich" formatting
// would require a heavyweight sanitiser (DOMPurify) we deliberately
// don't ship for plain community descriptions.

import { useState } from 'react';
import { sanitizeUserText, DEFAULT_DESCRIPTION_LIMIT } from '../../lib/textSafety';

interface SafeTextProps {
  value: string | null | undefined;
  /** Max characters displayed before "show more" appears. Default 240. */
  previewChars?: number;
  /** Hard cap applied during sanitisation. Default 1000. */
  maxLength?: number;
  className?: string;
}

export function SafeText({
  value,
  previewChars = 240,
  maxLength = DEFAULT_DESCRIPTION_LIMIT,
  className,
}: SafeTextProps) {
  const [expanded, setExpanded] = useState(false);
  const safe = sanitizeUserText(value, maxLength);
  const overflow = safe.length > previewChars;
  const display = !overflow || expanded ? safe : `${safe.slice(0, previewChars).trimEnd()}…`;

  return (
    <span className={className}>
      <span style={{ whiteSpace: 'pre-wrap' }}>{display}</span>
      {overflow && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="ml-1 text-emerald-400 hover:text-emerald-300 transition-colors text-[11px] font-semibold"
          aria-label={expanded ? 'Show less' : 'Show more'}
        >
          {expanded ? 'show less' : 'show more'}
        </button>
      )}
    </span>
  );
}
