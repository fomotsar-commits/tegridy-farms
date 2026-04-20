import { useEffect, useId, useRef, type ReactNode } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useTheme } from '../../contexts/ThemeContext';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  /** Max width class — defaults to 'max-w-md' */
  maxWidth?: string;
}

/**
 * Base modal component with standard backdrop, close-on-escape,
 * focus trap (basic), and body scroll lock.
 */
export function Modal({ open, onClose, children, title, maxWidth = 'max-w-md' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
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

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Auto-focus the dialog when opened
  useEffect(() => {
    if (open && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <m.div
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          {/* Dialog */}
          <div className="fixed inset-0 z-[101] flex items-center justify-center px-4 pointer-events-none">
            <m.div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              {...(title ? { 'aria-labelledby': titleId } : { 'aria-label': 'Dialog' })}
              tabIndex={-1}
              className={`relative w-full ${maxWidth} rounded-2xl border p-6 shadow-2xl pointer-events-auto outline-none`}
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
              {/* Close button */}
              <button
                onClick={onClose}
                className={`absolute top-3 right-3 transition-colors text-xl leading-none min-w-[44px] min-h-[44px] flex items-center justify-center ${
                  isDark
                    ? 'text-gray-400 hover:text-white'
                    : 'text-black/55 hover:text-black'
                }`}
                aria-label="Close dialog"
              >
                &times;
              </button>

              {/* Title */}
              {title && (
                <h2 id={titleId} className={`heading-luxury text-xl mb-4 pr-8 ${isDark ? 'text-white' : 'text-black'}`}>{title}</h2>
              )}

              {children}
            </m.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
