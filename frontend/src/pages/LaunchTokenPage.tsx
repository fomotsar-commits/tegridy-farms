import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { usePublicClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { ArtImg } from '../components/ArtImg';
import { shortenAddress, formatTimeAgo } from '../lib/formatting';
import { collectTokenFacts, viemChainReader } from '../lib/launcher/collector';
import { buildFactSheet } from '../lib/launcher/gate';
import type { LaunchFactSheet } from '../lib/launcher/factSheet';
import { readMigrationStream, lockResolverFor } from '../lib/launcher/lockerStream';
import { NATIVE_ETH } from '../lib/launcher/airlock';
import { DOPPLER_MAINNET } from '../lib/launcher/doppler.constants';
import { TOWELI_NUMERAIRE } from '../lib/launcher/config';
import {
  factSheetSchemaUid,
  readFactSheetAttestations,
  type AttestationLookup,
} from '../lib/launcher/attestation';
import { CHAIN_ID } from '../lib/constants';
import {
  clipMessage as clip,
  parseTokenParam,
  readAirlockAssetData,
  readTokenPresence,
  classifyProvenance,
  classifyGraduation,
  unverifiedGateChecks,
  powersWereRead,
  type GraduationState,
  type Provenance,
  type TokenPresence,
} from '../lib/launcher/tokenDossier';

// TOKEN PERMALINK — the permanent page for one launched token, at /launch/:token.
//
// Before this existed a launch had nowhere to be linked to: the cohort Explorer rows
// were dead ends. Everything on this page is a READ, and the page's whole job is to
// keep three states apart — proven true, proven false, and not readable. The repo has
// shipped the failure mode twice (a market feed that priced a scam pool at
// "520607 ETH"; a "+10% NFT boost" banner no contract paid), so an unreadable value
// renders as unreadable here: never as 0, never as a clean bill of health, and never
// as an accusation. Classification lives in lib/launcher/tokenDossier.ts, where it is
// pure and unit-tested; this file is presentation.

interface Dossier {
  presence: TokenPresence;
  sheet: LaunchFactSheet;
  provenance: Provenance;
  graduation: GraduationState;
  observedAt: number;
  /** Method names whose read did not land — see RawTokenFacts.unreadFields. */
  unreadFields: readonly string[];
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: Dossier };

const ETHERSCAN = 'https://etherscan.io';

export default function LaunchTokenPage() {
  const { token: rawToken } = useParams();
  const parsed = parseTokenParam(rawToken);
  const address = parsed.ok ? parsed.address : null;
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  // The attestation lookup is loaded SEPARATELY, and deliberately so: it is the one
  // read that has to walk EAS logs, and on the public RPCs this app ships with it
  // fails slowly (verified in a real browser: ~15s across the fallback transports).
  // Awaiting it inline held the whole page on a spinner while every other read had
  // already landed. null = still in flight.
  const [attestation, setAttestation] = useState<AttestationLookup | null>(null);

  usePageTitle(
    address ? `Token ${shortenAddress(address, 6)}` : 'Token not found',
    address
      ? 'Everything this rail can prove about one token — provenance, disclosures, attestation and post-graduation state, with every unreadable value shown as unreadable.'
      : 'That token link does not point at a valid Ethereum address.',
  );

  const load = useCallback(async () => {
    if (!address) return;
    if (!publicClient) {
      setState({ phase: 'error', message: 'No RPC client is available right now.' });
      return;
    }
    setState({ phase: 'loading' });
    try {
      const now = Math.floor(Date.now() / 1000);
      const presence = await readTokenPresence(publicClient, address);
      const airlock = await readAirlockAssetData(publicClient, address);
      const provenance = classifyProvenance(airlock);

      // Read the locker against the pair the Airlock says this token launched
      // against, rather than assuming ETH. A zero numeraire IS native ETH.
      const numeraire = airlock.status === 'found' ? airlock.record.numeraire : NATIVE_ETH;
      const stream = await readMigrationStream(publicClient, address, numeraire);
      const graduation = classifyGraduation(stream);

      // The gate needs SOME lock value and every available one is `false` until the
      // locker read works, so honesty cannot come from what we feed it — it comes from
      // unverifiedGateChecks, which suppresses the gate's "Liquidity is not locked."
      // whenever graduation.locked is null. Passing the real resolver here only adds
      // the locker address once a graduated read exists.
      const raw = await collectTokenFacts(viemChainReader(publicClient), address, {
        chainId: DOPPLER_MAINNET.chainId,
        now,
        lockResolver: lockResolverFor(stream),
      });
      // feeConstitution is deliberately left empty: the launch-time split is a config
      // input we cannot prove for an arbitrary token, and the real one is only readable
      // from the locker after graduation.
      const sheet = buildFactSheet(raw);

      setState({
        phase: 'ready',
        data: { presence, sheet, provenance, graduation, observedAt: now, unreadFields: raw.unreadFields ?? [] },
      });
    } catch (e) {
      setState({
        phase: 'error',
        message: e instanceof Error ? e.message : 'The on-chain reads failed.',
      });
    }
  }, [address, publicClient]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!address || !publicClient) return;
    let cancelled = false;
    setAttestation(null);
    void readFactSheetAttestations(publicClient, address).then((r) => {
      if (!cancelled) setAttestation(r);
    });
    return () => {
      cancelled = true;
    };
  }, [address, publicClient]);

  if (!parsed.ok) return <NotFoundState reason={parsed.reason} raw={rawToken} />;

  return (
    <>
      <PageArtBackdrop pageId="launch-token" />
      <div className="relative z-10 max-w-[880px] mx-auto px-4 md:px-6 pt-8 pb-28 md:pb-16">
        <TokenHeader address={parsed.address} sheet={state.phase === 'ready' ? state.data.sheet : null} />

        {state.phase === 'loading' && (
          <div className="glass-card rounded-xl p-6 text-center">
            <p className="text-[13px] text-text-secondary animate-pulse">
              Reading this token on-chain — Airlock record, contract template, locker and attestations…
            </p>
          </div>
        )}

        {state.phase === 'error' && (
          <StateCard tone="danger" title="Couldn’t complete the read">
            <p className="break-words">{clip(state.message)}</p>
            <p className="mt-2 text-text-muted">
              Nothing below is shown because nothing was read. This is a failure of our read, not a
              finding about the token.
            </p>
            <button onClick={() => void load()} className="btn-secondary text-[12px] px-3 py-1.5 mt-3" type="button">
              Try again
            </button>
          </StateCard>
        )}

        {state.phase === 'ready' && (
          <DossierView address={parsed.address} d={state.data} attestation={attestation} />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function TokenHeader({ address, sheet }: { address: Address; sheet: LaunchFactSheet | null }) {
  // Name/symbol are rendered ONLY when they were actually read. An empty string is
  // what the collector returns for a token whose name() reverted.
  const name = sheet?.name?.trim() ? sheet.name.trim() : null;
  const symbol = sheet?.symbol?.trim() ? sheet.symbol.trim() : null;
  return (
    <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
      <p className="text-[11px] uppercase tracking-wider text-text-muted mb-2">
        <Link to="/launch" className="hover:text-text-secondary underline underline-offset-2">
          Launch rail
        </Link>{' '}
        · token record
      </p>
      <h1 className="heading-luxury text-2xl md:text-4xl text-text-primary tracking-tight mb-1 break-words">
        {name ?? 'Unnamed token'}
        {symbol && <span className="text-text-muted text-lg md:text-2xl ml-2">{symbol}</span>}
      </h1>
      <p className="font-mono text-[12px] md:text-[13px] text-text-secondary break-all">{address}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]">
        <a
          href={`${ETHERSCAN}/token/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          Etherscan
        </a>
        <Link to={`/scan?token=${address}`} className="text-text-muted hover:text-text-secondary underline underline-offset-2">
          Scan holders
        </Link>
        <a
          href={`https://easscan.org/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          Attestations on EAS
        </a>
      </div>
      {!name && (
        <p className="text-[11px] text-text-muted mt-2">
          This contract did not return a name or symbol, so none is shown. Nothing is substituted.
        </p>
      )}
    </m.div>
  );
}

function DossierView({
  address,
  d,
  attestation,
}: {
  address: Address;
  d: Dossier;
  attestation: AttestationLookup | null;
}) {
  if (d.presence === 'no-code') {
    return (
      <StateCard tone="warning" title="No contract at this address">
        <p>
          The address is well-formed but nothing is deployed at it on Ethereum mainnet, so there is
          no token here to describe.
        </p>
      </StateCard>
    );
  }
  return (
    <div className="space-y-4">
      {d.presence === 'unreadable' && (
        <StateCard tone="muted" title="Contract presence unverified">
          <p>
            We could not check whether a contract is deployed at this address. Everything below was
            still attempted, and each value states whether it was read.
          </p>
        </StateCard>
      )}

      <ProvenanceCard p={d.provenance} />
      <AttestationCard lookup={attestation} />
      <FactSheetSection sheet={d.sheet} graduation={d.graduation} unreadFields={d.unreadFields} />
      <GraduationCard g={d.graduation} />

      <footer className="pt-4 border-t border-white/10 text-text-muted text-[11px] leading-relaxed space-y-1">
        <p>
          Read from Ethereum mainnet at {new Date(d.observedAt * 1000).toLocaleString()} (
          {formatTimeAgo(d.observedAt)}). Facts are point-in-time and can change.
        </p>
        <p>
          This page is a machine-generated disclosure, not an endorsement, a safety rating, or an
          accusation. A tier reflects structural configuration only. Anything we could not read is
          labelled as unread rather than guessed.
        </p>
        <p className="break-words">
          Disclosure schema{' '}
          <a
            href={`https://easscan.org/schema/view/${factSheetSchemaUid()}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-secondary underline underline-offset-2 break-all"
          >
            {factSheetSchemaUid()}
          </a>{' '}
          · token <span className="font-mono">{shortenAddress(address, 6)}</span>
        </p>
      </footer>
    </div>
  );
}

const PROVENANCE_TONE: Record<Provenance['kind'], 'good' | 'muted' | 'unknown'> = {
  ours: 'good',
  'other-integrator': 'muted',
  'no-integrator': 'muted',
  'not-doppler': 'muted',
  unreadable: 'unknown',
};

function ProvenanceCard({ p }: { p: Provenance }) {
  const tone = PROVENANCE_TONE[p.kind];
  return (
    <section className="glass-card rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-[14px] font-semibold text-text-primary">Provenance</h2>
        <Pill tone={tone}>{p.label}</Pill>
      </div>
      <p className="text-[12.5px] text-text-secondary leading-relaxed mt-2 break-words">{p.detail}</p>
      <p className="text-[11px] text-text-muted mt-2">
        Read directly from Doppler’s Airlock record for this asset — the only place a launch’s
        integrator is recoverable. A token we did not launch is always said so plainly.
      </p>
    </section>
  );
}

function AttestationCard({ lookup }: { lookup: AttestationLookup | null }) {
  return (
    <section className="glass-card rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-[14px] font-semibold text-text-primary">Disclosure attestation</h2>
        <Pill
          tone={
            lookup == null
              ? 'muted'
              : lookup.status === 'attested'
                ? 'good'
                : lookup.status === 'none'
                  ? 'muted'
                  : 'unknown'
          }
        >
          {lookup == null
            ? 'Checking…'
            : lookup.status === 'attested'
              ? 'Attested'
              : lookup.status === 'none'
                ? 'No attestation'
                : 'Cannot verify'}
        </Pill>
      </div>

      {lookup == null && (
        <p className="text-[12.5px] text-text-secondary leading-relaxed mt-2 animate-pulse">
          Searching the Ethereum Attestation Service for a Fact Sheet attestation on this token. This
          can take a while, and can fail — either way it will say which.
        </p>
      )}

      {lookup?.status === 'attested' && (
        <ul className="mt-3 space-y-2">
          {lookup.attestations.map((a) => (
            <li key={a.uid} className="rounded-lg p-3" style={{ background: 'var(--color-bg-input)' }}>
              <p className="text-[12px] text-text-secondary break-all">
                Attested by <span className="font-mono text-text-primary">{a.attester}</span>
              </p>
              <p className="text-[11px] text-text-muted mt-1">
                {a.time != null
                  ? `Recorded ${new Date(a.time * 1000).toLocaleString()} (${formatTimeAgo(a.time)})`
                  : 'Timestamp could not be re-read from the EAS record.'}
                {' · '}
                {a.revoked == null ? 'revocation status unknown' : a.revoked ? 'REVOKED' : 'not revoked'}
              </p>
              <a
                href={`https://easscan.org/attestation/view/${a.uid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono text-text-muted hover:text-text-secondary underline underline-offset-2 break-all"
              >
                {a.uid}
              </a>
            </li>
          ))}
        </ul>
      )}

      {lookup?.status === 'none' && (
        <p className="text-[12.5px] text-text-secondary leading-relaxed mt-2">
          No attestation for this token exists under our disclosure schema. That is not a mark
          against the token — most tokens have never been attested, and an attestation is a
          timestamped disclosure, not a warranty.
        </p>
      )}

      {lookup?.status === 'unverifiable' && (
        <>
          <p className="text-[12.5px] text-text-secondary leading-relaxed mt-2">
            We could not determine whether this token has been attested. Ethereum mainnet has no EAS
            indexer contract, and the public RPCs this app uses refuse the full-history log query
            the lookup needs. Treat this as unknown — it says nothing either way about the token.
          </p>
          {/* Bounded: viem's error carries the entire JSON-RPC request body, which dumped a
              wall of hex onto the page. The leading sentence + URL is the diagnostic part. */}
          <p className="text-[11px] text-text-muted mt-2 break-words">Reason: {clip(lookup.reason)}</p>
          <p className="text-[11px] text-text-muted mt-2">
            You can check it yourself on the EAS explorer via the “Attestations on EAS” link above.
          </p>
        </>
      )}
    </section>
  );
}

