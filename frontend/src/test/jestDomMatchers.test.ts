import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Assertion } from 'vitest';

/**
 * The jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...) as vitest 5
 * sees them: registered at runtime by src/test/setup.ts, and typed by the
 * declaration in that same file.
 *
 * Vitest 5 changed the shape matchers are typed against. Its Assertion now
 * takes two type parameters, R (what a matcher returns) and T (the value under
 * test), and custom matchers are added to its Matchers<R, T> interface. The
 * jest-dom 7.0.1 release only knows the old shapes: its main entry types the
 * global `jest` namespace, which vitest 5 no longer reads, and its
 * `/vitest` entry declares a one-parameter Assertion<T>, so its matchers
 * return the element instead of void. Neither reports an error (skipLibCheck
 * hides it), so the first sign is either every matcher missing or every
 * matcher quietly mistyped.
 *
 * The second test fails the type check (tsc -b) in both of those states and
 * passes only when the matchers are typed the way vitest 5 types its own.
 */
describe('jest-dom matchers under vitest 5', () => {
  it('are registered for every test file by the setup file', () => {
    const el = document.createElement('p');
    el.textContent = 'hello';
    document.body.append(el);
    try {
      expect(el).toBeInTheDocument();
      expect(el).toHaveTextContent('hello');
      expect(document.createElement('div')).not.toBeInTheDocument();
    } finally {
      el.remove();
    }
  });

  it('return what a vitest 5 matcher returns: void, or a promise of void after resolves/rejects', () => {
    type Sync = Assertion<void, HTMLElement>;
    type Async = Assertion<Promise<void>, HTMLElement>;
    expectTypeOf<ReturnType<Sync['toBeInTheDocument']>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<Sync['not']['toHaveTextContent']>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<Async['toHaveAttribute']>>().toEqualTypeOf<Promise<void>>();
  });
});
