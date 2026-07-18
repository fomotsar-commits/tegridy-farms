// Polyfill MUST load before any @solana/* import — keep this the very first
// import in this lazy chunk's entry (mirrors SolanaSwapPage).
import '../lib/solanaPolyfill';
import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { Keypair } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import { SOL_MINT, USDC_MINT } from '../lib/solana';
import {
  isSolanaLauncherEnabled,
  asSquadsVault,
  buildDbcPartnerConfig,
  buildLaunchParams,
  DEFAULT_ANTI_SNIPE,
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
    <div className="max-w-md mx-auto px-4 py-8">
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-5 relative overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.12)' }}
      >
        <div className="absolute inset-0">
          <ArtImg pageId="launch" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.88)' }} />
        </div>

        <div className="relative z-10">
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
            <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tegridy Meme" spellCheck={false} maxLength={64} />
          </Field>
          <Field label="Symbol">
            <input className={inputCls} style={inputStyle} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="TMEME" spellCheck={false} maxLength={12} />
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
      </div>
    );
  }

  return (
    <SolanaProviders>
      <SolanaLaunchInner />
    </SolanaProviders>
  );
}
