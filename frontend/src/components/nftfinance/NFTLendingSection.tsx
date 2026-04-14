import { motion } from 'framer-motion';
import { ART } from '../../lib/artConfig';

const COLLECTIONS = [
  { name: 'Jungle Bay Ape Club', symbol: 'JBAC', address: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9', art: ART.apeHug?.src },
  { name: 'Nakamigos', symbol: 'NAKA', address: '0xd774557b647330C91Bf44cfEAB205095f7E6c367', art: ART.busCrew?.src },
  { name: 'GNSS Art', symbol: 'GNSS', address: '0xa1De9f93c56C290C48849B1393b09eB616D55dbb', art: ART.forestScene?.src },
];

export function NFTLendingSection() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h2 className="heading-luxury text-xl md:text-2xl text-white mb-2">NFT Lending</h2>
        <p className="text-white/70 text-[13px]">
          Borrow ETH against your NFTs or lend ETH and earn interest. P2P — no oracles, no liquidations.
        </p>
      </motion.div>

      {/* Supported Collections */}
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-3 gap-4"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        {COLLECTIONS.map((c) => (
          <div
            key={c.address}
            className="relative overflow-hidden rounded-xl"
            style={{ border: '1px solid rgba(139,92,246,0.3)' }}
          >
            {c.art && (
              <div className="absolute inset-0">
                <img src={c.art} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.4) 0%, rgba(6,12,26,0.85) 100%)' }} />
              </div>
            )}
            <div className="relative z-10 p-4 md:p-5">
              <h3 className="text-white font-semibold text-[14px] mb-1">{c.name}</h3>
              <p className="text-white/50 text-[11px] font-mono mb-3">{c.symbol}</p>
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  Accepted Collateral
                </span>
              </div>
            </div>
          </div>
        ))}
      </motion.div>

      {/* How it Works */}
      <motion.div
        className="rounded-2xl p-5 md:p-6"
        style={{ background: 'rgba(13,21,48,0.5)', border: '1px solid rgba(139,92,246,0.2)' }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <h3 className="text-white font-semibold text-[15px] mb-4">How NFT Lending Works</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <h4 className="text-emerald-400 text-[13px] font-semibold">For Lenders</h4>
            <ol className="space-y-2 text-white/70 text-[13px]">
              <li className="flex gap-2"><span className="text-purple-400 font-bold">1.</span> Create a loan offer — set principal (ETH), APR, duration, and which collection you'll accept.</li>
              <li className="flex gap-2"><span className="text-purple-400 font-bold">2.</span> Your ETH is held in the contract until a borrower accepts.</li>
              <li className="flex gap-2"><span className="text-purple-400 font-bold">3.</span> Earn interest when the borrower repays, or claim the NFT if they default.</li>
            </ol>
          </div>
          <div className="space-y-3">
            <h4 className="text-emerald-400 text-[13px] font-semibold">For Borrowers</h4>
            <ol className="space-y-2 text-white/70 text-[13px]">
              <li className="flex gap-2"><span className="text-purple-400 font-bold">1.</span> Browse open loan offers for your NFT collection.</li>
              <li className="flex gap-2"><span className="text-purple-400 font-bold">2.</span> Accept an offer by depositing your NFT as collateral.</li>
              <li className="flex gap-2"><span className="text-purple-400 font-bold">3.</span> Receive ETH instantly. Repay before the deadline to get your NFT back.</li>
            </ol>
          </div>
        </div>
      </motion.div>

      {/* Contract Status */}
      <motion.div
        className="rounded-xl p-4 text-center"
        style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <p className="text-yellow-200/80 text-[13px]">
          NFT Lending contract deployed. Full UI with offer creation, browsing, and loan management coming soon.
        </p>
      </motion.div>
    </div>
  );
}
