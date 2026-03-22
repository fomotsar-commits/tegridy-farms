import { useState } from 'react';
import { motion } from 'framer-motion';
import { GALLERY_ORDER, ART } from '../lib/artConfig';
import { ArtLightbox } from '../components/ui/ArtLightbox';

export default function GalleryPage() {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.chaosScene.src} alt="" className="w-full h-full object-cover object-center" />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.45) 30%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.65) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">The Collection</h1>
          <p className="text-white/50 text-[14px]">{GALLERY_ORDER.length} original hand-drawn pieces from the Tegridy universe</p>
        </motion.div>

        <div className="columns-2 md:columns-3 gap-3 space-y-3">
          {GALLERY_ORDER.map((piece, i) => (
            <motion.button key={piece.src} onClick={() => setSelectedIndex(i)}
              className="w-full block relative group cursor-pointer break-inside-avoid rounded-xl overflow-hidden"
              style={{ border: '1px solid rgba(139,92,246,0.12)' }}
              initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }} transition={{ duration: 0.35, delay: (i % 3) * 0.06 }}>
              <img src={piece.src} alt={piece.title}
                className="w-full h-auto transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-all duration-300 flex items-end">
                <div className="w-full p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{ background: 'linear-gradient(to top, rgba(6,12,26,0.8) 0%, transparent 100%)' }}>
                  <p className="text-[12px] font-medium text-white/90">{piece.title}</p>
                  {piece.description && (
                    <p className="text-white/40 text-[11px] mt-0.5">{piece.description}</p>
                  )}
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      </div>

      <ArtLightbox pieces={GALLERY_ORDER} selectedIndex={selectedIndex}
        onClose={() => setSelectedIndex(null)} onNavigate={setSelectedIndex} />
    </div>
  );
}
