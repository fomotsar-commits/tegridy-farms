// THE DOOR. "Elsewhere the launch button is open to anyone with gas. Here it reads
// held time, live, from an instrument nobody can argue with. Equally instant.
// Opposite meaning."
//
// EXACTLY THREE VERDICT STATES — WARM / COLD / STALE. The spec is emphatic that there
// are three, and a fourth would be a verdict the instrument never gave. The two
// non-verdict states below (no wallet connected, reading in flight) are the absence of
// a question, not an answer to one: neither claims anything about a wallet.
//
// THE COLD STATE RENDERS THE PHASE 1 HEAT CARD. That is the point of building the card
// first — a cold builder sees exactly what the door measured and what warmth is, in the
// same component, with the same tier words, as everywhere else on the site. "The door
// explains itself; nobody DMs screenshots to a human."

import { useCallback, useEffect, useRef, useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount, useSignMessage } from 'wagmi';
import { meetsHeatFloor } from '../lib/heat/launchGate';
import { isHeatGateEnabled } from '../lib/heat/heatGateConfig';
import type { GateDecision } from '../lib/heat/heatOracle';
import type { GateAuditRow } from '../lib/heat/gateAudit';
import { HeatCard } from './HeatCard';
import { GateAuditPanel } from './heat/GateAuditPanel';
import { shortenAddress } from '../lib/formatting';

/**
 * The message the wallet signs to prove it is theirs.
 *
 * SIGNING PROVES, NEVER SPENDS — and the message says so in words the signer reads in
 * their own wallet, because "sign this to continue" with opaque text is how people get
 * drained. There is no nonce and no server: this signature authenticates nothing to
 * anybody, it only binds the reading on screen to the wallet standing in front of the
 * door. Never send it anywhere, and never treat it as authorisation for anything.
 */
export function ownershipMessage(address: string, nowIso: string): string {
  return [
    'Prove this wallet is yours.',
    '',
    'This signature reads your Heat from Jungle Bay Island so the launch door can',
    'answer you. It moves no funds, approves no tokens, and grants no permissions.',
    '',
    `Wallet: ${address}`,
    `Time:   ${nowIso}`,
  ].join('\n');
}

type Phase =
  | { kind: 'no-wallet' }
  | { kind: 'reading' }
  | { kind: 'decided'; decision: GateDecision; audit: GateAuditRow | null };

export interface LaunchGateProps {
  /**
   * Called with the gate audit row once the wallet has cleared the door AND proved
   * ownership. `row.id` is `gate_decision_id` — the value the birth notify carries, so
   * the island can tie the token back to the decision that permitted it.
   */
  onOpen?: (row: GateAuditRow | null) => void;
  /** Rail label, for the copy only. The rule is identical on both. */
  rail?: 'ethereum' | 'solana';
  children?: React.ReactNode;
}

