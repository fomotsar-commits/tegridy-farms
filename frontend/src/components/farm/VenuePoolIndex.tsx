import { Link } from 'react-router-dom';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID, setActiveBungalow } from '../../lib/bungalows';
import { TEGRIDY_STAKING_ADDRESS, isDeployed } from '../../lib/constants';

/**
 * Every pool on the island, for a visitor who has chosen no room yet.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. /farm gated on
 * `bungalow && bungalow.id !== DEFAULT_BUNGALOW_ID`, and `getActiveBungalow()`
 * returns null when NOTHING is chosen — so the venue's own default arrival, the
 * first impression a stranger gets, fell through to the classic TOWELI farm:
 * "Stake TOWELI and earn rewards · FAFO", TOWELI price, TOWELI balance, the
 * whole stack. TOWELI is the token of ONE bungalow. The venue does not have a
 * token, and it should not speak as though a resident's is its own.
 *
 * The classic farm did not move and was not edited — it is exactly where it was,
 * inside its own room (isToweliVoice()). This is what the venue says instead.
 *
 * ⚠️ IT READS NO CHAIN, ON PURPOSE, AND THAT IS THE DESIGN — not a shortcut.
 * Twelve pools across three chains would be twelve multicalls before this page
 * could render a single row, and the failure mode is the one this repo keeps
 * relearning: a read that does not land renders as `$0` / `0% APR`, which tells
 * a visitor a funded pool is empty and pays nothing. That is a money-harmful lie
 * about a pool that is neither.
 *
 * So the index is REGISTRY-DERIVED — chain, program shape and lock ladder are
 * facts of `BUNGALOWS`, true whether or not an RPC answers — and every rate,
 * balance and TVL stays where it is actually read: inside each room, on its own
 * self-gating panel, which can name the pool that failed and the reason it gave.
 * The rule this follows is the repo's: a number is publishable only when a read
 * returned it.
 */

/** What the row can honestly say about a pool's shape, from the registry alone. */
function poolShape(kind: 'plain' | 'ladder' | undefined, chain: string): string {
  if (chain === 'solana') return 'Streamflow · locked';
  if (kind === 'ladder') return 'Lock ladder · 7d–4y, 1.00×–4.00×';
  return 'No lock';
}

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
  const rows: PoolRow[] = BUNGALOWS.filter((b) => b.live && b.stakePool).map((b) => ({
    id: b.id,
    symbol: b.symbol,
    name: b.name,
    chain: b.chain,
    accent: b.accent,
    terms: poolShape(b.poolKind, b.chain),
  }));

  // ⚠️ TOWELI IS A ROW, NOT A FOOTNOTE, AND THAT IS THE WHOLE POINT OF THE PAGE.
  // The first cut of this component listed the eleven registry pools and then
  // gave Towelie its own "Open the Towelie bungalow →" link underneath — which
  // is the exact favouritism this page exists to end, just wearing a smaller
  // font. Towelie is one resident of thirteen. Its pool is a peer.
  //
  // It needs a hand-written entry only because its staking program predates the
  // registry: every other resident carries a `stakePool`, while TOWELI's is
  // TEGRIDY_STAKING_ADDRESS in constants.ts (the ladder the classic farm reads).
  // Same shape, same lock terms, different place of declaration.
  const toweli = BUNGALOWS.find((b) => b.id === DEFAULT_BUNGALOW_ID);
  if (toweli && isDeployed(TEGRIDY_STAKING_ADDRESS)) {
    rows.push({
      id: toweli.id,
      symbol: toweli.symbol,
      name: toweli.name,
      chain: toweli.chain,
      accent: toweli.accent,
      terms: poolShape('ladder', toweli.chain),
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
          room to see its live rate, its reward balance and what your position is worth — those
          numbers are read on chain there, where a failed read can say so.
        </p>
      </div>

      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[520px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-white/50">
                <th scope="col" className="font-semibold px-4 py-3">Pool</th>
                <th scope="col" className="font-semibold px-4 py-3">Chain</th>
                <th scope="col" className="font-semibold px-4 py-3">Terms</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <th scope="row" className="px-4 py-3.5 font-normal">
                    <span className="flex items-center gap-2.5">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: b.accent ?? 'var(--color-kyle)' }}
                        aria-hidden="true"
                      />
                      <span className="text-white text-[14px] font-semibold">{b.symbol}</span>
                      <span className="text-white/45 text-[12px]">{b.name}</span>
                    </span>
                  </th>
                  <td className="px-4 py-3.5 text-white/75 text-[13px]">{CHAIN_LABEL[b.chain] ?? b.chain}</td>
                  <td className="px-4 py-3.5 text-white/60 text-[12.5px]">{b.terms}</td>
                  <td className="px-4 py-3.5 text-right">
                    {/* Entering a bungalow RE-SKINS the app and resolves at module
                        scope, so it is persist + reload — the same mechanism every
                        door uses (bungalows.ts). A client-side <Link> would land on
                        /farm still wearing the venue's skin and render this index
                        again, which is a dead click. */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveBungalow(b.id);
                        window.location.assign('/farm');
                      }}
                      className="inline-flex items-center justify-center whitespace-nowrap px-3.5 py-2 min-h-[36px] rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110"
                      style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)' }}
                    >
                      Open {b.symbol}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-2.5 text-[11.5px] text-white/50 leading-relaxed">
        No rate is shown here because none is read here. Twelve pools across three chains would be
        twelve calls before this list could draw, and a call that does not answer renders as a zero
        — which would read as &ldquo;empty, pays nothing&rdquo; about a pool that may be neither.
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
