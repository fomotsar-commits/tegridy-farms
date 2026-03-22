import { useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ArtPiece } from '../../lib/artConfig';

interface ArtLightboxProps {
  pieces: ArtPiece[];
  selectedIndex: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

export function ArtLightbox({ pieces, selectedIndex, onClose, onNavigate }: ArtLightboxProps) {
  const isOpen = selectedIndex !== null;
  const piece = isOpen ? pieces[selectedIndex] : null;

  const handlePrev = useCallback(() => {
    if (selectedIndex !== null) onNavigate((selectedIndex - 1 + pieces.length) % pieces.length);
  }, [selectedIndex, pieces.length, onNavigate]);

  const handleNext = useCallback(() => {
    if (selectedIndex !== null) onNavigate((selectedIndex + 1) % pieces.length);
  }, [selectedIndex, pieces.length, onNavigate]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === 'ArrowRight') handleNext();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, handlePrev, handleNext]);

  return (
    <AnimatePresence>
      {isOpen && piece && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />

          <motion.div className="relative z-10 max-w-4xl w-full"
            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', damping: 25 }} onClick={(e) => e.stopPropagation()}>

            <div className="rounded-xl overflow-hidden">
              <img src={piece.src} alt={piece.title} className="w-full h-auto max-h-[70vh] object-contain bg-black" />
            </div>

            <div className="flex items-center justify-between mt-3 flex-wrap gap-3">
              <div>
                <p className="text-[15px] font-semibold text-white">{piece.title}</p>
                <p className="text-white/40 text-[12px]">{piece.description} · {selectedIndex! + 1} of {pieces.length}</p>
              </div>
              <div className="flex gap-1.5">
                <button onClick={handlePrev} className="px-3 py-1.5 rounded-lg text-[12px] text-white/70 cursor-pointer hover:text-white transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)' }}>← Prev</button>
                <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[12px] text-danger cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ background: 'rgba(255,255,255,0.05)' }}>Close</button>
                <button onClick={handleNext} className="px-3 py-1.5 rounded-lg text-[12px] text-white/70 cursor-pointer hover:text-white transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)' }}>Next →</button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
