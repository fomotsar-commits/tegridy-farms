import { useState } from 'react';
import { motion } from 'framer-motion';
// formatCurrency available if needed for USD display

interface ReferralWidgetProps {
  address: string;
  referredCount: number;
  referralEarned: number;
  referralPending: number;
}

export function ReferralWidget({ address, referredCount, referralEarned, referralPending }: ReferralWidgetProps) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const referralLink = `https://tegridy.farm/?ref=${address}`;
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
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
    } catch {
      const el = document.createElement('textarea');
      el.value = referralLink;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const truncatedLink = `tegridy.farm/?ref=${address.slice(0, 6)}...${address.slice(-4)}`;

  return (
    <motion.div
      className="glass-card rounded-xl mb-6"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="p-5">
        <h3 className="text-white text-[15px] font-medium mb-4">Referral Program</h3>

        {/* Referral Link */}
        <div className="mb-5">
          <p className="text-white/40 text-[11px] uppercase tracking-wider mb-2">Your Referral Link</p>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 bg-white/[0.04] rounded-lg px-3 py-2.5 border border-white/[0.06]">
              <p className="text-white/60 text-[13px] truncate font-mono">{truncatedLink}</p>
            </div>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 btn-primary px-4 py-2.5 text-[12px] min-w-[72px]"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="bg-white/[0.03] rounded-lg p-3 text-center">
            <p className="text-white/40 text-[10px] uppercase tracking-wider mb-1">Referrals</p>
            <p className="stat-value text-[18px] text-white">{referredCount}</p>
          </div>
          <div className="bg-white/[0.03] rounded-lg p-3 text-center">
            <p className="text-white/40 text-[10px] uppercase tracking-wider mb-1">Earned</p>
            <p className="stat-value text-[18px] text-success">{referralEarned.toFixed(4)}</p>
            <p className="text-white/25 text-[9px]">ETH</p>
          </div>
          <div className="bg-white/[0.03] rounded-lg p-3 text-center">
            <p className="text-white/40 text-[10px] uppercase tracking-wider mb-1">Pending</p>
            <p className="stat-value text-[18px] text-primary">{referralPending.toFixed(4)}</p>
            <p className="text-white/25 text-[9px]">ETH</p>
          </div>
        </div>

        {/* Share */}
        <div>
          <p className="text-white/40 text-[11px] uppercase tracking-wider mb-2">Share</p>
          <div className="flex items-center gap-2">
            <a
              href={tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg px-4 py-2.5 text-white/70 hover:text-white text-[12px] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Tweet
            </a>
            <button
              onClick={handleCopyLink}
              className="flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg px-4 py-2.5 text-white/70 hover:text-white text-[12px] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
              {linkCopied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
