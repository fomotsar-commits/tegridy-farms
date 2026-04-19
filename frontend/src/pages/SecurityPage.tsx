import { m } from 'framer-motion';
import { useState } from 'react';
import { pageArt, artStyle } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';

const fade = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };

const CONTRACTS = [
  { name: 'TegridyStaking', address: '0x65D8b87917c59a0B33009493fB236bCccF1Ea421' },
  { name: 'TegridyFactory', address: '0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6' },
  { name: 'TegridyRouter', address: '0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F' },
  { name: 'TegridyLending', address: '0xd471e5675EaDbD8C192A5dA2fF44372D5713367f' },
  { name: 'TegridyNFTLending', address: '0x63baD13f89186E0769F636D4Cd736eB26E2968aD' },
  { name: 'TegridyNFTPoolFactory', address: '0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0' },
];

const PROTECTIONS = [
  { title: 'Reentrancy Guards', desc: 'All high-risk functions protected with nonReentrant modifiers', icon: 'shield' },
  { title: 'Timelock Admin', desc: '24-48h delay on all admin parameter changes', icon: 'clock' },
  { title: 'No Oracle Risk', desc: 'Protocol does not depend on external price oracles', icon: 'eye-off' },
  { title: 'No Flash Loans', desc: 'Flash swaps explicitly disabled at the router level', icon: 'zap-off' },
  { title: 'Ownership Protection', desc: '2-step ownership transfer, renouncement disabled', icon: 'lock' },
  { title: 'Pausable', desc: 'Emergency pause mechanism on all core contracts', icon: 'pause' },
];

const BOUNTY_TIERS = [
  { severity: 'Critical', reward: '$10,000', color: '#ef4444' },
  { severity: 'High', reward: '$5,000', color: '#f97316' },
  { severity: 'Medium', reward: '$1,000', color: '#eab308' },
  { severity: 'Low', reward: '$500', color: '#22c55e' },
];


// Card-art helper: per-card background image framed by a translucent black
// content panel so text stays legible without hiding the art.
function ArtCard({
  art,
  children,
  className = '',
  padding = 'p-5 md:p-6',
}: {
  art: { src: string; objectPosition?: string; scale?: number };
  children: React.ReactNode;
  className?: string;
  padding?: string;
}) {
  return (
    <div
      className={`rounded-2xl relative overflow-hidden ${className}`}
      style={{ border: '1px solid var(--color-purple-12)' }}
    >
      <div className="absolute inset-0">
        <img src={art.src} alt="" loading="lazy" className="w-full h-full object-cover" style={artStyle(art)} />
      </div>
      <div
        className={`relative z-10 m-2 md:m-3 rounded-lg ${padding}`}
        style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        {children}
      </div>
    </div>
  );
}

function ShieldIcon() {
  return (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><path d="M12 2l7 4v5c0 5.25-3.5 9.74-7 11-3.5-1.26-7-5.75-7-11V6l7-4z"/></svg>);
}
function LockIcon() {
  return (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>);
}
function ClockIcon() {
  return (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>);
}
function EyeOffIcon() {
  return (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>);
}
function ZapOffIcon() {
  return (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><polyline points="12.41 6.75 13 2 10.57 4.92"/><polyline points="18.57 12.91 21 10 15.66 10"/><polyline points="8 8 3 14h6l-1 8 5-6"/><line x1="1" y1="1" x2="23" y2="23"/></svg>);
}
function PauseIcon() {
  return (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>);
}
function CheckIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>);
}
function CopyIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>);
}

const iconMap: Record<string, () => React.ReactNode> = {
  shield: ShieldIcon, lock: LockIcon, clock: ClockIcon,
  'eye-off': EyeOffIcon, 'zap-off': ZapOffIcon, pause: PauseIcon,
};

