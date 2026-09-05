import { useEffect, useId, useRef, type ReactNode } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useTheme } from '../../contexts/ThemeContext';
import { artImgProps } from '../../lib/artSrcSet';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  /** Max width class — defaults to 'max-w-md' */
  maxWidth?: string;
  /**
   * R039: when false, clicks on the backdrop don't dismiss. Use for
   * onboarding / blocking dialogs that must be acknowledged. Default true.
   */
  dismissOnBackdrop?: boolean;
  /**
   * Optional decorative art src (e.g. ART.card01.src). When set, the dialog
   * renders it as a full-bleed background behind a readability scrim, so plain
   * confirmation/onboarding dialogs carry the same art-first feel as the rest of
   * the app. Purely cosmetic — content stays fully legible over the scrim.
   */
  art?: string;
}

// R039: discover focusable descendants for the Tab/Shift+Tab cycle. A simple
// querySelectorAll covers anchors, native buttons, inputs, selects, textareas,
// and any element with explicit `tabindex>=0`. Disabled controls and
// `tabindex="-1"` are skipped so they don't trap focus.
function getFocusableDescendants(root: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
  );
}

/**
 * Base modal component with standard backdrop, close-on-escape,
 * focus trap (Tab/Shift+Tab cycle), focus restoration on close, and body
 * scroll lock. Pass `dismissOnBackdrop={false}` to disable backdrop-click
 * dismissal for blocking dialogs (e.g. onboarding).
 */
export function Modal({
  open,
  onClose,
  children,
  title,
  maxWidth = 'max-w-md',
  dismissOnBackdrop = true,
  art,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // R039: remember the element that had focus when the modal opened so we
  // can return focus to it on close. Without this, screen-reader and
  // keyboard users get dumped at <body> after dismissing the dialog.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Audit H-F13: associate the title element with aria-labelledby rather than
  // using aria-label so screen readers announce the real heading (including
  // any inline styling/content like badges) and not a flattened string.
  const titleId = useId();
  const { isDark } = useTheme();

  // Lock body scroll when open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Close on Escape + R039: focus trap (Tab / Shift+Tab cycle within dialog).
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = getFocusableDescendants(dialogRef.current);
      if (focusables.length === 0) {
        // Trap focus on the dialog itself if nothing focusable inside.
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialogRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // R039: capture the previously-focused element when opening and restore
  // it when the modal closes. The dialog's first focusable child gets focus
  // on mount; if there are none, the dialog itself is focused (tabIndex=-1).
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    requestAnimationFrame(() => {
      if (!dialogRef.current) return;
      const focusables = getFocusableDescendants(dialogRef.current);
      if (focusables.length > 0) focusables[0]!.focus();
      else dialogRef.current.focus();
    });
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop. R039: opt-out for blocking dialogs via dismissOnBackdrop=false. */}
          <m.div
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={dismissOnBackdrop ? onClose : undefined}
          />
          {/* Dialog */}
          <div className="fixed inset-0 z-[101] flex items-center justify-center px-4 pointer-events-none">
            <m.div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              {...(title ? { 'aria-labelledby': titleId } : { 'aria-label': 'Dialog' })}
              tabIndex={-1}
              className={`relative w-full ${maxWidth} rounded-2xl border p-6 shadow-2xl pointer-events-auto outline-none ${art ? 'overflow-hidden' : ''}`}
              style={{
                // AUDIT THEME: was hardcoded rgba(13, 21, 48, 0.95) — light-mode
                // users saw a dark modal on a light page. Now branches off isDark
                // from ThemeContext. Opacity stays high so the backdrop scrim is
                // what sells the "modal-ness", not the card translucency.
                background: isDark ? 'rgba(13, 21, 48, 0.95)' : 'rgba(255, 250, 244, 0.97)',
                borderColor: 'var(--color-purple-20)',
                color: isDark ? undefined : '#1a1a1a',
              }}
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Optional decorative art background. The scrim is a MIDDLE-DARK
                  vertical gradient — light at top/bottom so the piece is clearly
                  visible, darker through the middle band where the title/body sit so
                  copy stays readable over even a BRIGHT piece (a flat light scrim
                  washed the text out; a flat dark one buried dark pieces). A small
                  brightness lift keeps muted pieces from blending into the panel, and
                  the text-shadow on the content below carries final legibility. */}
              {art && (
                <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                  <img
                    src={art}
                    {...artImgProps(art)}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                    style={{ filter: 'blur(1px) brightness(1.06) saturate(1.08)' }}
                  />
                  <div
                    className="absolute inset-0"
                    style={{
                      background: isDark
                        ? 'linear-gradient(180deg, rgba(11,18,42,0.34) 0%, rgba(11,18,42,0.62) 34%, rgba(11,18,42,0.62) 72%, rgba(11,18,42,0.34) 100%)'
                        : 'linear-gradient(180deg, rgba(255,250,244,0.5) 0%, rgba(255,250,244,0.72) 34%, rgba(255,250,244,0.72) 72%, rgba(255,250,244,0.5) 100%)',
                    }}
                  />
                </div>
              )}

              {/* Close button.
                  🔴 z-20, NOT z-10. The content wrapper below is also z-10 and
                  comes LATER in DOM order, so at equal z-index it painted on top
                  and its <h2> — a block element spanning the full width — covered
                  this button completely. Every titled dialog in the app had an
                  unclickable X: the click landed on the heading.
                  `pr-8` on that heading was the original attempt at clearance and
                  cannot work, because padding is still part of an element's hit
                  area. Reserving space visually is not the same as getting out of
                  the way, so the fix has to be the stacking order. */}
              <button
                onClick={onClose}
                className={`absolute top-3 right-3 z-20 transition-colors text-xl leading-none min-w-[44px] min-h-[44px] flex items-center justify-center ${
                  isDark
                    ? 'text-gray-400 hover:text-white'
                    : 'text-black/55 hover:text-black'
                }`}
                aria-label="Close dialog"
              >
                &times;
              </button>

              <div
                className="relative z-10"
                // text-shadow (inherited) carries legibility over the now-visible art,
                // so the scrim can stay light. Theme-aware: dark halo in dark mode,
                // light halo in light mode.
                style={
                  art
                    ? {
                        textShadow: isDark
                          ? '0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)'
                          : '0 1px 8px rgba(255,255,255,0.92), 0 0 3px rgba(255,255,255,0.85)',
                      }
                    : undefined
                }
              >
                {/* Title */}
                {title && (
                  <h2 id={titleId} className={`heading-luxury text-xl mb-4 pr-8 ${isDark ? 'text-white' : 'text-black'}`}>{title}</h2>
                )}

                {children}
              </div>
            </m.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
