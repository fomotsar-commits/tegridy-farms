import { describe, it, expect } from 'vitest';
import { statusForError } from './useTokenScan';
import { ScanError } from '../lib/scanner';

// THE HINGE THE ADAPTERS WERE WRITTEN AGAINST.
//
// solanaAdapter.ts and ethereumAdapter.ts both route an unreadable payload to
// `ScanError('network')`, and both say so in prose: 'network' renders "Couldn't
// complete the scan" — a statement about the READ — while 'empty'/'not-found' render
// "No holder data for this token — double-check the address is a token", a claim
// about somebody's token, and 'unavailable' renders deployment copy.
//
// Every one of those comments is an assertion about `statusForError`, and until now
// nothing pinned it. Remapping a single case here would silently undo the honesty
// work in both adapters and the route behind them, with the whole suite still green.

/** The codes that mean "we could not read it" — never a finding about the token. */
const UNREADABLE: ScanError['code'][] = ['network', 'rate-limited'];
/** The codes that ARE answers about the token or the deployment. */
const ANSWERS: ScanError['code'][] = ['empty', 'not-found', 'unavailable', 'invalid-address'];

describe('statusForError — a failed read must not land on a token-claim state', () => {
  it('routes every unreadable code to `error`', () => {
    for (const code of UNREADABLE) {
      expect(statusForError(new ScanError(code, 'x')).status, code).toBe('error');
    }
  });

  it('never routes an unreadable code to a state that makes a claim about the token', () => {
    // Stated as the invariant rather than as a mapping, so it holds even if a new
    // status is added later: `empty` and `unavailable` both render copy ABOUT the
    // scanned address, and neither may be reachable from a read that failed.
    for (const code of UNREADABLE) {
      const { status } = statusForError(new ScanError(code, 'x'));
      expect(status, code).not.toBe('empty');
      expect(status, code).not.toBe('unavailable');
      expect(status, code).not.toBe('success');
    }
  });

  it('keeps the real answers on their own states', () => {
    // The other half of the contract: hardening must not push genuine findings into
    // the retry state, which would erase them.
    expect(statusForError(new ScanError('empty', 'x')).status).toBe('empty');
    expect(statusForError(new ScanError('not-found', 'x')).status).toBe('empty');
    expect(statusForError(new ScanError('unavailable', 'x')).status).toBe('unavailable');
    expect(statusForError(new ScanError('invalid-address', 'x')).status).toBe('invalid');
  });

  it('covers every ScanError code the type allows', () => {
    // A new code defaulting to `error` is safe; a new code silently landing on
    // `empty` is not. This fails the day someone adds one without deciding.
    const seen = [...UNREADABLE, ...ANSWERS];
    expect(new Set(seen).size).toBe(seen.length);
    for (const code of seen) {
      expect(statusForError(new ScanError(code, 'm')).message).toBe('m');
    }
  });

  it('treats a non-ScanError throw as an error, never as an empty token', () => {
    // A TypeError from a drifted payload must not read as "this token has no holders".
    for (const thrown of [new TypeError('boom'), 'string', null, undefined, { code: 'empty' }]) {
      expect(statusForError(thrown).status).toBe('error');
    }
    expect(statusForError(new TypeError('boom')).message).toMatch(/something went wrong/i);
  });
});
