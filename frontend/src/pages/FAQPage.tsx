import { useState, useEffect } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { VENUE_FAQ_INTRO } from '../lib/copy';
import { venueFaq } from '../lib/faqData';
import { heatLaunchFloor } from '../lib/heat/heatGateConfig';
import { ArtImg } from '../components/ArtImg';

export default function FAQPage() {
  usePageTitle('FAQ', 'Frequently asked questions about memetics.finance');
  const [openIndex, setOpenIndex] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Inject FAQPage structured data for SEO rich results
  useEffect(() => {
    // The venue's answers only. TOWELI's live in its room, not in this
    // page's search payload.
    const allItems = venueFaq(heatLaunchFloor()).flatMap(s => s.items);
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: allItems.map(item => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(jsonLd);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  const toggle = (key: string) => setOpenIndex(openIndex === key ? null : key);

  // Stable, filter-independent key for accordion open-state + a slug-safe id for
  // aria-controls/labelledby. Keying by positional index into the *filtered*
  // arrays meant a search that reshaped the list could transfer the open state
  // to a different question (F385); the question text is stable across filters.
  const stableKey = (category: string, q: string) => `${category}|${q}`;
  const slugId = (category: string, q: string) =>
    `${category}-${q}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const filtered = venueFaq(heatLaunchFloor()).map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        item.q.toLowerCase().includes(search.toLowerCase()) ||
        item.a.toLowerCase().includes(search.toLowerCase())
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="faq" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-32 pb-20">
        {/* Header */}
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
            {VENUE_FAQ_INTRO.headline}
          </h1>
          <p className="text-gray-400 text-sm md:text-base max-w-[600px] mx-auto" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            {VENUE_FAQ_INTRO.subheading}
          </p>
          <p className="text-white/60 text-xs mt-2" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Questions about TOWELI itself are answered in{' '}
            <Link to="/toweli" className="underline underline-offset-4 hover:text-white">the TOWELI room</Link>.
          </p>
        </m.div>

        {/* Search */}
        <m.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <div
            className="rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}
          >
            <svg className="w-5 h-5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              aria-label="Search questions"
              placeholder="Search questions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent w-full text-white placeholder-gray-500 outline-none text-[16px]"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear search" className="text-gray-500 hover:text-white text-lg leading-none">
                &times;
              </button>
            )}
          </div>
        </m.div>

        {/* FAQ Sections */}
        {filtered.length === 0 && (
          <div
            className="rounded-xl px-5 py-10 text-center"
            style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}
          >
            <p className="text-white text-sm mb-1">No questions match your search.</p>
            <p className="text-gray-400 text-xs mb-4">Try a different term, or browse all questions.</p>
            <button
              onClick={() => setSearch('')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white border border-white/15 hover:border-white/30 transition-colors"
            >
              Clear search
            </button>
          </div>
        )}

        {filtered.map((section, sIdx) => (
          <m.div
            key={section.category}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + sIdx * 0.05 }}
            className="mb-6"
          >
            {/* F434: translucent dark chip so the label stays legible over the
                bright watercolor art (same treatment as the accordion rows). */}
            <h2 className="inline-block text-purple-300 text-xs font-semibold uppercase tracking-widest mb-3 px-2.5 py-1 rounded-md"
              style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}>
              {section.category}
            </h2>
            <div
              className="rounded-xl overflow-hidden divide-y divide-white/5"
              style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}
            >
              {section.items.map((item) => {
                const key = stableKey(section.category, item.q);
                const id = slugId(section.category, item.q);
                const isOpen = openIndex === key;
                const panelId = `faq-panel-${id}`;
                const buttonId = `faq-q-${id}`;
                return (
                  <div key={key}>
                    {/* AUDIT FAQ-A11Y: accordion-button pattern. aria-expanded
                        announces open/closed to screen readers; aria-controls
                        + matching panel id ties the button to its content so
                        SR users can navigate to the revealed text directly. */}
                    <button
                      id={buttonId}
                      onClick={() => toggle(key)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-white/[0.03] transition-colors"
                    >
                      <span className="text-white text-sm font-medium leading-snug">{item.q}</span>
                      <m.svg
                        animate={{ rotate: isOpen ? 180 : 0 }}
                        transition={{ duration: 0.25 }}
                        className="w-4 h-4 text-purple-400 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </m.svg>
                    </button>
                    {/* WAVE SEVEN, row Q: THE ANSWER IS ALWAYS ON THE PAGE.
                        It used to mount only while open, which left
                        aria-controls naming an id that did not exist (this
                        route's aria-valid-attr-value finding) and kept every
                        answer out of reach of the voice census, so a TOWELI
                        answer could hide under a venue question. `hidden`
                        keeps a closed answer out of view and out of the
                        accessibility tree; its words are still here. */}
                    <div
                      id={panelId}
                      role="region"
                      aria-labelledby={buttonId}
                      hidden={!isOpen}
                      className="px-5 pb-4 text-gray-400 text-sm leading-relaxed"
                    >
                      {item.a}
                    </div>
                  </div>
                );
              })}
            </div>
          </m.div>
        ))}

        <p className="text-center text-white/40 text-xs mt-10" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Last reviewed: September 2026
        </p>
      </div>
    </div>
  );
}
