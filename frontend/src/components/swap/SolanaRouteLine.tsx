import type { ReactNode } from 'react';

/**
 * "Where will this trade go, and why?", under the Solana swap's quote. Shown in every
 * state, the ones where our pool loses or is not there included: a routing line that
 * appears only when the house wins is an advert. The words are one function's
 * (lib/solana/swap/venueChoice.ts), so the line and the Buy press cannot disagree.
 */
export function SolanaRouteLine({ text, good = false }: { text: ReactNode; good?: boolean }) {
  return (
    <p
      data-testid="solana-route-line"
      className="text-[10px] leading-relaxed mt-2 rounded-lg px-2.5 py-1.5"
      style={{
        background: good ? 'rgba(34,197,94,0.08)' : 'rgba(0,0,0,0.35)',
        border: `1px solid ${good ? 'rgba(34,197,94,0.30)' : 'rgba(255,255,255,0.10)'}`,
        color: 'rgba(255,255,255,0.55)',
      }}
    >
      <span className="uppercase tracking-wider mr-1.5" style={{ color: 'var(--color-kyle)' }}>Route</span>
      <span className="text-white/80">{text}</span>
    </p>
  );
}