function FactSheetSection({
  sheet,
  graduation,
  unreadFields,
}: {
  sheet: LaunchFactSheet;
  graduation: GraduationState;
  unreadFields: readonly string[];
}) {
  const unverified = unverifiedGateChecks(sheet.knownSafeTemplate, graduation, unreadFields);
  const powersRead = powersWereRead(sheet.knownSafeTemplate);
  const tierLabel =
    sheet.tier === 'none' ? 'Below listable bar' : sheet.tier === 'listable' ? 'COMMUNITY' : 'FLAGSHIP';

  return (
    <section className="glass-card rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-[14px] font-semibold text-text-primary">Launch Fact Sheet</h2>
        <Pill tone={sheet.tier === 'flagship' ? 'good' : sheet.tier === 'listable' ? 'info' : 'muted'}>
          {tierLabel}
        </Pill>
      </div>

      <ul className="mt-3 space-y-1.5">
        {sheet.gateChecks.map((c) => {
          const unknown = unverified[c.id];
          return (
            <li key={c.id} className="flex items-start gap-2 text-[12px]">
              <span
                aria-hidden="true"
                className="shrink-0 w-4 text-center"
                style={{
                  color: unknown
                    ? 'var(--color-text-muted)'
                    : c.passed
                      ? 'var(--color-success)'
                      : 'var(--color-warning)',
                }}
              >
                {unknown ? '?' : c.passed ? '✓' : '○'}
              </span>
              <span className={unknown ? 'text-text-muted leading-relaxed' : 'text-text-secondary leading-relaxed'}>
                {unknown ?? c.detail}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 pt-3 border-t border-white/10">
        <h3 className="text-[11px] uppercase tracking-wider text-text-muted mb-2">Residual powers</h3>
        {powersRead ? (
          <ul className="space-y-1.5">
            {sheet.residualPowers.map((rp) => (
              <li key={rp.power} className="flex items-start gap-2 text-[12px]">
                <span
                  aria-hidden="true"
                  className="shrink-0 w-4 text-center"
                  style={{ color: rp.present ? 'var(--color-warning)' : 'var(--color-text-muted)' }}
                >
                  {rp.present ? '!' : '·'}
                </span>
                <span className="text-text-secondary leading-relaxed">{rp.disclosure}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-text-muted leading-relaxed">
            Not enumerated. This contract is not the recognised Doppler template, so its mint,
            pause, blacklist, transfer-tax and upgrade powers were not inspected. Our gate treats
            that as disqualifying, but it is not evidence that any of those powers exist — read the
            contract on Etherscan before drawing a conclusion.
          </p>
        )}
      </div>

      {/* Art is additive page furniture, in the pattern sibling sections already use. */}
      <div className="mt-4 h-24 sm:h-28 rounded-lg overflow-hidden">
        <ArtImg pageId="launch-token" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
    </section>
  );
}

function GraduationCard({ g }: { g: GraduationState }) {
  const pair = g.numeraire.toLowerCase() === TOWELI_NUMERAIRE.toLowerCase() ? 'token / TOWELI' : 'token / ETH';
  return (
    <section className="glass-card rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-[14px] font-semibold text-text-primary">Post-graduation state</h2>
        <Pill tone={g.kind === 'graduated' ? 'good' : g.kind === 'not-graduated' ? 'muted' : 'unknown'}>
          {g.label}
        </Pill>
      </div>
      <p className="text-[12.5px] text-text-secondary leading-relaxed mt-2">{g.detail}</p>

      {g.kind === 'graduated' && (
        <p className="text-[11px] text-text-muted mt-2">
          Liquidity {g.locked ? 'locked' : 'not locked'}
          {g.unlockAt != null ? ` · unlocks ${new Date(g.unlockAt * 1000).toLocaleDateString()}` : ''}
        </p>
      )}

      {g.kind === 'graduated' && g.beneficiaries.length > 0 && (
        <div className="mt-3 rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
          {g.beneficiaries.map((b, i) => (
            <div
              key={`${b.beneficiary}-${i}`}
              className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]"
              style={i % 2 ? { background: 'var(--color-bg-input)' } : undefined}
            >
              <span className="font-mono text-text-secondary break-all">{b.beneficiary}</span>
              <span className="text-text-muted tabular-nums shrink-0">{b.shares.toString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* break-words, not break-all: break-all would hyphen-less-chop the prose too.
          The only long token here is the pool id, which PoolId already elides. */}
      <p className="text-[11px] text-text-muted mt-3 break-words">
        {pair} · derived migration pool <PoolId id={g.poolId} />
      </p>
    </section>
  );
}

function PoolId({ id }: { id: Hex }) {
  return <span className="font-mono">{id.slice(0, 10)}…{id.slice(-6)}</span>;
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

type PillTone = 'good' | 'info' | 'unknown' | 'muted';

const PILL_STYLE: Record<PillTone, { fg: string; bg: string; border: string }> = {
  good: { fg: '#7ee2a8', bg: 'rgba(45, 139, 78, 0.16)', border: 'rgba(126, 226, 168, 0.35)' },
  info: { fg: '#8ecbf5', bg: 'rgba(40, 110, 180, 0.16)', border: 'rgba(142, 203, 245, 0.35)' },
  unknown: { fg: '#f5d488', bg: 'rgba(200, 150, 40, 0.16)', border: 'rgba(245, 212, 136, 0.35)' },
  muted: { fg: 'rgba(255,255,255,0.62)', bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.16)' },
};

function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  const s = PILL_STYLE[tone];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold shrink-0"
      style={{ color: s.fg, background: s.bg, border: `1px solid ${s.border}` }}
    >
      {children}
    </span>
  );
}

function StateCard({
  tone,
  title,
  children,
}: {
  tone: 'warning' | 'danger' | 'muted';
  title: string;
  children: React.ReactNode;
}) {
  const color =
    tone === 'danger' ? 'var(--color-danger)' : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)';
  return (
    <div className="glass-card rounded-xl p-5" style={{ borderColor: color }}>
      <h2 className="text-[14px] font-semibold mb-1.5" style={{ color }}>
        {title}
      </h2>
      <div className="text-[12.5px] text-text-secondary">{children}</div>
    </div>
  );
}

function NotFoundState({ reason, raw }: { reason: string; raw?: string }) {
  return (
    <>
      <PageArtBackdrop pageId="launch-token" />
      <div className="relative z-10 max-w-[860px] mx-auto px-4 md:px-6 pt-8 pb-28 md:pb-16">
        <h1 className="heading-luxury text-2xl md:text-4xl text-text-primary tracking-tight mb-4">
          Token not found
        </h1>
        <StateCard tone="warning" title="That link doesn’t point at a token">
          <p>{reason}</p>
          {raw && (
            <p className="mt-2 font-mono text-[11px] text-text-muted break-all">
              Received: {raw.slice(0, 80)}
              {raw.length > 80 ? '…' : ''}
            </p>
          )}
          <p className="mt-3">
            <Link to="/launch" className="underline underline-offset-2 hover:text-text-primary">
              Back to the launch rail
            </Link>
          </p>
        </StateCard>
      </div>
    </>
  );
}
