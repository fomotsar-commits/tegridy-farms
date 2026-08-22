// What the leg list is allowed to say.
//
// The copy is the product here. A progress list that renders `unknown` as "Failed" is not a
// cosmetic defect — it tells someone their swap did not happen when it may have, and the
// next thing they do is send it again.

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { STEP_STATUS_COPY, ZapStepList } from './ZapStepList';
import type { ZapStepState, ZapStepStatus } from '../../lib/zap/machine';
import type { ZapStepPlan } from '../../lib/zap/planner';

const PLAN: ZapStepPlan[] = [
  { id: 'approve-staking', stage: 0, label: 'Approve TOWELI for the staking lock', kind: 'approve', holdingAfter: null },
  { id: 'staking-lock', stage: 0, label: 'Lock TOWELI', kind: 'deposit', holdingAfter: 'a locked position' },
];

function steps(...statuses: ZapStepStatus[]): ZapStepState[] {
  return statuses.map((status, i) => ({ id: PLAN[i]!.id, status, updatedAt: 0 }));
}

describe('the status vocabulary', () => {
  it('covers every status the machine can produce', () => {
    const all: ZapStepStatus[] = [
      'pending',
      'signing',
      'submitted',
      'confirmed',
      'reverted',
      'rejected',
      'unknown',
      'skipped',
    ];
    for (const status of all) {
      expect(STEP_STATUS_COPY[status]?.label, `${status} has no copy`).toBeTruthy();
      expect(STEP_STATUS_COPY[status]!.meaning.length).toBeGreaterThan(20);
    }
  });

  it('reserves the settled tone for the two statuses that are actually settled', () => {
    const good = (Object.keys(STEP_STATUS_COPY) as ZapStepStatus[]).filter(
      (s) => STEP_STATUS_COPY[s]!.tone === 'good',
    );
    expect(good.sort()).toEqual(['confirmed', 'skipped']);
  });

  it('never describes an unread outcome as a failure', () => {
    const unknown = STEP_STATUS_COPY.unknown;
    expect(`${unknown.label} ${unknown.meaning}`).not.toMatch(/fail|revert|did not|didn't/i);
    expect(unknown.meaning).toMatch(/may have gone through/i);
  });

  it('says the money did not move for the two statuses where it did not', () => {
    expect(STEP_STATUS_COPY.reverted.meaning).toMatch(/no effect/i);
    expect(STEP_STATUS_COPY.rejected.meaning).toMatch(/no effect/i);
  });
});

describe('<ZapStepList />', () => {
  it('renders each leg with its own status, not the run’s', () => {
    renderWithProviders(<ZapStepList plan={PLAN} steps={steps('confirmed', 'reverted')} chainId={1} />);
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Reverted')).toBeInTheDocument();
  });

  it('offers a chain lookup for an unread leg that has a hash', () => {
    const onVerify = vi.fn();
    const state = steps('unknown', 'pending');
    state[0]!.txHash = '0xabc';
    renderWithProviders(<ZapStepList plan={PLAN} steps={state} chainId={1} onVerify={onVerify} onMark={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /check the chain/i }));
    expect(onVerify).toHaveBeenCalledWith(0);
    expect(screen.queryByRole('button', { name: /it went through/i })).not.toBeInTheDocument();
  });

  it('asks the user only when there is no hash to look up, and attributes the answer to them', () => {
    const onMark = vi.fn();
    renderWithProviders(
      <ZapStepList plan={PLAN} steps={steps('unknown', 'pending')} chainId={1} onVerify={vi.fn()} onMark={onMark} />,
    );
    expect(screen.getByText(/no transaction hash/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /it went through/i }));
    expect(onMark).toHaveBeenCalledWith(0, 'confirmed');
  });

  it('offers no resolution affordance on a leg that is not unread', () => {
    renderWithProviders(
      <ZapStepList plan={PLAN} steps={steps('confirmed', 'pending')} chainId={1} onVerify={vi.fn()} onMark={vi.fn()} />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('links a leg’s transaction when it has one', () => {
    const state = steps('confirmed', 'pending');
    state[0]!.txHash = '0xdeadbeef';
    renderWithProviders(<ZapStepList plan={PLAN} steps={state} chainId={1} />);
    const link = screen.getByRole('link', { name: /view transaction/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('0xdeadbeef'));
  });
});
