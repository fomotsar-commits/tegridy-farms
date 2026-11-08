import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';
import { CardArt } from '../components/ui/CardArt';

export default function CommunityPage() {
  usePageTitle('Community', 'Community chat and the gallery.');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="community" idx={0} fallbackPosition="center 10%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 page-column mx-auto px-4 md:px-6 pt-24 pb-16">
        {/* Header */}
        <m.div
          className="text-center mb-10"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl mb-2 tracking-tight">Community</h1>
          <p className="text-white max-w-md mx-auto text-[14px]">
            Community chat and the gallery.
          </p>
        </m.div>

        <m.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.4 }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl mx-auto">
            <Link to="/nakamigos" className="group relative isolate rounded-xl p-4 transition-colors hover:border-emerald-500/40" style={{ background: 'rgba(13,21,48,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <CardArt pageId="community" idx={7} />
              <div className="text-white font-semibold text-sm group-hover:text-emerald-300 transition-colors">Community chat →</div>
              <div className="text-white/60 text-xs mt-1 leading-relaxed">Live chat, P2P trades, and whale intel over in the Marketplace.</div>
            </Link>
            <Link to="/gallery" className="group relative isolate rounded-xl p-4 transition-colors hover:border-emerald-500/40" style={{ background: 'rgba(13,21,48,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <CardArt pageId="community" idx={8} />
              <div className="text-white font-semibold text-sm group-hover:text-emerald-300 transition-colors">Gallery →</div>
              <div className="text-white/60 text-xs mt-1 leading-relaxed">Browse the full art collection.</div>
            </Link>
          </div>
        </m.div>
      </div>
    </div>
  );
}
