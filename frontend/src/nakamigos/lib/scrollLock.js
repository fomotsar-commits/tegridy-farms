/**
 * Ref-counted body scroll lock.
 * Multiple components can lock/unlock independently without
 * clobbering each other's overflow state.
 */
let scrollLockCount = 0;

export function lockScroll() {
  scrollLockCount++;
  document.body.style.overflow = "hidden";
}

export function unlockScroll() {
  scrollLockCount--;
  if (scrollLockCount <= 0) {
    scrollLockCount = 0;
    document.body.style.overflow = "";
  }
}
