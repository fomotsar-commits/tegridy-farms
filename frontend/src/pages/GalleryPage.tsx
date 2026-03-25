import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { GALLERY_ORDER, ART } from '../lib/artConfig';
import { ArtLightbox } from '../components/ui/ArtLightbox';

function useVotes() {
  const { address } = useAccount();
  const [votes, setVotes] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('tegridy_gallery_votes') || '{}'); } catch { return {}; }
  });
  const [userVotes, setUserVotes] = useState<Record<string, boolean>>(() => {
    if (!address) return {};
    try { return JSON.parse(localStorage.getItem(`tegridy_gallery_uv_${address}`) || '{}'); } catch { return {}; }
  });

  const vote = useCallback((src: string) => {
    if (!address) return;
    const alreadyVoted = userVotes[src];
    const newVotes = { ...votes, [src]: (votes[src] || 0) + (alreadyVoted ? -1 : 1) };
    const newUserVotes = { ...userVotes, [src]: !alreadyVoted };
    setVotes(newVotes);
    setUserVotes(newUserVotes);
    try {
      localStorage.setItem('tegridy_gallery_votes', JSON.stringify(newVotes));
      localStorage.setItem(`tegridy_gallery_uv_${address}`, JSON.stringify(newUserVotes));
    } catch {}
  }, [address, votes, userVotes]);

  return { votes, userVotes, vote };
}

export default function GalleryPage() {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { isConnected } = useAccount();
  const { votes, userVotes, vote } = useVotes();

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.roseApe.src} alt="" className="w-full h-full object-cover object-center" />
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
          {[...GALLERY_ORDER].sort((a, b) => (votes[b.src] || 0) - (votes[a.src] || 0)).map((piece, i) => (
            <motion.button key={piece.src} onClick={() => setSelectedIndex(i)}
              className="w-full block relative group cursor-pointer break-inside-avoid rounded-xl overflow-hidden card-hover"
              style={{ border: '1px solid rgba(139,92,246,0.12)' }}
              initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }} transition={{ duration: 0.35, delay: (i % 3) * 0.06 }}>
              <img src={piece.src} alt={piece.title}
                className="w-full h-auto transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-all duration-300 flex items-end">
                <div className="w-full p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{ background: 'linear-gradient(to top, rgba(6,12,26,0.8) 0%, transparent 100%)' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[12px] font-medium text-white/90">{piece.title}</p>
                      {piece.description && (
                        <p className="text-white/40 text-[11px] mt-0.5">{piece.description}</p>
                      )}
                    </div>
                    {isConnected && (
                      <button onClick={(e) => { e.stopPropagation(); vote(piece.src); }}
                        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${userVotes[piece.src] ? 'text-primary' : 'text-white/40'}`}
                        style={{ background: 'rgba(0,0,0,0.3)' }}>
                        ▲ {votes[piece.src] || 0}
                      </button>
                    )}
                  </div>
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
