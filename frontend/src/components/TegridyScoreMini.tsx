import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTegridyScore } from '../hooks/useTegridyScore';

const RING_SIZE = 88;
const STROKE_WIDTH = 6;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function TegridyScoreMini() {
  const { score, rank, percentile } = useTegridyScore();
  const [displayScore, setDisplayScore] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const duration = 1000;
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);

      setDisplayScore(Math.round(eased * score));
      setProgress(eased * score);

      if (t < 1) {
        requestAnimationFrame(animate);
      }
    }

    requestAnimationFrame(animate);
  }, [score]);

  const dashOffset = CIRCUMFERENCE - (progress / 100) * CIRCUMFERENCE;

  return (
    <motion.div
      className="flex items-center gap-4"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div className="relative flex-shrink-0" style={{ width: RING_SIZE, height: RING_SIZE }}>
        <svg width={RING_SIZE} height={RING_SIZE} className="transform -rotate-90">
          <defs>
            <linearGradient id="scoreGradientMini" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#8b5cf6" />
              <stop offset="50%" stopColor="#a78bfa" />
              <stop offset="100%" stopColor="#fbbf24" />
            </linearGradient>
          </defs>
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="rgba(139,92,246,0.08)"
            strokeWidth={STROKE_WIDTH}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="url(#scoreGradientMini)"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            style={{ transition: 'none' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="stat-value text-2xl text-white">{displayScore}</span>
        </div>
      </div>
      <div>
        <p className="text-[13px] text-white/70 font-medium">{rank}</p>
        <p className="text-[11px] text-white/30">{percentile}</p>
        <p className="text-[10px] text-primary/50 mt-0.5">Tegridy Score</p>
        <p className="text-[9px] text-white/15 mt-0.5 italic">On-chain verified</p>
      </div>
    </motion.div>
  );
}
