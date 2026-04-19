import { useState, useRef, useEffect } from 'react';
import { m } from 'framer-motion';
import { ArtImg } from './ArtImg';

interface ReferralWidgetProps {
  address: string;
  referredCount: number;
  referralEarned: number;
  referralPending: number;
}

export function ReferralWidget({ address, referredCount, referralEarned, referralPending }: ReferralWidgetProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const referralLink = `https://tegridy.farm/?ref=${encodeURIComponent(address)}`;
  const tweetText = encodeURIComponent(
    "I'm farming on @TegridyFarms! Join with my referral link for bonus rewards \u{1F33F}"
  );
  const tweetUrl = `https://twitter.com/intent/tweet?text=${tweetText}&url=${encodeURIComponent(referralLink)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
    } catch {
      const el = document.createElement('textarea');
      el.value = referralLink;
      Object.assign(el.style, { position: 'fixed', left: '-9999px', opacity: '0' });
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const truncatedLink = `tegridy.farm/?ref=${address.slice(0, 6)}...${address.slice(-4)}`;

  return (
    <m.div
      className="relative overflow-hidden rounded-xl glass-card-animated mb-6"
      style={{ border: '1px solid var(--color-purple-75)' }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="absolute inset-0">
        <ArtImg pageId="referral-widget" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="relative z-10 p-5">
        <h3 className="text-white text-[15px] font-medium mb-4">Referral Program</h3>

        {/* Referral Link */}
        <div className="mb-5">
          <p className="text-white text-[11px] uppercase tracking-wider label-pill mb-2">Your Referral Link</p>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 bg-black/40 hover:bg-black/60 rounded-lg px-3 py-2.5 border border-white/20 transition-colors">
              <p className="text-white text-[13px] truncate font-mono">{truncatedLink}</p>
            </div>
            <button
              onClick={handleCopy}
              aria-label="Copy referral link"
              className="flex-shrink-0 btn-primary px-4 py-2.5 text-[12px] min-w-[72px]"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="bg-black/40 hover:bg-black/60 rounded-lg p-3 text-center transition-colors">
            <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Referrals</p>
            <p className="stat-value text-[18px] text-white">{referredCount}</p>
          </div>
          <div className="bg-black/40 hover:bg-black/60 rounded-lg p-3 text-center transition-colors">
            <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Earned</p>
            <p className="stat-value text-[18px] text-success">{(referralEarned ?? 0).toFixed(4)}</p>
            <p className="text-white text-[9px]">ETH</p>
          </div>
          <div className="bg-black/40 hover:bg-black/60 rounded-lg p-3 text-center transition-colors">
            <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Pending</p>
            <p className="stat-value text-[18px] text-white">{(referralPending ?? 0).toFixed(4)}</p>
            <p className="text-white text-[9px]">ETH</p>
          </div>
        </div>

        {/* Share */}
        <div>
          <p className="text-white text-[11px] uppercase tracking-wider label-pill mb-2">Share</p>
          <div className="flex items-center gap-2">
            <a
              href={tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Tweet referral link (opens in new tab)"
              className="flex items-center gap-2 bg-black/40 hover:bg-black/60 border border-white/20 rounded-lg px-4 py-2.5 text-white hover:text-white text-[12px] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Tweet
            </a>
            <button
              onClick={handleCopy}
              aria-label="Copy referral link"
              className="flex items-center gap-2 bg-black/40 hover:bg-black/60 border border-white/20 rounded-lg px-4 py-2.5 text-white hover:text-white text-[12px] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
              {copied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
        </div>
      </div>
    </m.div>
  );
}
