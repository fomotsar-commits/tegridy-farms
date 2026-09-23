// The audit panel is a HONESTY surface before it is a table, so most of what is
// asserted here is what it must NOT say: no zero for an unread instrument, no
// today's-floor against yesterday's decision, no empty list standing in for
// "storage is switched off", and no reckoning date passed off as a decision time.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { GateAuditPanel, replayLine } from './GateAuditPanel';
import { clearGateAudit, recordGateDecision, type GateAuditRow } from '../../lib/heat/gateAudit';
import { gateDecision, parseHeatReading, type HeatReading } from '../../lib/heat/heatOracle';

const ADDR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const OTHER = '0x1111111111111111111111111111111111111111';
const NOW = 1786104024;

function reading(degrees: number, tier = 'Builder', asOf = NOW): HeatReading {
  return parseHeatReading({
    address: ADDR,
    degrees,
    tier,
    is_cold: false,
    held_since_unix: NOW - 400 * 86_400,
    as_of_unix: asOf,
    token_count: 1,
    breakdown: [],
  });
}

/** Open the panel; it deliberately reads storage on expand rather than on mount. */
function expand() {
  fireEvent.click(screen.getByRole('button', { name: /why did the door answer/i }));
}

beforeEach(() => {
  clearGateAudit();
});

describe('collapsed by default', () => {
  it('renders only the disclosure control and touches storage for nothing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem');
    render(<GateAuditPanel address={ADDR} />);
    const toggle = screen.getByRole('button', { name: /why did the door answer/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/floor at the time/i)).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('expands to the record and collapses again', () => {
    recordGateDecision(gateDecision(ADDR, reading(12.5, 'Drifter'), NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByRole('button', { name: /hide what the door has read/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/floor at the time/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /hide what the door has read/i }));
    expect(screen.queryByText(/floor at the time/i)).not.toBeInTheDocument();
  });
});

describe('a denial, replayed', () => {
  it('shows the verdict, the wallet’s own degrees, and the arithmetic that produced it', () => {
    recordGateDecision(gateDecision(ADDR, reading(62.4, 'Observer'), NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/COLD · below the floor/i)).toBeInTheDocument();
    expect(screen.getByText('62.40°')).toBeInTheDocument();
    expect(screen.getByText('Observer')).toBeInTheDocument();
    expect(screen.getByText(/62\.40° measured against a 80° floor — short by 17\.60°/)).toBeInTheDocument();
  });

  it('quotes the gate_decision_id a support thread will ask for', () => {
    const row = recordGateDecision(gateDecision(ADDR, reading(62.4, 'Observer'), NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByTitle(row.id)).toBeInTheDocument();
  });

  it('separates when the ISLAND reckoned from when the DOOR decided', () => {
    // Two days apart, which is the whole reason they cannot share a cell.
    const reckoned = NOW - 2 * 86_400;
    recordGateDecision(gateDecision(ADDR, reading(62.4, 'Observer', reckoned), NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    const reckonedField = screen.getByText('Island reckoned').parentElement as HTMLElement;
    const decidedField = screen.getByText('Door decided').parentElement as HTMLElement;
    expect(within(reckonedField).getByText(/^2026-08-05 /)).toBeInTheDocument();
    expect(within(decidedField).getByText(/^2026-08-07 /)).toBeInTheDocument();
  });

  it('shows only this wallet’s decisions, never another wallet’s', () => {
    recordGateDecision(gateDecision(OTHER, { ...reading(200), address: OTHER }, NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/none of them were taken against/i)).toBeInTheDocument();
    expect(screen.queryByText('200.00°')).not.toBeInTheDocument();
  });

  it('matches a checksummed stored row against a lower-cased connection', () => {
    const mixed = '0xD71CAf9fDBbD3dd7f974431Edf7F9F2c7Ba8f93A';
    recordGateDecision(gateDecision(mixed, { ...reading(62.4, 'Observer'), address: mixed }, NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText('62.40°')).toBeInTheDocument();
  });
});

describe('the floor is the one the decision was taken against', () => {
  it('renders the STORED floor and flags that the dial has since moved', () => {
    // Decided against 250°; the live dial is 80°. Substituting 80° here would turn a
    // real denial into an apparent pass and erase the reason the wallet was refused.
    recordGateDecision(gateDecision(ADDR, reading(100), NOW, 250));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText('250°')).toBeInTheDocument();
    expect(screen.getByText(/100\.00° measured against a 250° floor — short by 150\.00°/)).toBeInTheDocument();
    expect(screen.getByText(/The floor is 80° today\. This decision was taken against 250°/)).toBeInTheDocument();
  });

  it('says nothing about drift when the floor has not moved', () => {
    recordGateDecision(gateDecision(ADDR, reading(100), NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.queryByText(/today\. This decision was taken against/i)).not.toBeInTheDocument();
  });
});

describe('an outage is never a score', () => {
  it('renders an unread instrument as "not read", never as 0°', () => {
    recordGateDecision(gateDecision(ADDR, null, NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/STALE · the island could not be read at all/i)).toBeInTheDocument();
    expect(screen.getAllByText('not read')).toHaveLength(2); // degrees and tier
    expect(screen.getByText(/That is an unread instrument, not a zero/)).toBeInTheDocument();
    expect(screen.queryByText('0.00°')).not.toBeInTheDocument();
  });

  it('says a stale reading was never measured against the floor', () => {
    const old = NOW - 30 * 86_400;
    recordGateDecision(gateDecision(ADDR, reading(500, 'Elder', old), NOW));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    // 500° clears 80° comfortably — and it still did not pass, because the reading
    // was too old to pass ANYONE. The panel must not imply the floor was the issue.
    expect(screen.getByText(/the 80° floor was never applied/)).toBeInTheDocument();
    expect(screen.queryByText(/clear by/)).not.toBeInTheDocument();
  });
});

describe('the record discloses its own limits', () => {
  it('says storage is unavailable rather than rendering an empty list', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/not letting the page keep a record/i)).toBeInTheDocument();
    expect(screen.getByText(/not.*the same as/i)).toBeInTheDocument();
    expect(screen.queryByText(/no gate decision has been recorded/i)).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('calls an empty record empty, and warns it is not proof of no denial', () => {
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/no gate decision has been recorded in this browser yet/i)).toBeInTheDocument();
    expect(screen.getByText(/An empty record is not a clean record/i)).toBeInTheDocument();
  });

  it('reports a corrupted store as unreadable rather than as empty', () => {
    localStorage.setItem('tegridy.heat.gate.audit.v1', '{not json');
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/not in the shape this page writes/i)).toBeInTheDocument();
    expect(screen.queryByText(/no gate decision has been recorded/i)).not.toBeInTheDocument();
  });

  it('admits a partial list is partial', () => {
    const good = recordGateDecision(gateDecision(ADDR, reading(62.4, 'Observer'), NOW));
    localStorage.setItem('tegridy.heat.gate.audit.v1', JSON.stringify([{ bad: 1 }, good, null]));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/2 stored rows were unreadable and\s+skipped, so this list is incomplete/i)).toBeInTheDocument();
    expect(screen.getByText('62.40°')).toBeInTheDocument();
  });

  it('never claims a record was emptied when every row was damaged', () => {
    localStorage.setItem('tegridy.heat.gate.audit.v1', JSON.stringify([{ bad: 1 }, null]));
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/unreadable and\s+skipped/i)).toBeInTheDocument();
    expect(screen.queryByText(/no gate decision has been recorded/i)).not.toBeInTheDocument();
  });

  it('states that the record is local and is never sent anywhere', () => {
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.getByText(/never sent anywhere, and it is not analytics/i)).toBeInTheDocument();
  });

  it('caps the list and says how many it is not showing', () => {
    for (let i = 0; i < 15; i++) recordGateDecision(gateDecision(ADDR, reading(62.4, 'Observer'), NOW));
    render(<GateAuditPanel address={ADDR} limit={4} />);
    expand();
    expect(screen.getByText(/Showing the 4 most recent of 15 decisions/i)).toBeInTheDocument();
    expect(screen.getAllByText('62.40°')).toHaveLength(4);
  });
});

