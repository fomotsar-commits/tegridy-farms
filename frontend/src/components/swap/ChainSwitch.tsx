import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { getActiveBungalow } from '../../lib/bungalows';

/**
 * Which chain's swap the visitor is on, and a link to the other: `/swap` (Ethereum) and
 * `/solana` (our own pools or Jupiter). Plain links, lit by the URL (segment-boundary match,
 * as SectionHost's `matchesRoute`), never by a prop: a route that is neither lights neither.
 * `?out=` survives a reload of the Solana self-link only: /swap has no use for a Solana mint.
 */
function isOn(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function ChainSwitch() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const out = params.get('out');
  const solanaTo = out ? `/solana?out=${encodeURIComponent(out)}` : '/solana';
  // Neither, on a page that is neither. `active` is deliberately allowed to be
  // null — see the block above.
  const active = isOn(pathname, '/swap') ? 'ethereum' : isOn(pathname, '/solana') ? 'solana' : null;

  // A bungalow makes the point louder: the active token lives on one of these
  // chains, so name it rather than leaving the visitor to guess.
  //
  // Each half names the active bungalow's token when it lives on that chain, and
  // otherwise only the venues the chain routes through: the venue has no token. The
  // venues never break across lines, so a narrow phone wraps after the token.
  const bungalow = getActiveBungalow();
  const solanaToken = bungalow?.chain === 'solana' ? bungalow.symbol : null;
  const ethToken =
    bungalow?.chain === 'ethereum' || bungalow?.chain === 'base' ? bungalow.symbol : null;

  const options = [
    {
      id: 'ethereum' as const,
      label: 'Ethereum',
      token: ethToken,
      venues: 'Uniswap / CoW',
      to: '/swap',
    },
    { id: 'solana' as const, label: 'Solana', token: solanaToken, venues: 'Our pools + Jupiter', to: solanaTo },
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
            <span className="block text-[10px] leading-tight opacity-70">
              {o.token && `${o.token} · `}
              <span className="whitespace-nowrap">{o.venues}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
