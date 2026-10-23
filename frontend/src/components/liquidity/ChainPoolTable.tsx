import { formatUnits } from 'viem';
import { useVenuePairs, type VenuePair, type VenuePairToken } from '../../hooks/useVenuePairs';
import { liquidityVenueOn } from '../../lib/chains/liquidityVenue';
import { DEFAULT_TOKENS, defaultTokensFor, type TokenInfo } from '../../lib/tokenList';
import { formatTokenAmountGrouped, shortenAddress } from '../../lib/formatting';
import { getAddressUrl } from '../../lib/explorer';
import type { LiquidityPick } from '../swap/LiquidityTab';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

const ETH = DEFAULT_TOKENS.find((t) => t.symbol === 'ETH')!;

interface Side {
  readonly label: string;
  readonly logo: string;
  readonly reserve: string;
  /** Null: the form cannot open on this token. */
  readonly form: TokenInfo | null;
  /** Over 18 decimals, which the form refuses (as its token picker does). */
  readonly unsupported: boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * One token as the row and the form name it. The pair holds WETH, which the form deposits as
 * ETH. A listed token keeps its listed name. Any other symbol is the token's own word, so one
 * that is not plain ASCII, or that copies a listed name, is shown as its address instead.
 */
function sideOf(chainId: number, weth: string, t: VenuePairToken | null, reserve: bigint | null): Side {
  if (!t) return { label: 'not read', logo: '', reserve: '–', form: null, unsupported: false };
  const listed = same(t.address, weth) ? ETH : defaultTokensFor(chainId).find((l) => same(l.address, t.address));
  const raw = t.symbol?.trim() ?? '';
  const taken = [ETH, ...defaultTokensFor(chainId)].some((l) => same(l.symbol, raw));
  const label = listed?.symbol
    ?? (/^[\x20-\x7E]{1,32}$/.test(raw) && !taken ? raw.slice(0, 12) : shortenAddress(t.address));
  const amount = reserve === null || t.decimals === null ? '–' : formatTokenAmountGrouped(formatUnits(reserve, t.decimals), 4);
  const unsupported = !listed && t.decimals !== null && t.decimals > 18;
  const form = listed
    ?? (t.decimals === null || unsupported ? null : { address: t.address, symbol: label, name: label, decimals: t.decimals, logoURI: '' });
  return { label, logo: listed?.logoURI ?? '', reserve: amount, form, unsupported };
}

/** What a provider keeps of the 0.3% fee, as this pool's kLast says. */
function splitOf(kLast: bigint | null): string {
  if (kLast === null) return '0.3% fee, split not read';
  return kLast === 0n ? '0.3% fee, all to providers' : '0.3% fee: 0.25% to providers';
}

function Logo({ src, label }: { src: string; label: string }) {
  return src ? (
    <img src={src} alt="" className="w-7 h-7 rounded-full object-cover" style={{ border: '2px solid var(--color-purple-30)' }} />
  ) : (
    <span aria-hidden="true" className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white"
      style={{ background: 'var(--color-purple-75)', border: '2px solid var(--color-purple-30)' }}>
      {label.charAt(0)}
    </span>
  );
}

function Row({ chainId, weth, pair, onPick }: { chainId: number; weth: string; pair: VenuePair; onPick: (p: LiquidityPick) => void }) {
  const s0 = sideOf(chainId, weth, pair.token0, pair.reserve0);
  const s1 = sideOf(chainId, weth, pair.token1, pair.reserve1);
  const ethAt = pair.token0 && same(pair.token0.address, weth) ? 0 : pair.token1 && same(pair.token1.address, weth) ? 1 : -1;
  // ETH second, as the Ethereum table names TOWELI / ETH; the form keeps ETH as its token A.
  const [base, quote] = ethAt === 0 ? [s1, s0] : [s0, s1];
  const [a, b] = ethAt === -1 ? [base, quote] : [quote, base];
  const formA = a.form;
  const formB = b.form;

  return (
    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <th scope="row" className="pl-4 pr-2 sm:pr-4 py-3.5 font-normal">
        {pair.address ? (
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2 flex-shrink-0">
              <Logo src={base.logo} label={base.label} />
              <Logo src={quote.logo} label={quote.label} />
            </div>
            <span className="min-w-0">
              <span className="block text-white text-[14px] font-semibold whitespace-nowrap">
                {base.label} / {quote.label}
              </span>
              <span className="block text-white/50 text-[11px] whitespace-nowrap">{splitOf(pair.kLast)}</span>
              {/* Below 640px the Reserves column is hidden; its two figures ride here. */}
              <span className="sm:hidden block mt-1 text-white/80 text-[12px] tabular-nums">
                <span className="block whitespace-nowrap">{base.reserve} {base.label}</span>
                <span className="block whitespace-nowrap">{quote.reserve} {quote.label}</span>
              </span>
              <a href={getAddressUrl(chainId, pair.address)} target="_blank" rel="noopener noreferrer"
                className="block mt-0.5 text-white/50 text-[11px] underline underline-offset-2 hover:text-white">
                {shortenAddress(pair.address)}
              </a>
            </span>
          </div>
        ) : (
          <span className="text-white/70 text-[13px]">Pool {pair.index + 1}: could not read</span>
        )}
      </th>
      <td className="hidden sm:table-cell px-4 py-3.5 text-right text-white text-[13px] tabular-nums">
        <span className="block whitespace-nowrap">{base.reserve} {base.label}</span>
        <span className="block whitespace-nowrap text-white/80">{quote.reserve} {quote.label}</span>
      </td>
      <td className="pl-2 pr-4 sm:pl-4 py-3.5 text-right">
        {pair.address && formA && formB ? (
          <span className="inline-flex flex-col sm:flex-row gap-1.5">
            {(['add', 'remove'] as const).map((mode) => (
              <a key={mode} href="#provide" onClick={() => onPick({ chainId, a: formA, b: formB, mode })}
                className="inline-flex items-center justify-center whitespace-nowrap px-3 py-2 min-h-[36px] rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110"
                style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)' }}>
                {mode === 'add' ? 'Add' : 'Remove'}
              </a>
            ))}
          </span>
        ) : (
          <span className="text-white/50 text-[11.5px]">{s0.unsupported || s1.unsupported ? 'not supported' : 'not read'}</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The pools in this chain's own factory, read live. "No pools yet" only when allPairsLength()
 * answered 0; a factory that did not answer says so. Add and Remove open the form below on
 * that pair, on this chain only.
 */
export function ChainPoolTable({ chainId, onPick }: { chainId: number; onPick: (p: LiquidityPick) => void }) {
  const venue = liquidityVenueOn(chainId);
  const read = useVenuePairs(chainId);
  const name = venue?.name ?? 'this network';

  return (
    <section aria-labelledby="chain-pools-heading" className="mb-8" data-testid="chain-pools">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 id="chain-pools-heading" className="text-white text-lg font-semibold">Pools</h2>
        <a href="#provide" className="text-[12.5px] underline underline-offset-2 text-white/70 hover:text-white">
          Seed a new pair ↓
        </a>
      </div>

      <div className="relative isolate rounded-2xl overflow-hidden"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}>
        <CardArt pageId="liquidity" idx={1} />
        {read.status === 'listed' && venue ? (
          <div className="relative overflow-x-auto">
            <table className="w-full text-left border-collapse sm:min-w-[520px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-white/50">
                  <th scope="col" className="font-semibold px-4 py-3">Pool</th>
                  <th scope="col" className="hidden sm:table-cell font-semibold px-4 py-3 text-right">Reserves</th>
                  <th scope="col" className="font-semibold px-4 py-3 text-right"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {read.pairs.map((pair) => (
                  <Row key={pair.index} chainId={chainId} weth={venue.weth} pair={pair} onPick={onPick} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="relative px-4 py-5 text-[14px] text-white/80" role={read.status === 'unread' ? 'alert' : 'status'}>
            {read.status === 'loading' && `Reading ${name} pools…`}
            {read.status === 'unread' && `Could not read ${name} pools. Reload to try again.`}
            {read.status === 'empty' && 'No pools yet. The first deposit below creates one.'}
          </p>
        )}
      </div>

      {read.status === 'listed' && (
        <p className="mt-2.5 text-[11.5px] text-white/50 leading-relaxed">
          {read.total > read.pairs.length && `The first ${read.pairs.length} of ${read.total} pools. `}
          A dash: not read, never zero.
        </p>
      )}

      <FinePrint summary="Details">
        <p>
          Read live from {name}&apos;s pool factory, the venue&apos;s own contract. Anyone can open a pool
          here, so a name is what its token calls itself; a name that copies a listed token shows its
          address instead. Check the pool&apos;s address before you add.
        </p>
        <p>
          Every pool charges 0.3% on each swap, split by pool share. The venue&apos;s one-sixth cut (0.05%)
          is off until it is switched on for that pool; then it goes to the venue&apos;s fee Safe as new
          pool shares.
        </p>
      </FinePrint>
    </section>
  );
}
