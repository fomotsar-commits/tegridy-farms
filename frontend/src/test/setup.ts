import '@testing-library/jest-dom';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import { afterAll } from 'vitest';

// Types the jest-dom matchers registered above for vitest 5, which reads them from
// Matchers<R, T> (R is what a matcher returns) and not from the global `jest` namespace that
// jest-dom 7.0.1 types. Not '@testing-library/jest-dom/vitest': its one-parameter Assertion<T>
// gets past skipLibCheck and makes every matcher return the element instead of void. Only R
// is named; T keeps vitest's own declaration and default. jestDomMatchers.test.ts holds this.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an interface merge adds members by extending; it has none of its own
  interface Matchers<R> extends TestingLibraryMatchers<unknown, R> {}
}

// A Solana wallet adapter looks for its extension once a second until it appears
// (wallet-adapter-base scopePollingDetectionStrategy), and jsdom never has one. Vitest deletes
// the window after a file's last hook; a tick after that throws "window is not defined", one
// unhandled error that fails the run with every test green. So every interval a file starts
// is stopped when the file ends. fileEndStopsIntervals.test.ts holds this.
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const startedInThisFile: ReturnType<typeof setInterval>[] = [];
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const id = nativeSetInterval(...args);
  startedInThisFile.push(id);
  return id;
}) as typeof setInterval;
afterAll(() => {
  for (const id of startedInThisFile) nativeClearInterval(id);
});
