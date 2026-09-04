import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoostScheduleTable } from './BoostScheduleTable';
import { BOOTSTRAP_APR_THRESHOLD, BOOTSTRAP_APR_NOTE } from '../../lib/copy';

// The boost table renders base-APR x boost per row, so at a 1,129% base its
// max-boost row shows ~4,519% — the largest number anywhere on the Farm page.
// IncentivesStrip already refused to show a four-digit rate without the
// bootstrap sentence; this table showed a BIGGER one with no context at all.
// A field review flagged the pairing ("1,129% next to 27 days of runway") and
// prescribed a dollar figure, which this deployment cannot compute honestly —
// the native pair holds 0.0795 WETH against a 10 WETH pricing floor. Context is
// the part that can be told truthfully, so that is what ships.
describe('BoostScheduleTable — four-digit rates carry their context', () => {
  it('explains a bootstrap-scale APR', () => {
    render(<BoostScheduleTable selectedLockLabel="90 days" aprNum={1129.78} />);
    expect(screen.getByText(new RegExp(BOOTSTRAP_APR_NOTE.slice(0, 30), 'i'))).toBeInTheDocument();
    expect(screen.getByText(/not a promised yield/i)).toBeInTheDocument();
  });

  it('stays quiet at an ordinary rate — the note must not become wallpaper', () => {
    render(<BoostScheduleTable selectedLockLabel="90 days" aprNum={BOOTSTRAP_APR_THRESHOLD - 1} />);
    expect(screen.queryByText(/not a promised yield/i)).not.toBeInTheDocument();
  });

  it('stays quiet when there is no rate to qualify', () => {
    render(<BoostScheduleTable selectedLockLabel="90 days" />);
    expect(screen.queryByText(/not a promised yield/i)).not.toBeInTheDocument();
  });
});
