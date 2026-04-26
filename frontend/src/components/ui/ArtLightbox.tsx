import { useEffect, useCallback, useRef } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import type { ArtPiece } from '../../lib/artConfig';
// R041 + R072: lightbox image goes through the same safe-URL gate as the grid.
import { safeUrl, PLACEHOLDER_NFT } from '../../lib/imageSafety';

interface ArtLightboxProps {
  pieces: ArtPiece[];
  selectedIndex: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

export function ArtLightbox({ pieces, selectedIndex, onClose, onNavigate }: ArtLightboxProps) {
  const isOpen = selectedIndex !== null;
  const piece = isOpen ? pieces[selectedIndex] : null;
  const modalRef = useRef<HTMLDivElement>(null);
  const prevBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);

  const handlePrev = useCallback(() => {
    if (selectedIndex !== null) onNavigate((selectedIndex - 1 + pieces.length) % pieces.length);
  }, [selectedIndex, pieces.length, onNavigate]);

  const handleNext = useCallback(() => {
    if (selectedIndex !== null) onNavigate((selectedIndex + 1) % pieces.length);
  }, [selectedIndex, pieces.length, onNavigate]);

  // Body scroll lock
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  // Focus trap & keyboard handling
  useEffect(() => {
    if (!isOpen) return;

    // Move focus into modal on open
    requestAnimationFrame(() => modalRef.current?.focus());

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === 'ArrowRight') handleNext();

      // Focus trap on Tab
      if (e.key === 'Tab') {
        const focusable = [prevBtnRef.current, closeBtnRef.current, nextBtnRef.current].filter(Boolean) as HTMLElement[];
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, handlePrev, handleNext]);

  return (
    <AnimatePresence>
      {isOpen && piece && (
        <m.div
          role="dialog"
          aria-modal="true"
          aria-label={piece.title}
          tabIndex={-1}
          ref={modalRef}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 outline-none"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />

          <m.div className="relative z-10 max-w-4xl w-full"
            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', damping: 25 }} onClick={(e) => e.stopPropagation()}>

            <div className="rounded-xl overflow-hidden">
              <img
                src={safeUrl(piece.src) ?? PLACEHOLDER_NFT}
                alt={piece.title}
                width={1600}
                height={1600}
                decoding="async"
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = PLACEHOLDER_NFT; }}
                className="w-full h-auto max-h-[70vh] object-contain bg-black"
              />
            </div>

            <div className="flex items-center justify-between mt-3 flex-wrap gap-3">
              <div>
                <p className="text-[15px] font-semibold text-white">{piece.title}</p>
                <p className="text-white text-[12px]">{piece.description} · {selectedIndex! + 1} of {pieces.length}</p>
              </div>
              <div className="flex gap-1.5">
                <button ref={prevBtnRef} onClick={handlePrev} aria-label="Previous image"
                  className="min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-lg text-[12px] text-white cursor-pointer hover:text-white transition-colors flex items-center justify-center"
                  style={{ background: 'rgba(0,0,0,0.50)' }}>← Prev</button>
                <button ref={closeBtnRef} onClick={onClose} aria-label="Close lightbox"
                  className="min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-lg text-[12px] text-danger cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-center"
                  style={{ background: 'rgba(0,0,0,0.50)' }}>Close</button>
                <button ref={nextBtnRef} onClick={handleNext} aria-label="Next image"
                  className="min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-lg text-[12px] text-white cursor-pointer hover:text-white transition-colors flex items-center justify-center"
                  style={{ background: 'rgba(0,0,0,0.50)' }}>Next →</button>
              </div>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
