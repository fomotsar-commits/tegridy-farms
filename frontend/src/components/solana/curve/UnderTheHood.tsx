import { Component, useState, type ReactNode } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { FinePrint } from '../../ui/FinePrint';
import type { PreparedTx, SolanaCluster, TxViewApi } from './ports';
import { Row } from './ui';
import { REVIEW_TTL_MS } from './useTxFlow';
import {
  SOLANA_TX_BYTES,
  decodedSteps,
  grouped,
  poolCoins,
  legAmount,
  logCutShort,
  programName,
  siteAndNetwork,
  stepText,
  unitLimit,
  unsignedBase64,
  utcTime,
  writtenAccounts,
  type Leg,
  type SiteAndNetwork,
} from './signingFacts';

// Under every review: this site's figures beside the network's test run, then the fold
// "What you are signing". Both are drawn from the prepared transaction alone and sit outside
// TxReview, so they are not review lines (reviewLines.ts) and never decide whether Sign opens
// the wallet. A part that cannot be drawn says so, and the review and its Sign stay as they are.

/** A part that throws while drawing is replaced by one line; the review around it keeps working. */
class Guard extends Component<{ fallback: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p className="text-white/40 text-[11px]">{this.props.fallback}</p> : this.props.children;
  }
}

function legsLine(legs: Leg[], side: 'site' | 'network'): string {
  return legs
    .map((l) => {
      const v = l[side];
      return v === null ? `${l.name}: none reported` : legAmount(v, l);
    })
    .join(' and ');
}

function agreementText(c: SiteAndNetwork): string | null {
  if (c.unread) return null;
  const missing = c.legs.filter((l) => l.network === null).map((l) => l.name);
  if (missing.length > 0) return `Not compared: the test run reported no account of yours for ${missing.join(' or ')}.`;
  const off = c.legs.filter((l) => l.network !== l.site);
  if (off.length === 0) return 'They agree, to the last unit.';
  const by = off.map((l) => legAmount(l.site > l.network! ? l.site - l.network! : l.network! - l.site, l, false)).join(' and ');
  return `They differ by ${by}. The price can move between this site's read and the test run. You are held to the limits above, not to either line.`;
}

function SiteAndNetworkRows({ prepared, decimals }: { prepared: PreparedTx; decimals: number | null }) {
  const c = siteAndNetwork(prepared, decimals);
  if (!c || c.legs.length === 0) return null;
  const agree = agreementText(c);
  return (
    <div className="space-y-1.5" data-testid="tx-site-and-network">
      <Row label="Worked out by this site" value={c.unread ? `Could not be worked out: ${c.unread}.` : legsLine(c.legs, 'site')} mono={!c.unread} words />
      <Row label="The network's test run moved" value={legsLine(c.legs, 'network')} words />
      {agree && <p className="text-white/55 [overflow-wrap:anywhere]">{agree}</p>}
      {c.solNetted && <p className="text-white/40 text-[10px]">SOL on both lines counts your wrapped-SOL account as SOL, and leaves out the fees and deposits listed above.</p>}
      {c.solLeftOut && <p className="text-white/40 text-[10px]">{c.solLeftOut}</p>}
    </div>
  );
}

/** One number per build, so what a copy button said under one build never shows under the next. */
const builds = new WeakMap<PreparedTx, number>();
let lastBuild = 0;
function buildKey(p: PreparedTx): number {
  const known = builds.get(p);
  if (known !== undefined) return known;
  builds.set(p, ++lastBuild);
  return lastBuild;
}

/** Copies on a press; where the browser refuses, the text is shown to select by hand. */
function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [state, setState] = useState<{ kind: 'idle' | 'copied' } | { kind: 'shown'; text: string } | { kind: 'failed'; why: string }>({ kind: 'idle' });
  const press = async () => {
    let value: string;
    try {
      value = text();
    } catch (e) {
      setState({ kind: 'failed', why: clipDetail(e) });
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setState({ kind: 'copied' });
    } catch {
      setState({ kind: 'shown', text: value });
    }
  };
  const said =
    state.kind === 'copied'
      ? 'Copied.'
      : state.kind === 'shown'
        ? 'This browser did not let the page copy. Here it is: select it and copy it.'
        : state.kind === 'failed'
          ? `Could not be put together here: ${state.why}`
          : '';
  return (
    <div className="space-y-1">
      <button type="button" className="btn-secondary min-h-[44px] px-3 py-2 text-[12px]" onClick={() => void press()}>
        {label}
      </button>
      <p aria-live="polite" className="text-white/55 text-[11px]">
        {said}
      </p>
      {state.kind === 'shown' && (
        <textarea
          readOnly
          aria-label={label}
          value={state.text}
          rows={4}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded bg-black/40 p-2 font-mono text-[11px] text-white/80 break-all"
        />
      )}
    </div>
  );
}

function Address({ address, href }: { address: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-block py-3 -my-3 font-mono text-[11px] break-all underline text-white/80 ring-on-words">
      <span className="ring-words">{address}</span>
    </a>
  );
}