export default function SecurityPage() {
  usePageTitle('Security', 'Smart contract audits, bug bounty program, and security practices.');
  const [copied, setCopied] = useState<string | null>(null);

  const copyAddr = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="security" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-32 pb-20">

        {/* Hero */}
        <m.div initial="hidden" animate="visible" variants={fade} transition={{ duration: 0.6 }} className="text-center mb-16">
          <h1 className="text-4xl md:text-5xl font-bold mb-4 text-white" style={{ fontFamily: 'Playfair Display, serif', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Security &amp; Transparency</h1>
          <p className="text-white/85 max-w-2xl mx-auto text-lg" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Our commitment to protecting your assets through rigorous testing, transparent practices, and battle-tested smart contract design.</p>
        </m.div>

        {/* Audit Methodology */}
        <m.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fade} transition={{ duration: 0.5 }} className="mb-14">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-3"><ShieldIcon /> Audit Methodology</h2>
          <ArtCard art={pageArt('security', 1)}>
            <p className="text-[#22c55e] mb-5" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Our internal security audit employed red team testing across the full protocol surface. The final audit round included comprehensive re-testing of every previously identified finding.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                '38,794 lines of test code across 34 test files',
                'Reentrancy attack simulations',
                'Sandwich attack simulations',
                'Fuzz testing & invariant testing',
                'Cross-contract integration tests',
                'Final audit round with comprehensive re-testing',
              ].map((item) => (
                <div key={item} className="flex items-start gap-2 text-[#22c55e] text-sm" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}><span className="mt-0.5"><CheckIcon /></span>{item}</div>
              ))}
            </div>
            {/* Audit C-03: the prior "/audit-report.pdf" link was a 404; audit artifacts
                live in the repo as markdown so they version with the code. */}
            <div className="flex flex-wrap gap-3 mt-5">
              <a href="https://github.com/fomotsar-commits/tegridy-farms/blob/main/SECURITY_AUDIT_300_AGENT.md"
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 transition-colors">
                View Full Audit (GitHub)
              </a>
              <a href="https://github.com/fomotsar-commits/tegridy-farms/tree/main#security"
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white/90 border border-white/15 hover:border-white/30 transition-colors">
                All Audit Artifacts
              </a>
            </div>
          </ArtCard>
        </m.section>

        {/* Security Fixes Tracked */}
        <m.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fade} transition={{ duration: 0.5, delay: 0.05 }} className="mb-14">
          <h2 className="text-2xl font-bold mb-6">Audit Artifacts</h2>
          <ArtCard art={pageArt('security', 2)}>
            <p className="mb-4" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9)' }}>
              Multiple multi-agent security reviews have been run against the codebase. The full
              findings, the fixes applied, and the items still open are tracked in the audit
              files linked below. We do not publish aggregate &ldquo;resolved&rdquo; counts here
              because the contents of those files change as work lands; read the source of truth
              directly.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="https://github.com/fomotsar-commits/tegridy-farms/blob/main/SECURITY_AUDIT_300_AGENT.md"
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 transition-colors"
              >
                300-agent review
              </a>
              <a
                href="https://github.com/fomotsar-commits/tegridy-farms/blob/main/SECURITY_AUDIT_OPUS.md"
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white/90 border border-white/15 hover:border-white/30 transition-colors"
              >
                Opus review
              </a>
              <a
                href="https://github.com/fomotsar-commits/tegridy-farms/tree/main#security"
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white/90 border border-white/15 hover:border-white/30 transition-colors"
              >
                All audit files
              </a>
            </div>
          </ArtCard>
        </m.section>

        {/* Smart Contract Design */}
        <m.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fade} transition={{ duration: 0.5, delay: 0.1 }} className="mb-14">
          <h2 className="text-2xl font-bold mb-6">Smart Contract Design</h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {PROTECTIONS.map((p, i) => {
              const Icon = iconMap[p.icon];
              const artPiece = pageArt('security', 3 + i);
              return (
                <ArtCard key={p.title} art={artPiece} padding="p-5">
                  <div className="mb-3">{Icon && <Icon />}</div>
                  <h3 className="font-semibold text-white text-sm md:text-base mb-1" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{p.title}</h3>
                  <p className="text-[#22c55e] text-xs md:text-sm" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>{p.desc}</p>
                </ArtCard>
              );
            })}
          </div>
        </m.section>

        {/* Contract Addresses */}
        <m.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fade} transition={{ duration: 0.5, delay: 0.15 }} className="mb-14">
          <h2 className="text-2xl font-bold mb-6">Contract Addresses</h2>
          <div className="space-y-3">
            {CONTRACTS.map((c, i) => {
              const artPiece = pageArt('security', 9 + i);
              return (
                <div key={c.name} className="rounded-xl relative overflow-hidden" style={{ border: '1px solid var(--color-purple-12)' }}>
                  <div className="absolute inset-0">
                    <img src={artPiece.src} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </div>
                  <div className="relative z-10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{c.name}</div>
                      <div className="text-xs text-[#22c55e] font-mono break-all" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>{c.address}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-emerald-400 flex items-center gap-1">&#10003; Verified</span>
                      <a href={`https://etherscan.io/address/${c.address}`} target="_blank" rel="noopener noreferrer" className="text-xs text-purple-300 hover:text-purple-200 transition-colors">Etherscan</a>
                      <button onClick={() => copyAddr(c.address)} className="text-[#22c55e] hover:text-white transition-colors p-2 min-w-[44px] min-h-[44px] flex items-center justify-center" title="Copy address" aria-label="Copy address">
                        {copied === c.address ? <span className="text-green-400 text-xs">Copied</span> : <CopyIcon />}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </m.section>

        {/* Transparency */}
        <m.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fade} transition={{ duration: 0.5, delay: 0.2 }} className="mb-14">
          <h2 className="text-2xl font-bold mb-6">Transparency</h2>
          <ArtCard art={pageArt('security', 15)}>
            <div className="space-y-3">
              {[
                '100% of swap fees distributed to TOWELI stakers',
                'All admin changes are timelocked (24-48h delay)',
                'No proxy contracts — all code is immutable after deployment',
                'Source code available for independent review',
              ].map((item) => (
                <div key={item} className="flex items-start gap-2 text-[#22c55e]" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}><span className="mt-0.5"><CheckIcon /></span>{item}</div>
              ))}
            </div>
          </ArtCard>
        </m.section>

        {/* Bug Bounty */}
        <m.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fade} transition={{ duration: 0.5, delay: 0.25 }} className="mb-14">
          <h2 className="text-2xl font-bold mb-6">Bug Bounty</h2>
          <ArtCard art={pageArt('security', 16)}>
            <p className="text-[#22c55e] mb-5" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>We partner with Immunefi, the leading Web3 bug bounty platform, for responsible disclosure. Report vulnerabilities via Immunefi or contact us directly via Twitter DM <a href="https://twitter.com/junglebayac" target="_blank" rel="noopener noreferrer" className="text-purple-300 hover:text-purple-200">@junglebayac</a>.</p>
            <a href="https://immunefi.com/bug-bounty/tegridyfarms/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 transition-colors mb-5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Submit on Immunefi
            </a>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              {BOUNTY_TIERS.map((t, i) => {
                const artPiece = pageArt('security', 17 + i);
                return (
                  <div key={t.severity} className="rounded-xl relative overflow-hidden" style={{ border: '1px solid var(--color-purple-12)' }}>
                    <div className="absolute inset-0">
                      <img src={artPiece.src} alt="" loading="lazy" className="w-full h-full object-cover" />
                    </div>
                    <div className="relative z-10 p-4 text-center">
                      <div className="text-lg font-bold" style={{ color: t.color, textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{t.reward}</div>
                      <div className="text-xs text-[#22c55e] mt-1" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>{t.severity}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-sm text-[#22c55e]" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Contact: <a href="mailto:security@tegridyfarms.xyz" className="text-purple-300 hover:text-purple-200">security@tegridyfarms.xyz</a></p>
          </ArtCard>
        </m.section>

        {/* Multisig & Governance */}
        <m.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fade} transition={{ duration: 0.5, delay: 0.3 }}>
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-3"><LockIcon /> Multisig &amp; Governance</h2>
          <ArtCard art={pageArt('security', 21)}>
            <div className="space-y-3">
              {[
                'Protocol admin controlled by team multisig',
                'All parameter changes require 24-48h timelock',
                'Users have time to exit before any admin change takes effect',
                'Ownership transfer requires 2-step confirmation',
              ].map((item) => (
                <div key={item} className="flex items-start gap-2 text-[#22c55e]" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}><span className="mt-0.5"><CheckIcon /></span>{item}</div>
              ))}
            </div>
          </ArtCard>
        </m.section>

      </div>
    </div>
  );
}
