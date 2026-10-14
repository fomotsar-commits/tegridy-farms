import { Link } from 'react-router-dom';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from '../../lib/bungalows';
import { TEGRIDY_STAKING_ADDRESS, isDeployed } from '../../lib/constants';
import { poolShape } from '../../lib/poolShape';

/**
 * Every live pool on the island, at /earn; each row opens /earn/<id>. It reads
 * no chain: rows come from the registry, so no failed read can draw a funded
 * pool as $0. Each pool's rate is read inside its own room, which can say when
 * a read failed. Below 640px the chain and terms fold under the pool's name, so
 * each row's Open button stays on the screen beside it.
 */

const CHAIN_LABEL: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
  tbd: '—',
};

/** A row, whether it comes from the registry or from constants.ts. */
interface PoolRow {
  id: string;
  symbol: string;
  name: string;
  chain: string;
  accent?: string;
  terms: string;
}

export function VenuePoolIndex() {
  // Every settled resident that actually has a staking program registered. A
  // bungalow with no `stakePool` has nothing to list, and listing it with a
  // dash would advertise a pool that does not exist.
  const rows: PoolRow[] = BUNGALOWS.filter((b) => b.live && (b.stakePool || b.ladderPool)).map((b) => ({
    id: b.id,
    symbol: b.symbol,
    name: b.name,
    chain: b.chain,
    accent: b.accent,
    terms: poolShape(b),
  }));

  // TOWELI is a row like every other resident's, never a footnote. Its staking
  // program predates the registry, so its row is built here from
  // TEGRIDY_STAKING_ADDRESS (constants.ts) instead of a registry `stakePool`.
  const toweli = BUNGALOWS.find((b) => b.id === DEFAULT_BUNGALOW_ID);
  if (toweli && isDeployed(TEGRIDY_STAKING_ADDRESS)) {
    rows.push({
      id: toweli.id,
      symbol: toweli.symbol,
      name: toweli.name,
      chain: toweli.chain,
      accent: toweli.accent,
      terms: poolShape({ poolKind: 'ladder', chain: toweli.chain }),
    });
  }

  return (
    <section aria-labelledby="venue-pools-index" className="mb-8">
      <div className="mb-4">
        <h2 id="venue-pools-index" className="text-white text-lg font-semibold mb-1">
          Earn across Jungle Bay Island
        </h2>
        <p className="text-white/65 text-[13px] leading-relaxed max-w-[64ch]">
          Every resident community runs its own pool, in its own token, on its own chain. Pick a
          room to see its live rate, its reward balance and what your position is worth. Those
          numbers are read on chain there, where a failed read can say so.
        </p>
      </div>

      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      >
        {/* `relative` IS LOAD-BEARING — it is what CONTAINS the sr-only span in the
            last <th>. `sr-only` is position:absolute, clipped by this overflow only
            when this box is positioned; static, the span painted at the table's
            right edge and the whole page scrolled sideways on a phone. */}
        <div className="relative overflow-x-auto">
          <table className="w-full text-left border-collapse sm:min-w-[520px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-white/50">
                <th scope="col" className="font-semibold px-4 py-3">Pool</th>
                <th scope="col" className="hidden sm:table-cell font-semibold px-4 py-3">Chain</th>
                <th scope="col" className="hidden sm:table-cell font-semibold px-4 py-3">Terms</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <th scope="row" className="pl-4 pr-2 sm:pr-4 py-3.5 font-normal">
                    <span className="flex items-center gap-2.5">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: b.accent ?? 'var(--color-kyle)' }}
                        aria-hidden="true"
                      />
                      <span className="text-white text-[14px] font-semibold">{b.symbol}</span>
                      <span className="text-white/45 text-[12px]">{b.name}</span>
                    </span>
                    {/* Below 640px the Chain and Terms cells are hidden; their words ride here. */}
                    <span className="sm:hidden block mt-1 pl-[18px] text-white/60 text-[12px] leading-snug">
                      {CHAIN_LABEL[b.chain] ?? b.chain} · {b.terms}
                    </span>
                  </th>
                  <td className="hidden sm:table-cell px-4 py-3.5 text-white/75 text-[13px]">{CHAIN_LABEL[b.chain] ?? b.chain}</td>
                  <td className="hidden sm:table-cell px-4 py-3.5 text-white/60 text-[12.5px]">{b.terms}</td>
                  <td className="pl-2 pr-4 sm:pl-4 py-3.5 text-right">
                    {/* A real link: each pool has its own address, /earn/<id>, which
                        enters that pool's room on arrival (App.tsx EarnPoolRoute). */}
                    <Link
                      to={`/earn/${b.id}`}
                      className="inline-flex items-center justify-center whitespace-nowrap px-3.5 py-2 min-h-[36px] rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110"
                      style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)' }}
                    >
                      Open {b.symbol}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-2.5 text-[11.5px] text-white/50 leading-relaxed">
        No rate is shown here because none is read here. Twelve pools across three chains would be
        twelve calls before this list could draw, and a call that does not answer renders as a zero,
        which would read as &ldquo;empty, pays nothing&rdquo; about a pool that may be neither.
        Each room reads its own.
      </p>

      {/* The venue's OWN surface, named as such. Liquidity is the one earning
          route that is genuinely the VENUE's rather than a resident's — the
          pools belong to the factory this protocol deployed — so it is the only
          thing that earns a line of its own under a table of thirteen peers. */}
      <div className="mt-5">
        <Link
          to="/liquidity"
          className="text-[13px] underline underline-offset-2 text-white/80 hover:text-white"
        >
          Provide liquidity on the venue&apos;s own pools →
        </Link>
      </div>
    </section>
  );
}
