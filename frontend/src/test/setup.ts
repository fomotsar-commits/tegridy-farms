import '@testing-library/jest-dom';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

// The import above registers the jest-dom matchers for every test file. This
// types them for vitest 5, which jest-dom 7.0.1 does not do on its own: vitest 5
// reads custom matchers from Matchers<R, T> (R is what a matcher returns, T the
// value under test), and stopped reading the global `jest` namespace that
// jest-dom's main entry types. Do not import '@testing-library/jest-dom/vitest'
// instead: it declares a one-parameter Assertion<T>, which skipLibCheck lets
// through and which makes every matcher return the element instead of void.
// src/test/jestDomMatchers.test.ts holds this. Only R is named because only R
// is used; T keeps vitest's own declaration and default.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an interface merge adds members by extending; it has none of its own
  interface Matchers<R> extends TestingLibraryMatchers<unknown, R> {}
}
