/**
 * This document opened on /pools with the page's static frame painted (the build's
 * dist/pools/index.html, scripts/render-pools-frame.mjs), and the page has not replaced it yet.
 * Read once, when the app's first module runs: a later visit to /pools is a navigation, its
 * heading was never on screen, and it loads behind the skeleton as it always did.
 */
const opened =
  typeof document !== 'undefined' &&
  window.location.pathname.replace(/\/+$/, '') === '/pools' &&
  document.documentElement.getAttribute('data-first-frame') === 'venue';

let replaced = false;

export const poolsFrameOnScreen = (): boolean => opened && !replaced;

/** The page's own heading is drawn: from here /pools loads as any other page does. */
export const poolsFrameReplaced = (): void => {
  replaced = true;
};
