import type { PublicKey } from '@solana/web3.js';
import {
  formatTokenAmount,
  migrationEligibility,
  type CurveAccount,
  type LaunchState,
} from '../../../lib/launcher/solana/curve';
import { Card, Notice, Row } from './ui';
import { TxFlowView } from './TxFlowView';
import { WalletNeeded } from './WalletNeeded';
import { useTxFlow } from './useTxFlow';
import type { ActionAvailability, OpenGate, PreparedTx, TxOutcome, WriteApi, WriteRpc } from './ports';
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
  onSettled: (outcome: TxOutcome, prepared: PreparedTx | null) => void;
}

/**
 * Finishing graduation, and releasing the platform reserve afterwards. Both are
 * open to anyone. Graduation costs the caller the network fee (its account rent is
 * paid back inside the transaction); release costs the network fee and, only if the
 * treasury has no account for this token yet, that account's rent. The review shows
 * the simulated cost before a signature.
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
}: GraduationPanelProps) {
  const flow = useTxFlow(api, rpc, onSettled);
  const phase = launch.phase.kind;
  if (phase !== 'awaiting-migration' && phase !== 'graduated') return null;
  const signer = signerState.kind === 'ready' ? signerState.signer : null;
  const c = curve.curve;

  if (flow.state.step !== 'idle') {
    return (
      <Card title={phase === 'graduated' ? 'Platform reserve' : 'Finish graduation'} testId="graduation-panel">
        <TxFlowView flow={flow} api={api} cluster={gate.cfg.cluster} decimals={decimals} signer={signer} />
      </Card>
    );
  }

  if (phase === 'awaiting-migration') {
    const e = migrationEligibility(gate.global, curve, rentFloor);
    return (
      <Card title="Finish graduation" testId="graduation-panel">
        <p>
          This launch has raised everything it needs. Finishing graduation opens its pool with the curve&apos;s SOL and
          unsold tokens, and burns the pool&apos;s LP tokens so that liquidity can never be pulled.
        </p>
        {e.eligible === true && <Notice tone="good">Ready to finish now.</Notice>}
        {e.eligible === false && <Notice tone="warn">{BLOCKED_COPY[e.blockedBy]}</Notice>}
        {e.eligible === null && <Notice tone="warn">Could not check whether it is ready: {e.detail}.</Notice>}
        <Row label="Pool program lets this launch program open pools" value={yesNo(gate.graduation.permission)} mono={false} />
        <Row label="Pool creation fee account exists" value={yesNo(gate.graduation.createPoolFeeReceiver)} mono={false} />
        {(gate.graduation.permission === false || gate.graduation.createPoolFeeReceiver === false) && (
          <Notice tone="warn">Graduation cannot succeed until the pool program side is set up. Not a problem with this launch.</Notice>
        )}
        <WalletNeeded state={signerState} />
        <button
          type="button"
          className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
          disabled={!signer || !actions.migrate || flow.locked}
          onClick={() => signer && void flow.prepare(() => api.prepareMigrate(rpc, gate, { payer: signer.publicKey, mint, curve }))}
        >
          Review: finish graduation
        </button>
        <p className="text-white/35 text-[10px]">
          Anyone can do this. You pay the network fee. The account rent it needs is paid back to you in the same
          transaction. The exact change to your SOL is shown before you sign.
        </p>
      </Card>
    );
  }

  const reserve = formatTokenAmount(c.platformReserveTokens, decimals);
  return (
    <Card title="Graduated" testId="graduation-panel">
      <Row label="Pool" value={c.pool.toBase58()} />
      {c.platformReserveTokens === 0n ? (
        <Notice>This launch has no platform reserve.</Notice>
      ) : c.platformReserveReleased ? (
        <Notice>The platform reserve has been released to the treasury.</Notice>
      ) : (
        <>
          <Row label={`Platform reserve still held${reserve.isBaseUnits ? ' (base units)' : ''}`} value={reserve.text} />
          <p>
            The program held these tokens back until graduation. Now anyone can send them to the platform treasury, once.
          </p>
          <WalletNeeded state={signerState} />
          <button
            type="button"
            className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
            disabled={!signer || !actions.release || flow.locked}
            onClick={() => signer && void flow.prepare(() => api.prepareRelease(rpc, gate, { payer: signer.publicKey, mint, curve }))}
          >
            Review: release platform reserve
          </button>
          <p className="text-white/35 text-[10px]">
            It pays you nothing. You pay the network fee and possibly the rent for the treasury&apos;s token account.
          </p>
        </>
      )}
    </Card>
  );
}