function computeLine(units: number | null, limit: number | null): string {
  if (limit === null) return `Compute: ${units === null ? 'the test run did not say how many units it used' : `${grouped(units)} units`}; this transaction sets no limit, so the network's default applies.`;
  if (units === null) return `Compute: the test run did not say how many units it used; limit ${grouped(limit)}.`;
  return `Compute: ${grouped(units)} units, limit ${grouped(limit)}.`;
}

function slotLine(sim: PreparedTx['simulation']): string {
  return sim.slot === null ? `Test run at ${utcTime(sim.at)}; the network did not give its slot.` : `Test run at slot ${grouped(sim.slot)} (${utcTime(sim.at)}).`;
}

/** A value, or null when working it out threw: said on screen as could not, never as empty. */
function orNull<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-white/90 font-medium">{title}</p>
      {children}
    </div>
  );
}

/** Whose bytes these are. A review that can be built again (useTxFlow `renewable`) is built again at Sign once it is old. */
function whoseBytes(rebuilds: boolean): string {
  if (!rebuilds) return "Read back out of this build's own bytes, the ones your wallet is handed.";
  return `Read back out of this build's own bytes. Press Sign ${REVIEW_TTL_MS / 1000} seconds or more after asking for this review, or when the network is close to refusing it, and the site builds it again first: a new blockhash, and a new address for anything it makes fresh, such as an opening's NFT. If the review above reads the same, that build goes to your wallet without another press, so check your wallet's copy.`;
}

function WhatYouAreSigning({ prepared: p, api, cluster, rebuilds }: { prepared: PreparedTx; api: TxViewApi; cluster: SolanaCluster; rebuilds: boolean }) {
  const wallet = p.tx.feePayer?.toBase58() ?? null;
  const link = (address: string) => api.explorerAddressUrl(address, cluster);
  const steps = orNull(() => decodedSteps(p));
  const ctx = { wallet, display: api.meta.displaySafe, coins: orNull(() => poolCoins(p.summary)) };
  const accounts = orNull(() => writtenAccounts(p));
  const logs = p.simulation.logs;
  return (
    <FinePrint summary="What you are signing" testId="tx-under-the-hood">
      <p>{whoseBytes(rebuilds)}</p>
      <Part title="Steps, in order">
        {steps ? (
          <ol className="list-decimal pl-5 space-y-2 [overflow-wrap:anywhere]">
            {steps.map(({ step, program }, i) => (
              <li key={`${i}:${step.kind}`}>
                {stepText(step, ctx)}.
                <span className="block text-white/55">
                  {programName(step, program)}: <Address address={program} href={link(program)} />
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>The steps could not be lined up with this transaction&apos;s instructions here. Your wallet decodes them itself.</p>
        )}
      </Part>
      <Part title={accounts ? `Accounts it writes (${accounts.length})` : 'Accounts it writes'}>
        {accounts ? (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.address}>
                {(a.label || a.field) && (
                  <span className="block text-white/55">
                    {a.label}
                    {a.label && a.field && ' · '}
                    {a.field && <span className="font-mono text-[11px]">{a.field}</span>}
                  </span>
                )}
                {a.wallet ? <span className="font-mono text-[11px] break-all">{a.address}</span> : <Address address={a.address} href={link(a.address)} />}
              </li>
            ))}
          </ul>
        ) : (
          <p>They could not be listed from this transaction here. Your wallet lists them itself.</p>
        )}
      </Part>
      <p>{computeLine(p.simulation.unitsConsumed, unitLimit(p))}</p>
      <p>{`Size: ${grouped(p.sizeBytes)} of ${grouped(SOLANA_TX_BYTES)} bytes. Your wallet may add guard instructions.`}</p>
      <p>{slotLine(p.simulation)}</p>
      <FinePrint summary={`Test run log (${logs.length} ${logs.length === 1 ? 'line' : 'lines'})`} testId="tx-under-the-hood-log">
        {logs.length === 0 ? (
          <p>The network sent no log with this test run.</p>
        ) : (
          <>
            {logCutShort(logs) && <p>The network cut this log short.</p>}
            <CopyButton key={buildKey(p)} label="Copy log" text={() => logs.join('\n')} />
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-black/30 p-2 font-mono text-[10px] text-white/70">{logs.join('\n')}</pre>
          </>
        )}
      </FinePrint>
      <CopyButton key={buildKey(p)} label="Copy the unsigned transaction (base64)" text={() => unsignedBase64(p.tx)} />
      <p className="text-white/40 text-[10px]">
        No link here goes to an outside inspector, and your wallet&apos;s address is in no link: the transaction holds your address, and this site never puts it in a URL.
      </p>
    </FinePrint>
  );
}

/** Drawn by TxFlowView under the review, for every kind. `rebuilds`: the review's `renewable`. */
export function UnderTheHood({ prepared, decimals, api, cluster, rebuilds }: { prepared: PreparedTx; decimals: number | null; api: TxViewApi; cluster: SolanaCluster; rebuilds: boolean }) {
  return (
    <>
      <Guard fallback="This site's figures could not be set beside the test run here.">
        <SiteAndNetworkRows prepared={prepared} decimals={decimals} />
      </Guard>
      <Guard fallback="What you are signing could not be shown here. Your wallet shows the transaction itself before you sign.">
        <WhatYouAreSigning prepared={prepared} api={api} cluster={cluster} rebuilds={rebuilds} />
      </Guard>
    </>
  );
}
