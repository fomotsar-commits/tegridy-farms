import { useState, useEffect } from 'react';
import { m } from 'framer-motion';
import { useTegridyScore, type TegridyScoreBreakdown } from '../hooks/useTegridyScore';
import { ArtImg } from './ArtImg';

const RING_SIZE = 160;
const STROKE_WIDTH = 10;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const BREAKDOWN_LABELS: { key: keyof TegridyScoreBreakdown; label: string; color: string }[] = [
  { key: 'stakingScore', label: 'Staking', color: '#a78bfa' },
  { key: 'lockScore', label: 'Lock', color: '#c4b5fd' },
  { key: 'activityScore', label: 'Activity', color: '#c4b5fd' },
  { key: 'governanceScore', label: 'Governance', color: '#7c3aed' },
  { key: 'communityScore', label: 'Community', color: '#6d28d9' },
  { key: 'loyaltyScore', label: 'Loyalty', color: '#ddd6fe' },
];

export function TegridyScore() {
  const { score, breakdown, rank, tier, tips } = useTegridyScore();
  const [displayScore, setDisplayScore] = useState(0);
  const [progress, setProgress] = useState(0);

  // Animate score count-up and ring fill
  useEffect(() => {
    const duration = 1200;
    const startTime = performance.now();
    let rafId: number;

    function animate(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - t, 3);

      setDisplayScore(Math.round(eased * score));
      setProgress(eased * score);

      if (t < 1) {
        rafId = requestAnimationFrame(animate);
      }
    }

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [score]);

  const dashOffset = CIRCUMFERENCE - (progress / 100) * CIRCUMFERENCE;

  return (
    <m.div
      className="relative overflow-hidden rounded-xl glass-card-animated"
      style={{ border: '1px solid var(--color-purple-75)' }}
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="absolute inset-0">
        <ArtImg pageId="tegridy-score" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="relative z-10 p-6">
      {/* Circle + Score */}
      <div className="flex flex-col items-center mb-6">
        <div className="relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
          {/* Pulsing glow behind the ring */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: 'radial-gradient(circle, var(--color-purple-25) 0%, var(--color-purple-75) 50%, transparent 70%)',
              animation: 'scoreGlow 3s ease-in-out infinite',
            }}
          />
          <svg width={RING_SIZE} height={RING_SIZE} className="relative transform -rotate-90">
            <defs>
              <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#8b5cf6" />
                <stop offset="50%" stopColor="#a78bfa" />
                <stop offset="100%" stopColor="#fbbf24" />
              </linearGradient>
            </defs>
            {/* Background ring */}
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="var(--color-purple-75)"
              strokeWidth={STROKE_WIDTH}
            />
            {/* Progress ring */}
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="url(#scoreGradient)"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              style={{ transition: 'none' }}
            />
          </svg>
          {/* Center score */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="stat-value text-4xl text-white">{displayScore}</span>
          </div>
        </div>

        <p className="text-[15px] text-white font-medium mt-3">{rank}</p>
        <p className="text-[12px] text-white mt-0.5">{tier}</p>
        <p className="text-[10px] text-white mt-1.5 italic">Score based on on-chain activity</p>
      </div>

      {/* Breakdown bars with stagger */}
      <div className="space-y-2.5 mb-5">
        {BREAKDOWN_LABELS.map(({ key, label, color }, idx) => {
          const value = breakdown[key];
          return (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-white">{label}</span>
                <span className="stat-value text-[11px] text-white">{value}</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-purple-75)' }}>
                <m.div
                  className="h-full rounded-full"
                  style={{ background: color }}
                  initial={{ width: 0 }}
                  animate={{ width: `${value}%` }}
                  transition={{ duration: 0.8, delay: 0.3 + idx * 0.2, ease: 'easeOut' }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Tips */}
      {tips.length > 0 && (
        <div className="pt-4" style={{ borderTop: '1px solid var(--color-purple-75)' }}>
          <div className="space-y-2">
            {tips.map((tip) => (
              <div
                key={tip}
                className="flex items-start gap-2 px-3 py-2 rounded-lg"
                style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}
              >
                <span className="text-[12px] text-warning mt-px">*</span>
                <span className="text-[12px] text-white">{tip}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
    </m.div>
  );
}
