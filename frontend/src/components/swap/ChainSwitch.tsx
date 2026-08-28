import { Link, useSearchParams } from 'react-router-dom';
import { getActiveBungalow } from '../../lib/bungalows';

/**
 * The venue trades on two chains and had no way to say so.
 *
 * `/swap` is the Ethereum surface (Uniswap/CoW, TOWELI-denominated) and
 * `/solana` is the Jupiter one; the only route between them was the "More"
 * menu. So a visitor standing in the BAYLA bungalow — a token that exists
 * only on Solana — clicked "Trade" in the nav and landed on an ETH swap that
 * cannot touch her, with nothing on the page admitting the other half existed.
 *
 * This is that admission: one control, present on BOTH surfaces, that says
 * which chain you are on and moves you to the other one. It is a plain pair
 * of links (not a toggle with state) because the two surfaces are separate
 * routes with separate wallets — the URL IS the state.
 *
 * `?out=<mint>` on the Solana side is preserved when it is already there, so
 * "Trade BAYLA" → switch to Ethereum → switch back keeps the token you came
 * for.
 */
export function ChainSwitch({ active }: { active: 'ethereum' | 'solana' }) {
  const [params] = useSearchParams();
  const out = params.get('out');
  const solanaTo = out ? `/solana?out=${encodeURIComponent(out)}` : '/solana';

  // A Solana bungalow makes the point louder: the active token lives over
  // there, so name it rather than leaving the visitor to guess.
  const bungalow = getActiveBungalow();
  const solanaToken = bungalow?.chain === 'solana' ? bungalow.symbol : null;

  const options = [
    { id: 'ethereum' as const, label: 'Ethereum', sub: 'TOWELI · Uniswap / CoW', to: '/swap' },
    { id: 'solana' as const, label: 'Solana', sub: solanaToken ? `${solanaToken} · Jupiter` : 'Jupiter', to: solanaTo },
  ];

  return (
    <div
      className="flex gap-1.5 p-1 rounded-2xl mb-4"
      role="group"
      aria-label="Trade on Ethereum or Solana"
      style={{ background: 'rgba(13,21,48,0.85)', border: '1px solid rgba(255,255,255,0.20)' }}
    >
      {options.map((o) => {
        const isActive = o.id === active;
        return (
          <Link
            key={o.id}
            to={o.to}
            aria-current={isActive ? 'page' : undefined}
            className="flex-1 px-3 py-2 min-h-[44px] rounded-xl text-center transition-all text-white"
            style={isActive ? {
              background: 'var(--color-stan)',
              boxShadow: '0 4px 12px var(--color-stan-40)',
            } : { textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}
          >
            <span className="block text-[13px] font-medium leading-tight">{o.label}</span>
            <span className="block text-[10px] leading-tight opacity-70">{o.sub}</span>
          </Link>
        );
      })}
    </div>
  );
}
