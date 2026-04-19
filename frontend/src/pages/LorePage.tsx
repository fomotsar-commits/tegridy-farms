import { m } from 'framer-motion';
import { pageArt } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';

const TIMELINE = [
  {
    phase: '01',
    title: 'The Rug',
    description: 'It started with LBAC — a project that promised the world and delivered nothing. The team vanished. The community was left holding the bag. Most would have walked away.',
  },
  {
    phase: '02',
    title: 'Lord of the Flies',
    description: 'But this community was different. Like survivors on a deserted island, they organized. No leaders, no roadmap — just a group of degens who refused to quit. They called it the Lord of the Flies moment.',
  },
  {
    phase: '03',
    title: 'The DAO',
    description: 'From the wreckage, a DAO was born. Community-funded treasury. NFT-gated governance. Every decision made by the holders, for the holders. The blueprint for building in uncharted waters.',
  },
  {
    phase: '04',
    title: 'The Art',
    description: '5,555 apes. Each one customizable. Created not by a single artist but by the collective itself. Art that represents the spirit of survival, creativity, and pure degen energy.',
  },
  {
    phase: '05',
    title: 'Memetic Finance',
    description: 'DM+T = Memetic Finance. Dank Memes plus Time equals real value. The community discovered that memes aren\'t just content — they\'re a form of currency, culture, and coordination.',
  },
  {
    phase: '06',
    title: 'Tegridy Farms',
    description: 'Built by the community, for the community. A DeFi platform where 100% of protocol revenue goes to stakers. No VC money. No insider allocations. Just pure, unadulterated TEGRIDY.',
  },
  {
    phase: '07',
    title: 'The Future',
    description: 'Seize the memes of production. Vote-escrow tokenomics. Cross-chain expansion. NFT utility. The farm is just the beginning. FAFO.',
  },
];

export default function LorePage() {
  usePageTitle('Lore', 'The origin story of Tegridy Farms and the TOWELI token.');
  return (
    <div className="-mt-14 relative min-h-screen">
      {/* Fixed background covering entire page */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={pageArt('lore', 0).src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 32%' }} />
      </div>

      {/* Hero */}
      <div className="relative z-10 h-[60vh] min-h-[400px] flex items-center justify-center">
        <m.div className="text-center px-6" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-white text-[12px] uppercase tracking-[0.2em] mb-3">The Origin Story</p>
          <h1 className="heading-luxury text-3xl md:text-4xl lg:text-6xl text-white tracking-tight mb-4">
            From Rug to Riches
          </h1>
          <p className="text-white text-base max-w-lg mx-auto">
            How a community of degens rose from the ashes of a failed project to build something with real TEGRIDY.
          </p>
        </m.div>
      </div>

      {/* Timeline */}
      <ol className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pb-16 list-none m-0 p-0" style={{ paddingLeft: 0 }}>
        {TIMELINE.map((item, i) => (
          <m.li key={item.phase} className="mb-10"
            initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ delay: i * 0.05 }}>
            <div className="relative rounded-2xl overflow-hidden glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <img src={pageArt('lore', i + 1).src} alt={`Phase ${item.phase}: ${item.title}`} loading="lazy" className="w-full h-full object-cover" />
              </div>
              <div className="relative z-10 p-5 md:p-10">
                <div className="flex items-start gap-4 md:gap-8">
                  <span className="stat-value text-[32px] md:text-[52px] text-white/20 leading-none flex-shrink-0">{item.phase}</span>
                  <div>
                    <h2 className="heading-luxury text-xl md:text-2xl text-white mb-3">{item.title}</h2>
                    <div className="accent-divider mb-4" />
                    <p className="text-white text-[14px] md:text-[15px] leading-relaxed max-w-xl">{item.description}</p>
                  </div>
                </div>
              </div>
            </div>
          </m.li>
        ))}

        {/* Call to action */}
        <m.div className="text-center mt-12" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
          <p className="text-white text-[13px] uppercase tracking-wider label-pill mb-2">DM+T = Memetic Finance</p>
          <p className="text-white text-[14px] mb-1">We came for the art. We stayed to FAFO.</p>
          <p className="heading-luxury text-2xl text-white">This is Jungle Bay.</p>
        </m.div>
      </ol>
    </div>
  );
}
