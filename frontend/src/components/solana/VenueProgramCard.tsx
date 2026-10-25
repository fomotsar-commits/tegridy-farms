import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

const CARD = { background: 'rgba(4,9,18,0.90)', border: '1px solid var(--color-purple-25)' } as const;

/**
 * "The program": what the venue's Solana AMM is built from, and how a pool list is made.
 * The LP section's disclosure says to see it below, so it is the last section of both
 * tabs that mount that section (/pools and /solana-lp).
 */
export function VenueProgramCard() {
  return (
    <section className="relative isolate rounded-2xl p-6 mt-6" style={CARD} aria-label="The program">
      <CardArt pageId="venue-amm" idx={1} />
      <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>The program</p>
      {/* True of the program running today and of the source: both carry our authority constants. The
          additions are the source's alone until the upgrade, so the small print names them. */}
      <h2 className="heading-luxury text-lg text-white mb-3">Raydium&rsquo;s CPMM, with our keys</h2>
      <p className="text-white/80 text-[13px] leading-relaxed mb-1">
        A pinned fork of <strong>raydium-cp-swap</strong>; the trading maths are Raydium&rsquo;s.
      </p>
      <FinePrint summary="The program">
        <p>
          The AMM is a fork of <strong>raydium-cp-swap</strong>. CI clones the pinned
          upstream commit, refuses any differing file outside three, and sha256-hashes the
          remaining delta against a pinned value. That delta is four authority constants,
          the program&rsquo;s own name and contact text, comments, one added instruction and
          one added check. The instruction lets a pool&rsquo;s share token carry a name and a
          picture in wallets. Its caller chooses nothing: the name and the link are fixed in
          the program. It cannot move pool funds. Whoever calls it pays a small one-time fee
          for the record. The check keeps the launch fee tier for launches: opening a pool
          there the public way is refused, and a launch&rsquo;s graduation still opens its
          pool there.
          The curve, the swap, the deposit and withdraw paths and the fee maths are
          Raydium&rsquo;s, not ours, and the quotes on the swap page run that same maths
          client-side.
        </p>
        {/* True while mainnet runs the build from before the additions (again since the roll-back of
            2026-10-24). Delete it in the release that ships with the re-upgrade:
            src/test/poolProgramCopy.test.ts fails that release until you do. */}
        <p>
          The program on Solana today was built before that instruction and that check were added. It
          gets them only through a program upgrade.
        </p>
        <p>
          A browser cannot list pools itself: <code className="font-mono">getProgramAccounts</code> stays
          off our RPC proxy&rsquo;s allowlist as an unbounded scan. Our server runs that one scan,
          filtered to pools holding the token you look up, and returns addresses only; this page
          then reads and checks every one of those pools on chain itself.
        </p>
      </FinePrint>
    </section>
  );
}
