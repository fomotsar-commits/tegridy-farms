import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// TRUST HUB — the one screen that frames the three detection surfaces as a single
// anti-rug suite instead of three unrelated links buried in a "Stats" submenu.
//
// Deliberately THIN: it owns no detection logic and computes nothing. Every tool it
// points at is already built, tested and routable; this page exists purely so a
// visitor can discover the suite and move between its parts. Honest-framing rules
// apply verbatim — these are DESCRIPTIVE MEASUREMENTS with disclosed methods and
// exclusions, never verdicts on intent, and each self-gates to an explicit
// unknown/unavailable state rather than inventing a number.

interface Tool {
  to: string;
  name: string;
  question: string;
  blurb: string;
  reads: string;
}

const TOOLS: Tool[] = [
  {
    to: '/scan',
    name: 'Token Scanner',
    question: 'Who actually holds this token?',
    blurb:
      'Paste any Ethereum or Solana token address for a holder-concentration and distribution read — top-holder share, effective holder count, and the addresses it excluded, with a timestamp.',
    reads: 'Ethereum · Solana',
  },
  {
    to: '/deployer',
    name: 'Deployer Graph',
    question: 'What has this deployer shipped before?',
    blurb:
      'Look up an address and see the tokens it created and where each one stands today. Gaps are disclosed loudly — factory-launched tokens and launch-time baselines need an indexer we do not run yet.',
    reads: 'Ethereum',
  },
  {
    to: '/exposure',
    name: 'Wallet Exposure',
    question: 'What am I already holding?',
    blurb:
      'Point the same engine at your own connected wallet. Position sizes are read exactly on-chain; the concentration read behind each one self-gates when holder data is unavailable.',
    reads: 'Connected wallet',
  },
];

export default function TrustHubPage() {
  usePageTitle(
    'Trust Tools',
    'Check a token, a deployer, or your own wallet before you ape — holder-concentration and distribution reads with a disclosed method, exclusions, and timestamp.',
  );

  return (
    <>
      <PageArtBackdrop pageId="scanner" />
      <div className="relative z-10 max-w-[860px] mx-auto px-4 md:px-6 pt-8 pb-28 md:pb-16">
        {/* ── Intro ──────────────────────────────────────────────────── */}
        <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <h1 className="heading-luxury text-2xl md:text-4xl text-text-primary tracking-tight mb-2">Trust Tools</h1>
          <p className="text-[14px] text-text-secondary max-w-[640px]">
            Three free reads that work on <span className="text-text-primary font-medium">any</span> token, deployer or
            wallet — not just ours. Each one is a{' '}
            <span className="text-text-primary font-medium">descriptive measurement</span>: a disclosed method, the
            addresses it excluded, and a timestamp. None of them is a verdict on anyone&apos;s intent, and none will
            invent a number when the underlying data is missing — they say so instead.
          </p>
        </m.div>

        {/* ── The suite ──────────────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2">
          {TOOLS.map((t, i) => (
            <m.div
              key={t.to}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.04 * (i + 1) }}
              className={t.to === '/exposure' ? 'sm:col-span-2' : undefined}
            >
              <Link
                to={t.to}
                className="glass-card rounded-xl p-4 h-full flex flex-col hover:border-emerald-500/40 transition-colors"
              >
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-text-primary font-semibold text-[15px]">{t.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-text-muted shrink-0">{t.reads}</span>
                </div>
                <p className="text-[13px] text-emerald-300/90 mb-1.5">{t.question}</p>
                <p className="text-[13px] text-text-secondary leading-relaxed">{t.blurb}</p>
                <span className="mt-3 text-[12px] text-emerald-400/80 group-hover:text-emerald-300">Open {t.name} →</span>
              </Link>
            </m.div>
          ))}
        </div>

        {/* ── How to read a result ───────────────────────────────────── */}
        <div className="glass-card rounded-xl p-4 mt-4">
          <h2 className="text-text-primary font-semibold text-[14px] mb-2">How to read a result</h2>
          <ul className="text-[13px] text-text-secondary space-y-1.5 leading-relaxed list-disc pl-4">
            <li>
              <span className="text-text-primary">Concentration is not fraud.</span> A high top-holder share can be a
              locked LP, a bridge, or a treasury — the report lists what it excluded so you can judge the rest.
            </li>
            <li>
              <span className="text-text-primary">A gap is shown as a gap.</span> Where a data source is unavailable the
              report says &ldquo;unmeasured&rdquo;, never zero. An unknown never silently becomes a passing grade.
            </li>
            <li>
              <span className="text-text-primary">Every read is a link.</span> The address lives in the URL, so any
              result can be shared or re-checked later — including by whoever you are asking about.
            </li>
          </ul>
        </div>

        {/* ── Our own posture (honest cross-link, not a claim) ───────── */}
        <p className="text-[12px] text-text-muted mt-4 leading-relaxed">
          For how this protocol itself is secured — including what has and has not been audited — see{' '}
          <Link to="/security" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
            Security
          </Link>{' '}
          and{' '}
          <Link to="/risks" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
            Risks
          </Link>
          . Launching something yourself? The{' '}
          <Link to="/launch" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
            launcher
          </Link>{' '}
          publishes the same kind of disclosure as a Fact Sheet at launch.
        </p>
      </div>
    </>
  );
}