describe('replaying against the island', () => {
  it('offers a re-read only when the host wired one', () => {
    render(<GateAuditPanel address={ADDR} />);
    expand();
    expect(screen.queryByRole('button', { name: /read the island again/i })).not.toBeInTheDocument();
  });

  it('calls back, and promises no funds move', () => {
    const onReRead = vi.fn();
    render(<GateAuditPanel address={ADDR} onReRead={onReRead} />);
    expand();
    fireEvent.click(screen.getByRole('button', { name: /read the island again/i }));
    expect(onReRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/moves no funds and costs no gas/i)).toBeInTheDocument();
  });
});

describe('replayLine', () => {
  const row = (over: Partial<GateAuditRow>): GateAuditRow => ({
    id: 'x',
    address: ADDR,
    degrees: 50,
    tier: 'Observer',
    as_of: NOW,
    floor: 80,
    verdict: 'COLD',
    reason: 'below-floor',
    decided_at: NOW,
    ...over,
  });

  it('derives the comparison from the row, not from the live dial', () => {
    expect(replayLine(row({ degrees: 50, floor: 300 }))).toContain('300° floor — short by 250.00°');
  });

  it('states the margin on a pass', () => {
    expect(replayLine(row({ degrees: 195.54, verdict: 'WARM', reason: 'qualified' }))).toContain(
      'clear by 115.54°',
    );
  });

  it('refuses to imply a zero when nothing was read', () => {
    const line = replayLine(row({ degrees: null, tier: null, verdict: 'STALE', reason: 'unreadable' }));
    expect(line).toMatch(/not a zero/);
    expect(line).not.toMatch(/0\.00°/);
  });
});
