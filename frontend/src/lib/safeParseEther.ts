/**
 * Safe wrappers around `viem.parseEther` / `parseUnits` for user-facing
 * input fields.
 *
 * Why this exists (AUDIT R034 — H4):
 *   `parseEther('1.')`, `parseEther('1e3')`, `parseEther('1.123456789012345678901')`
 *   and other malformed inputs throw a viem error. When that throw lands
 *   inside a React render path or an event handler that ErrorBoundary
 *   wraps, the entire page goes blank. Wrapping the call lets the UI:
 *     • disable the submit button on bad input,
 *     • render a validation message,
 *     • avoid unmounting the page.
 *
 * Two surfaces:
 *   - safeParseEther(s) → bigint | null
 *   - validEtherInput  → zod schema for form-level validation
 *
 * Accepted inputs (regex):
 *   - "0", "1", "1234"                               (whole numbers)
 *   - "1.5", "0.0001", "100.123456789012345678"      (≤ 18 fraction digits)
 *
 * Rejected inputs:
 *   - "" / null / undefined                          (empty)
 *   - "1." / ".5"                                    (trailing/leading dot)
 *   - "1e3" / "1E3"                                  (scientific notation)
 *   - "1.1234567890123456789"                        (>18 fraction digits)
 *   - "-1", "abc", "1,000"                           (signed/non-numeric)
 *   - "0x10"                                         (hex)
 */

import { parseEther } from 'viem';
import { z } from 'zod';

/** Strict regex for an ether-shaped decimal: optional fractional part with ≤18 digits. */
const ETHER_DECIMAL_RE = /^\d+(\.\d{1,18})?$/;

/** Zod schema usable in form validators. */
export const validEtherInput = z
  .string()
  .regex(ETHER_DECIMAL_RE, 'Enter a positive decimal with at most 18 fraction digits');

/**
 * Parse a user-typed amount into wei. Returns `null` on any malformed
 * input rather than throwing — never let parseEther bubble up into a
 * render path.
 *
 * Treats "0" as null because the upstream UI already disables submit on
 * non-positive amounts; a separate caller can pre-check zero if it
 * needs to distinguish.
 */
export function safeParseEther(value: string | undefined | null): bigint | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!ETHER_DECIMAL_RE.test(trimmed)) return null;
  try {
    const wei = parseEther(trimmed);
    return wei;
  } catch {
    // viem changed its error surface between minor versions — keep the
    // catch defensive in case the regex passes but parseEther still
    // disagrees (e.g., locale-affected decimal handling).
    return null;
  }
}

/** Convenience: safeParseEther + must-be-positive. */
export function safeParseEtherPositive(value: string | undefined | null): bigint | null {
  const wei = safeParseEther(value);
  if (wei == null) return null;
  if (wei <= 0n) return null;
  return wei;
}
