// Polyfill MUST load before any @solana/* import — keep this the very first
// import in this lazy chunk's entry (mirrors SolanaSwapPage).
import '../lib/solanaPolyfill';
import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Keypair } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import { SOL_MINT, USDC_MINT } from '../lib/solana';
import {
  isSolanaLauncherEnabled,
  asSquadsVault,
  buildDbcPartnerConfig,
  buildLaunchParams,
  DEFAULT_ANTI_SNIPE,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  METEORA_PROTOCOL_FEE_PERCENT,
  MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT,
  type DbcPartnerConfig,
  type DbcLaunchParams,
} from '../lib/launcher/solana/dbc';

// The Solana leg is a fee-capture SUB-BRAND, deliberately separate from the EVM
// flagship launcher. This page is GATED: while isSolanaLauncherEnabled() is false
// it renders the standard "SOON" placeholder and never mounts the wizard, so no
// submit path exists. Behind the gate it PREVIEWS the descriptors the pure
// builders emit (fee split, anti-snipe decay, LP lock) — it does NOT submit;
// submission is the operator's out-of-band signing wrapper (dbcClient.ts), and
// only once the flag is flipped AND a real Squads v4 vault is verified on-chain.

interface PreviewInputs {
  name: string;
  symbol: string;
  uri: string;
  quote: 'SOL' | 'USDC';
  initialMarketCap: string;
  migrationMarketCap: string;
  vaultAddress: string;
  payer: string;
}

type PreviewResult =
  | { ok: true; config: DbcPartnerConfig; launch: DbcLaunchParams }
  | { ok: false; error: string };

function buildPreview(input: PreviewInputs, configPubkey: string, baseMintPubkey: string): PreviewResult {
  try {
    const quoteMint = input.quote === 'USDC' ? USDC_MINT : SOL_MINT;
    const vault = asSquadsVault(input.vaultAddress);
    const config = buildDbcPartnerConfig({
      feeClaimer: vault,
      config: configPubkey,
      payer: input.payer,
      quoteMint,
      initialMarketCap: Number(input.initialMarketCap),
      migrationMarketCap: Number(input.migrationMarketCap),
    });
    const launch = buildLaunchParams(
      { config: configPubkey, baseMint: baseMintPubkey, poolCreator: input.payer, payer: input.payer },
      { name: input.name, symbol: input.symbol, uri: input.uri },
    );
    return { ok: true, config, launch };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block mb-3">
      <span className="text-white text-[11px] block mb-1.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
        {label}
      </span>
      {children}
      {hint && <span className="text-white/40 text-[10px] block mt-1">{hint}</span>}
    </label>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[13px] outline-none';
const inputStyle = { border: '1px solid rgba(255,255,255,0.18)' } as const;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-white/75">
      <span>{label}</span>
      <span className="font-mono text-right truncate ml-2">{value}</span>
    </div>
  );
}

function FactSheetPreview({ config }: { config: DbcPartnerConfig }) {
  const endingBps = DEFAULT_ANTI_SNIPE.endingFeeBps;
  // feeSplit bps are out of the resting (ending) fee — normalize to % of the fee.
  const pct = (bps: number) => (endingBps > 0 ? ((bps / endingBps) * 100).toFixed(0) : '0');
  const s = config.feeSplit;
  const startPct = (DEFAULT_ANTI_SNIPE.startingFeeBps / 100).toFixed(0);
  const endPct = (endingBps / 100).toFixed(2);
  const hours = (DEFAULT_ANTI_SNIPE.totalDuration / 3600).toFixed(0);
  return (
    <div className="mt-4 rounded-xl p-3.5 text-[11px] space-y-2.5" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <p className="text-white/50 text-[10px] uppercase tracking-wide">Fact Sheet (preview)</p>

      <div className="space-y-1">
        <p className="text-white/60 text-[10px]">Trading-fee split (of each trade fee)</p>
        <Row label={`Meteora protocol (fixed ${METEORA_PROTOCOL_FEE_PERCENT}%)`} value={`${pct(s.meteoraBps)}%`} />
        <Row label="Creator" value={`${pct(s.creatorBps)}%`} />
        <Row label="Tegridy partner vault" value={`${pct(s.partnerBps)}%`} />
      </div>

      <div className="space-y-1 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-white/60 text-[10px]">Anti-snipe fee schedule</p>
        <Row label="Opening fee" value={`${startPct}%`} />
        <Row label="Resting fee" value={`${endPct}%`} />
        <Row label="Decay window" value={`${hours}h ${DEFAULT_ANTI_SNIPE.mode ?? 'exponential'}`} />
      </div>

      <div className="space-y-1 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-white/60 text-[10px]">Migrated liquidity</p>
        <Row
          label="Permanently locked"
          value={`${config.curve.liquidityDistribution.partnerPermanentLockedLiquidityPercentage + config.curve.liquidityDistribution.creatorPermanentLockedLiquidityPercentage}%`}
        />
        <p className="text-white/40 text-[10px]">
          At least {MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT}% of migrated LP is locked; locked-LP fees stream to the vault.
        </p>
      </div>
    </div>
  );
}

