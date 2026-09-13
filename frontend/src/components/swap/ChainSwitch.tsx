import { Link, useLocation, useSearchParams } from 'react-router-dom';
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
 * `?out=<mint>` on the Solana side is preserved when it is already there, so a
 * reload or a share of /solana?out=<mint> keeps the token you came for. It does
 * NOT survive the hop to Ethereum, and the header used to say it did: `?out=` is
 * a Solana mint and /swap has no use for one, so the Ethereum half is a bare
 * `/swap` and nothing in the app produces `/swap?out=`. The preservation is
 * real, but it is preservation of the SELF-link, not a round trip.
 *
 * WHICH ONE IS LIT IS READ OFF THE URL, NOT PASSED IN (2026-09-10). It used to be
 * an `active` prop, and a prop is a claim a caller can get wrong: /pools — the
 * venue's own Solana AMM, a LIQUIDITY page and neither of these two swap
 * surfaces — passed `active="solana"`, so the control sat there with the Solana
 * half highlighted and `aria-current="page"` on it, telling a screen reader the
 * visitor was on /solana. They were not. The URL is already the state (see
 * above), so deriving from it makes that class of mistake unrepresentable rather
 * than merely fixed: a page cannot mislabel itself, and a route that is neither
 * surface simply lights neither half and offers both as what they are — two
 * places to go.
 *
 * The segment-boundary match mirrors SectionHost's `matchesRoute` for the same
 * reason it exists there: a bare `startsWith` would light Solana on any future
 * `/solana-something`.
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
  // BOTH HALVES READ THE BUNGALOW, 2026-09-05. The Solana half always did; the
  // Ethereum half was the hardcoded literal `'TOWELI · Uniswap / CoW'`, which
  // meant a PEPE or BAYLA holder — and, worse, a visitor who had chosen no
  // bungalow at all and was being spoken to by the VENUE — read one resident's
  // ticker as the name of the whole Ethereum rail. The venue does not have a
  // token; its residents do. With nothing chosen the sub is now just the venues
  // this chain routes through, which is the honest answer to "what is over
  // there" and is what the label above it was always carrying anyway.
  const bungalow = getActiveBungalow();
  const solanaToken = bungalow?.chain === 'solana' ? bungalow.symbol : null;
  const ethToken =
    bungalow?.chain === 'ethereum' || bungalow?.chain === 'base' ? bungalow.symbol : null;

  const options = [
    {
      id: 'ethereum' as const,
      label: 'Ethereum',
      sub: ethToken ? `${ethToken} · Uniswap / CoW` : 'Uniswap / CoW',
      to: '/swap',
    },
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
