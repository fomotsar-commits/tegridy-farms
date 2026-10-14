import { CardArt } from '../../ui/CardArt';
import { Card, Notice, Row } from './ui';
import type { GateBlock } from './ports';
import type { WriteGateState } from './useWriteGate';

// Says, in plain words, whether launching and trading are open on this page, and
// if not, why. Every "no" names what was read. A failed read says the read failed;
// it never says the program is missing.

const BLOCK_COPY: Record<GateBlock, string> = {
  'launch-program-missing':
    'The launch program is not on this network at the configured address, so nothing can be launched or traded here.',
  'cpswap-program-missing':
    'The pool program that launches graduate into is not on this network at the configured address, so nothing is offered.',
  'protocol-not-initialized': 'The launch program is there, but its settings have not been created yet, so nothing is offered.',
  'venue-mismatch':
    "The launch program's settings point at a different pool program than this site expects, so nothing is offered.",
  'venue-not-configured': 'The pool that launches graduate into is not set up yet, so nothing is offered.',
  unreadable: 'We could not read the network to check, so nothing is offered. This says nothing about the program itself.',
  'wrong-cluster':
    'The network this page is reading is not the one it is set up for, so nothing is offered.',
};

export function WriteGateBanner({ state }: { state: WriteGateState }) {
  if (state.status === 'disabled') return null;
  return (
    <Card title="Launch and trade" testId="write-gate-banner" art={<CardArt pageId="curve-launch" idx={13} />}>
      {state.status === 'loading' && <Notice>Checking the network before offering anything…</Notice>}
      {state.status === 'load-failed' && (
        <>
          <Notice tone="warn">
            The launch and trade tools did not load, so this page is read-only for now. Reload to try again.
          </Notice>
          <p className="text-white/40 text-[10px] break-all">{state.detail}</p>
        </>
      )}
      {state.status === 'ready' && state.gate.kind === 'off' && (
        <Notice>Launching and trading are not set up on this site, so this page is read-only.</Notice>
      )}
      {state.status === 'ready' && state.gate.kind === 'blocked' && (
        <>
          <Notice tone="warn">{BLOCK_COPY[state.gate.reason] ?? BLOCK_COPY.unreadable}</Notice>
          {state.gate.detail && <p className="text-white/40 text-[10px] break-all">{state.gate.detail}</p>}
        </>
      )}
      {state.status === 'ready' && state.gate.kind === 'open' && (
        <>
          <Notice tone="good">
            Open. The launch program, its settings and its pool program were all read from the network just now.
          </Notice>
          {state.gate.paused && (
            <Notice tone="warn">
              New launches, buys and graduation are paused. Selling and pool swaps still work, so nobody is stuck.
            </Notice>
          )}
          <Row label="Launch program" value={state.gate.cfg.programId.toBase58()} />
          <Row label="Pool program" value={state.gate.cfg.cpSwapProgram.toBase58()} />
          {state.gate.cfg.cluster !== 'mainnet' && (
            <Notice tone="warn">This is a {state.gate.cfg.cluster} test network. Nothing here is real money.</Notice>
          )}
        </>
      )}
    </Card>
  );
}