function SolanaLaunchInner() {
  const { publicKey, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  // Fresh ephemeral keys for the PREVIEW only — the operator generates the real
  // config / base-mint keypairs in the signing wrapper. Stable across renders.
  const [configPubkey] = useState(() => Keypair.generate().publicKey.toBase58());
  const [baseMintPubkey] = useState(() => Keypair.generate().publicKey.toBase58());
  // A stand-in payer used only so the preview builders validate when no wallet is
  // connected; replaced by the connected wallet address when available.
  const [previewPayer] = useState(() => Keypair.generate().publicKey.toBase58());

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [uri, setUri] = useState('');
  const [quote, setQuote] = useState<'SOL' | 'USDC'>('SOL');
  const [initialMarketCap, setInitialMarketCap] = useState('5000');
  const [migrationMarketCap, setMigrationMarketCap] = useState('50000');
  const [vaultAddress, setVaultAddress] = useState('');

  const payer = publicKey?.toBase58() ?? previewPayer;

  const preview = useMemo(
    () =>
      buildPreview(
        { name, symbol, uri, quote, initialMarketCap, migrationMarketCap, vaultAddress, payer },
        configPubkey,
        baseMintPubkey,
      ),
    [name, symbol, uri, quote, initialMarketCap, migrationMarketCap, vaultAddress, payer, configPubkey, baseMintPubkey],
  );

  return (
    <>
      <PageArtBackdrop pageId="solana-launch" />
      <div className="relative z-10 max-w-md mx-auto px-4 py-8">
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-5 relative overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.12)' }}
      >
        <div className="absolute inset-0">
          <ArtImg pageId="launch" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" style={{ filter: 'blur(1.5px) saturate(1.05)' }} />
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.5)' }} />
        </div>

        <div className="relative z-10" style={{ textShadow: '0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)' }}>
          <div className="flex items-center justify-between mb-1">
            <h1 className="heading-luxury text-[18px] text-white">Solana Launch</h1>
            <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              PREVIEW
            </span>
          </div>
          <p className="text-white/60 text-[11px] mb-4">
            Fee-capture sub-brand over Meteora&apos;s Dynamic Bonding Curve. This is a configuration preview — nothing is
            signed or submitted here.
          </p>

          <Field label="Token name">
            {/* Neutral placeholders: this rail launches OTHER people's tokens.
                Tegridy-branded examples read as "Tegridy is launching its own
                Solana coin", which is exactly the impression the fee-capture-only
                doctrine exists to avoid (no TOWELI on Solana, ever). */}
            <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your token name" spellCheck={false} maxLength={64} />
          </Field>
          <Field label="Symbol">
            <input className={inputCls} style={inputStyle} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="TICKER" spellCheck={false} maxLength={12} />
          </Field>
          <Field label="Metadata URI" hint="ipfs:// or https:// pointing at the token metadata JSON.">
            <input className={inputCls} style={inputStyle} value={uri} onChange={(e) => setUri(e.target.value)} placeholder="ipfs://…" spellCheck={false} />
          </Field>

          <Field label="Quote token">
            <div className="flex gap-1.5">
              {(['SOL', 'USDC'] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setQuote(q)}
                  aria-pressed={quote === q}
                  className="flex-1 py-1.5 rounded-lg text-[12px] font-medium text-white transition-colors"
                  style={{
                    background: quote === q ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                    border: quote === q ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={`Initial market cap (${quote})`}>
              <input className={inputCls} style={inputStyle} type="number" inputMode="decimal" value={initialMarketCap} onChange={(e) => setInitialMarketCap(e.target.value)} min={0} />
            </Field>
            <Field label={`Migration market cap (${quote})`}>
              <input className={inputCls} style={inputStyle} type="number" inputMode="decimal" value={migrationMarketCap} onChange={(e) => setMigrationMarketCap(e.target.value)} min={0} />
            </Field>
          </div>

          <Field
            label="Fee vault (Squads v4)"
            hint="The partner fee authority. Must be a Squads v4 multisig vault — verified on-chain before any real launch, never an EOA."
          >
            <input className={inputCls} style={inputStyle} value={vaultAddress} onChange={(e) => setVaultAddress(e.target.value)} placeholder="Squads vault address" spellCheck={false} />
          </Field>

          {!publicKey && (
            <button type="button" onClick={() => setVisible(true)} disabled={connecting} className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60 mb-1">
              {connecting ? 'Connecting…' : 'Connect Solana Wallet'}
            </button>
          )}

          {preview.ok ? (
            <FactSheetPreview config={preview.config} />
          ) : (
            <p className="mt-3 text-amber-300 text-[11px]">{vaultAddress || name || symbol || uri ? preview.error : 'Fill in the fields above to preview the Fact Sheet.'}</p>
          )}

          <p className="mt-4 text-center text-white/40 text-[10px] leading-relaxed">
            Solana leg is fee-capture only — no TOWELI on Solana, no custom program. Launch parameters are disclosed, not a
            hidden dial. Submission stays disabled until the launcher is enabled and a Squads vault is verified.
          </p>
        </div>
      </m.div>
      </div>
    </>
  );
}

function ExplainerCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-5"
      style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
    >
      <h2 className="text-white font-semibold text-[13px] mb-2">{title}</h2>
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

/**
 * Pre-launch explainer — rendered ONLY in the gated (not-live) branch, BENEATH the
 * SOON wall, mirroring LaunchPage.tsx's LauncherExplainer.
 *
 * Every claim is grounded in shipped code/docs, and every number is READ from dbc.ts
 * (program id, Meteora's protocol take, the anti-snipe defaults, the LP-lock floor) so
 * this copy cannot drift from the builders that actually run. Nothing here names a
 * date, quotes a metric, or implies a launch has happened — while SOLANA_LAUNCHER_ENABLED
 * is false the submit path does not exist (dbcClient.ts throws on every entry point).
 */
function SolanaLauncherExplainer() {
  const openPct = (DEFAULT_ANTI_SNIPE.startingFeeBps / 100).toFixed(0);
  const restPct = (DEFAULT_ANTI_SNIPE.endingFeeBps / 100).toFixed(2);
  const decayHours = (DEFAULT_ANTI_SNIPE.totalDuration / 3600).toFixed(0);
  return (
    <div className="mt-8 space-y-4">
      <ExplainerCard title="What the Solana rail is — and is not">
        <p>
          A separate, fee-capture sub-brand: a rail for launching{' '}
          <span className="text-white/80">other people&apos;s</span> tokens on Solana through Meteora&apos;s Dynamic
          Bonding Curve. Tegridy&apos;s only position in a launch is the partner fee claimer.
        </p>
        <p>
          <span className="text-white/80">TOWELI is never deployed on Solana</span>, and there is no Tegridy AMM here.
          Solana is fee capture only. Graduated liquidity migrates into Meteora&apos;s own DAMM v2 pool, not into
          anything we run.
        </p>
        <p className="text-white/40">
          It is deliberately a sub-brand, kept separate from the Ethereum flagship launcher so the two do not share a
          reputation.
        </p>
      </ExplainerCard>

      <ExplainerCard title="The token contract is Meteora's, not ours">
        <p>
          We deploy no custom Solana program of our own. Every launch runs against Meteora&apos;s audited Dynamic
          Bonding Curve program, integrated through its published SDK:
        </p>
        <p className="font-mono text-[10px] text-white/50 break-all">{DYNAMIC_BONDING_CURVE_PROGRAM_ID}</p>
        <p>
          The curve pins an immutable SPL token — no mint authority and no update authority — with trading fees
          collected in the quote token, either SOL or USDC.
        </p>
      </ExplainerCard>

      <ExplainerCard title="Fees are published, not a hidden dial">
        <ul className="list-disc pl-4 space-y-1">
          <li>
            Meteora takes a fixed {METEORA_PROTOCOL_FEE_PERCENT}% of every trade fee. The remainder is split between
            the launching creator and the Tegridy partner vault, creator-majority by default.
          </li>
          <li>
            Launches open with a decaying anti-snipe fee — {openPct}% at open, decaying to a {restPct}% resting fee
            over {decayHours} hours — so buying in block 0 is unprofitable.
          </li>
          <li>
            At least {MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT}% of migrated liquidity is permanently locked; the
            default configuration locks the whole partner side, and those locked-LP fees stream to the vault.
          </li>
        </ul>
        <p className="text-white/40">
          Whatever a launch is configured with is surfaced in its Fact Sheet rather than left implicit. These are the
          defaults the builders emit today — not a quote of any past launch, because there have been none.
        </p>
      </ExplainerCard>

      <ExplainerCard title="What has to exist before this opens">
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="text-white/80">A Squads v4 multisig vault.</span> Meteora&apos;s fee-claim signer has full
            custody of accrued fees and can name any receiver on each claim, so the fee claimer must be a multisig
            vault and never a single key. The builders refuse to produce a config or a claim otherwise.
          </li>
          <li>
            <span className="text-white/80">On-chain verification of that vault.</span> The operator supplies the
            vault&apos;s provenance — its parent multisig and vault index — and the signing wrapper re-derives the
            canonical vault address and confirms the parent is a genuine Squads account before building any
            transaction. A mismatch fails closed.
          </li>
          <li>
            <span className="text-white/80">A signing threshold confirmed out of band.</span> That on-chain check
            proves the vault&apos;s derivation, not its threshold; that the multisig genuinely requires more than one
            signer is verified with Squads&apos; own tooling before the flag is flipped.
          </li>
          <li>
            <span className="text-white/80">Sequencing.</span> Solana is a later phase, deliberately behind the
            Ethereum rail — it opens only once that one shows real activity. We are not naming a date.
          </li>
        </ul>
      </ExplainerCard>

      <p className="text-center text-white/40 text-[10px] leading-relaxed px-2">
        Nothing here is live. While the launcher is gated there is no submit path — the operator tooling itself
        refuses to build a transaction.
      </p>
    </div>
  );
}

export default function SolanaLaunchPage() {
  usePageTitle('Solana Launch', 'Preview the Tegridy Solana fee-capture launch config (Meteora DBC).');
  useEffect(() => {
    trackPageView('solana-launch');
  }, []);

  if (!isSolanaLauncherEnabled()) {
    return (
      <div className="max-w-md mx-auto px-4 py-10">
        <FeatureNotDeployed
          pageId="launch"
          idx={0}
          title="Solana launch isn't live yet"
          subtitle="A fee-capture sub-brand launcher over Meteora's Dynamic Bonding Curve — disclosed fees, anti-snipe schedule, locked liquidity. Coming soon."
        />
        {/* Pre-launch explainer. Rendered only in the gated state, BENEATH the SOON
            wall (which stays exactly as-is), so /solana-launch teaches the rail instead
            of being a bare placeholder. Mirrors LaunchPage's LauncherExplainer. No
            dates, no metrics, no simulated activity — and it states plainly that this
            rail launches OTHER people's tokens: TOWELI is never deployed on Solana. */}
        <SolanaLauncherExplainer />
        {/* Reciprocal cross-link back to the EVM flagship rail. Also gated
            (LAUNCHER_ENABLED = false in lib/launcher/config.ts), so keep it secondary. */}
        <p className="text-white/40 text-xs leading-relaxed mt-6 text-center">
          The flagship rail is on Ethereum mainnet, built on Doppler V4. It is gated as well.{' '}
          <Link to="/launch" className="text-white/60 hover:text-white underline transition-colors">
            See the mainnet rail
          </Link>
        </p>
      </div>
    );
  }

  return (
    <SolanaProviders>
      <SolanaLaunchInner />
    </SolanaProviders>
  );
}
