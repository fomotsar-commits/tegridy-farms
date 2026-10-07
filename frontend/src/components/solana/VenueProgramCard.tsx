const CARD = { background: 'rgba(4,9,18,0.90)', border: '1px solid var(--color-purple-25)' } as const;

/**
 * "The program": what the venue's Solana AMM is built from, and how a pool list is made.
 * The LP section's disclosure says to see it below, so it is the last section of both
 * tabs that mount that section (/pools and /solana-lp).
 */
export function VenueProgramCard() {
  return (
    <section className="rounded-2xl p-6 mt-6" style={CARD} aria-label="The program">
      <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>The program</p>
      <h2 className="heading-luxury text-lg text-white mb-3">Raydium&rsquo;s CPMM, with one addition</h2>
      <p className="text-white/80 text-[13px] leading-relaxed mb-3">
        The AMM is a fork of <strong>raydium-cp-swap</strong>. CI clones the pinned
        upstream commit, refuses any differing file outside two, and sha256-hashes the
        remaining delta against a pinned value. That delta is four authority constants,
        comments and one added instruction, which lets a pool&rsquo;s share token carry a
        name and a picture in wallets. It takes nothing from its caller and moves no funds.
        The curve, the swap, the deposit and withdraw paths and the fee maths are
        Raydium&rsquo;s, not ours, and the quotes on the swap page run that same maths
        client-side.
      </p>
      {/* True until the pool program is upgraded on mainnet. Delete this paragraph in the same release as that upgrade. */}
      <p className="text-white/50 text-[12px] leading-relaxed mb-3">
        The program on Solana today was built before that instruction was added. It gets it
        only through a program upgrade.
      </p>
      <p className="text-white/50 text-[12px] leading-relaxed">
        A browser cannot list pools itself: <code className="font-mono">getProgramAccounts</code> stays
        off our RPC proxy&rsquo;s allowlist as an unbounded scan. Our server runs that one scan,
        filtered to pools holding the token you look up, and returns addresses only; this page
        then reads and checks every one of those pools on chain itself.
      </p>
    </section>
  );
}
