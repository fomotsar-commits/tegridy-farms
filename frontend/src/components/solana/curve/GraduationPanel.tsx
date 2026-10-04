import type { PublicKey } from '@solana/web3.js';
import {
  describeReserveRecipient,
  formatTokenAmount,
  migrationEligibility,
  type CurveAccount,
  type LaunchState,
  type TreasuryDescription,
} from '../../../lib/launcher/solana/curve';
import { Card, Notice, Row } from './ui';
import { TxFlowView } from './TxFlowView';
import { WalletNeeded } from './WalletNeeded';
import { useReturnFocus, useTxFlow, type OnSent, type OnSettled } from './useTxFlow';
import type { ActionAvailability, OpenGate, WriteApi, WriteRpc } from './ports';
import type { CurveSignerState } from './useCurveSigner';

const BLOCKED_COPY = {
  paused: 'Graduation is paused by the protocol right now. Selling still works.',
  'amm-not-configured': 'The pool that launches graduate into is not set up yet.',
  'already-complete': 'Someone already finished graduation for this launch.',
  'below-target': 'The curve has not reached its graduation target yet.',
  'reserve-too-low':
    'The curve holds a little less than graduation needs, usually because a sell just landed. It is a pause, not a break: it becomes possible again with the next buy.',
} as const;

const yesNo = (v: boolean | null) => (v === null ? 'could not read' : v ? 'yes' : 'no');

export interface GraduationPanelProps {
  api: WriteApi;
  rpc: WriteRpc;
  gate: OpenGate;
  launch: LaunchState;
  curve: CurveAccount;
  mint: PublicKey;
  decimals: number | null;
  rentFloor: bigint | null;
  actions: ActionAvailability;
  signerState: CurveSignerState;
  onSettled: OnSettled;
  /** The transaction is about to be sent: the page writes its "may still land" note. */
  onSent?: OnSent;
  /**
   * Who received this launch’s platform reserve, from its own create transaction
   * (describeReserveRecipient). Never today’s config, which can have changed since.
   */
  treasury?: TreasuryDescription;
}

/**
 * Finishing graduation, open to anyone. It costs the caller the network fee (its
 * account rent is paid back inside the transaction); the review shows the simulated
 * cost before a signature. Graduation does not touch the platform reserve, which
 * create_launch already paid to the treasury when the token was created.
 */
export function GraduationPanel({
  api,
  rpc,
  gate,
  launch,
  curve,
  mint,
  decimals,
  rentFloor,
  actions,
  signerState,
  onSettled,
  onSent,
  treasury = describeReserveRecipient(null),
}: GraduationPanelProps) {
  const flow = useTxFlow(api, rpc, onSettled, onSent);
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flow.state.step);
  const phase = launch.phase.kind;
  if (phase !== 'awaiting-migration' && phase !== 'graduated') return null;
  const signer = signerState.kind === 'ready' ? signerState.signer : null;
  const c = curve.curve;

  if (flow.state.step !== 'idle') {
    return (
      <Card
        title="Finish graduation"
        testId="graduation-panel"
        headingRef={headingRef}
      >
        <TxFlowView flow={flow} api={api} cluster={gate.cfg.cluster} decimals={decimals} signer={signer} />
      </Card>
    );
  }

  if (phase === 'awaiting-migration') {
    const e = migrationEligibility(gate.global, curve, rentFloor);
    return (
      <Card title="Finish graduation" testId="graduation-panel" headingRef={headingRef}>
        <p>
          This launch has raised everything it needs. Finishing graduation opens its pool with the curve&apos;s SOL and
          unsold tokens, and burns the pool&apos;s LP tokens so that liquidity can never be pulled.
        </p>
        {e.eligible === true && <Notice tone="good">Ready to finish now.</Notice>}
        {e.eligible === false && <Notice tone="warn">{BLOCKED_COPY[e.blockedBy]}</Notice>}
        {e.eligible === null && <Notice tone="warn">Could not check whether it is ready: {e.detail}.</Notice>}
        {(gate.graduation.permission === false || gate.graduation.createPoolFeeReceiver === false) && (
          <Notice tone="warn">Graduation cannot succeed until the pool side is set up. Not a problem with this launch.</Notice>
        )}
        <details className="text-white/60">
          <summary className="cursor-pointer min-h-[44px] flex items-center">Technical details</summary>
          <div className="space-y-1.5 pb-1">
            <Row label="Pool program lets this launch program open pools" value={yesNo(gate.graduation.permission)} mono={false} />
            <Row label="Pool creation fee account exists" value={yesNo(gate.graduation.createPoolFeeReceiver)} mono={false} />
          </div>
        </details>
        <WalletNeeded state={signerState} />
        <button
          ref={reviewRef}
          type="button"
          className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
          disabled={!signer || !actions.migrate || flow.locked}
          onClick={() => {
            if (!signer) return;
            void flow.prepare(() => api.prepareMigrate(rpc, gate, { payer: signer.publicKey, mint, curve }), { repeatable: true });
          }}
        >
          Review: finish graduation
        </button>
        <p className="text-white/35 text-[10px]">
          Anyone can do this. You pay the transaction fees (the network fee and any priority fee). The account rent it
          needs is paid back to you in the same transaction. The exact change to your SOL is shown before you sign.
        </p>
      </Card>
    );
  }

  const reserve = formatTokenAmount(c.platformReserveTokens, decimals);
  return (
    <Card title="Graduated" testId="graduation-panel" headingRef={headingRef}>
      <Row label="Pool" value={c.pool.toBase58()} />
      {c.platformReserveTokens === 0n ? (
        <Notice>This launch has no platform reserve.</Notice>
      ) : (
        <>
          <Row label={`Platform reserve${reserve.isBaseUnits ? ' (base units)' : ''}`} value={reserve.text} />
          <p>
            {c.platformReserveReleased
              ? `Paid when this token was created, to ${treasury.name}. Graduation did not touch it.`
              : 'This launch’s account does not record the platform reserve as paid, so this page does not say where it is.'}
          </p>
        </>
      )}
    </Card>
  );
}