export function LaunchGate({ onOpen, rail = 'ethereum', children }: LaunchGateProps) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [phase, setPhase] = useState<Phase>({ kind: 'no-wallet' });
  const [proving, setProving] = useState(false);
  const [proveError, setProveError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const read = useCallback(async () => {
    if (!address) {
      setPhase({ kind: 'no-wallet' });
      return;
    }
    const seq = ++reqRef.current;
    setPhase({ kind: 'reading' });
    // `meetsHeatFloor` never throws for an unreachable oracle — it returns STALE with a
    // reason. So there is no try/catch here by design, and no path where a thrown error
    // could leave the door in an undefined state.
    const { decision, audit } = await meetsHeatFloor(address);
    if (seq === reqRef.current) setPhase({ kind: 'decided', decision, audit });
  }, [address]);

  // Re-read whenever the connected wallet changes.
  //
  // The ownership proof is keyed on the ADDRESS rather than reset by an effect: a verdict
  // and a signature belong to one account, and clearing them in an effect body would mean
  // one render in which the previous account's `proved` is still true against the new
  // account's reading. Deriving it makes that window impossible.
  const [provedFor, setProvedFor] = useState<string | null>(null);
  const proved = !!address && provedFor === address;

  useEffect(() => {
    void read();
  }, [read]);

  const prove = useCallback(async () => {
    if (!address) return;
    setProving(true);
    setProveError(null);
    try {
      await signMessageAsync({ message: ownershipMessage(address, new Date().toISOString()) });
      setProvedFor(address);
      if (phase.kind === 'decided') onOpen?.(phase.audit);
    } catch {
      // Rejecting the signature is a normal thing to do, not an error state to shout at.
      setProveError('Not signed, so the lane stays shut. Nothing was sent and nothing was spent.');
    } finally {
      setProving(false);
    }
  }, [address, signMessageAsync, phase, onOpen]);

  if (phase.kind === 'no-wallet') {
    return (
      <Frame>
        <Title>Who may plant</Title>
        <p className="text-[13px] text-white/60 leading-relaxed">
          The launch lane reads your <strong className="text-white/85">held time</strong> live from Jungle Bay
          Island. Connect the Ethereum wallet that carries your standing to see what the door reads.
          {rail === 'solana' && (
            <>
              {' '}
              An Ethereum address is the qualifying identity today — Solana linking rides the island&apos;s
              multiwallet rail when it ships, so a Solana-only wallet cannot yet be measured.
            </>
          )}
        </p>
      </Frame>
    );
  }

  if (phase.kind === 'reading') {
    return (
      <Frame>
        <Title>Who may plant</Title>
        <p className="text-[13px] text-white/55 animate-pulse">Reading {shortenAddress(address ?? '', 6)} against the island&apos;s instrument…</p>
      </Frame>
    );
  }

  const { decision } = phase;
  const open = decision.state === 'WARM' && proved;

  return (
    <Frame state={decision.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <Title>Who may plant</Title>
        <StateChip state={decision.state} />
      </div>

      <AnimatePresence mode="wait">
        {/* ── WARM ───────────────────────────────────────────────────────────── */}
        {decision.state === 'WARM' && (
          <m.div key="warm" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <p className="text-[13px] text-white/75 leading-relaxed mb-3">{decision.detail}</p>
            {!proved ? (
              <>
                <button onClick={() => void prove()} disabled={proving} className="btn-primary px-5 py-2 text-[13px] disabled:opacity-40">
                  {proving ? 'Waiting for your wallet…' : 'Prove this wallet is yours'}
                </button>
                <p className="text-[11px] text-white/40 mt-2 leading-relaxed">
                  A signature, not a transaction. It moves no funds, approves no tokens, and costs no gas.
                </p>
                {proveError && <p className="text-[11.5px] mt-2" style={{ color: '#fca5a5' }}>{proveError}</p>}
              </>
            ) : (
              <p className="text-[12.5px]" style={{ color: 'var(--color-kyle)' }}>
                ✓ The launch lane is open.
              </p>
            )}
          </m.div>
        )}

        {/* ── COLD ───────────────────────────────────────────────────────────── */}
        {decision.state === 'COLD' && (
          <m.div key="cold" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <p className="text-[13px] text-white/75 leading-relaxed mb-3">{decision.detail}</p>
            {/* The wallet sees ITS OWN reading, in the same card as everywhere else.
                Pinned to the connected address: the door is not a lookup tool. */}
            <div className="rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--color-purple-25)' }}>
              <HeatCard address={decision.address} variant="embedded" showEligibility={false} />
            </div>
            <p className="text-[11.5px] text-white/45 leading-relaxed mt-3">
              Warmth is held time. It accrues by holding tokens the island measures and holding them
              across time — it cannot be bought, and a larger bag does not buy it faster. Nobody
              approves this by hand and there is nobody to ask: the door reads the instrument, and so can you.
            </p>
            {/* The denied wallet is standing HERE, so the record of what it was denied on
                lives here too — collapsed, because the reading above is the answer and
                the ledger is the working. */}
            <GateAuditPanel address={decision.address} onReRead={() => void read()} />
          </m.div>
        )}

        {/* ── STALE ──────────────────────────────────────────────────────────── */}
        {decision.state === 'STALE' && (
          <m.div key="stale" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <p className="text-[13px] text-white/75 leading-relaxed mb-3">{decision.detail}</p>
            <button onClick={() => void read()} className="btn-secondary px-4 py-1.5 text-[12.5px]">
              Read again
            </button>
            <p className="text-[11.5px] text-white/45 leading-relaxed mt-2">
              The door is shut because it has nothing it is allowed to judge on — not because of
              anything about this wallet. No verdict has been recorded against you.
            </p>
            {/* No `onReRead` here: "Read again" is already the primary control above, and a
                second button doing the identical thing invites the reader to think one of
                them does something else. */}
            <GateAuditPanel address={decision.address} />
          </m.div>
        )}
      </AnimatePresence>

      {/* The gate is ADVISORY: both rails sign client-side. Say so where a launcher reads it. */}
      {!isHeatGateEnabled() && (
        <p className="text-[11px] text-white/40 mt-3">
          Denial is currently dialled off, so the reading above is shown for information and the lane
          stays open either way.
        </p>
      )}

      {open && children}
    </Frame>
  );
}

function Frame({ children, state }: { children: React.ReactNode; state?: GateDecision['state'] }) {
  const border =
    state === 'WARM' ? 'var(--color-kyle-40)' : state === 'STALE' ? 'rgba(234,179,8,0.35)' : 'var(--color-purple-40)';
  return (
    // A named region, not a bare div: the door is a distinct landmark on a page whose
    // main content is the wizard, and screen-reader users need to be able to reach the
    // thing that decides whether the wizard leads anywhere.
    <section
      aria-label="Who may plant"
      className="rounded-2xl p-5 md:p-6"
      style={{ background: 'rgba(6,12,26,0.78)', border: `1px solid ${border}`, backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}
    >
      {children}
    </section>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <h2 className="heading-luxury text-xl text-white tracking-tight">{children}</h2>;
}

function StateChip({ state }: { state: GateDecision['state'] }) {
  const color = state === 'WARM' ? 'var(--color-kyle)' : state === 'STALE' ? '#fbbf24' : 'rgba(255,255,255,0.55)';
  return (
    <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color }}>
      {state}
    </span>
  );
}
