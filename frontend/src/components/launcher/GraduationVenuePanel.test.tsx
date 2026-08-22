// The panel is the only place a creator learns where their liquidity goes. Two things it
// must never do: imply venue graduation is live while the migrator address is unset, and
// render an unread balance or an unread module state as a finding.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Address } from 'viem';

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

const venueState = {
  plan: null as unknown,
  moduleCheck: null as unknown,
  isChecking: false,
  checkSkipped: false,
};
vi.mock('../../hooks/useGraduationVenue', () => ({
  useGraduationVenue: () => venueState,
}));

const feeLineState = {
  read: null as unknown,
  isLoading: false,
  error: null as string | null,
  assetsUnavailable: false,
  refetch: vi.fn(),
};
vi.mock('../../hooks/useGraduationFeeLine', () => ({
  useGraduationFeeLine: () => feeLineState,
}));

// The plan itself is NOT mocked — the panel must render the real resolver's output, so a
// regression in the resolver's disclosure fails here too.
import { resolveEvmGraduationVenue, type FeeLineRead } from '../../lib/launcher/graduation';
import { GraduationVenuePanel, formatCredit, formatLockDuration } from './GraduationVenuePanel';
import { LOCKER_CLAIMER_ADDRESS } from '../../lib/constants';
import { DOPPLER_MAINNET } from '../../lib/launcher/doppler.constants';

const baseRead: FeeLineRead = {
  sink: LOCKER_CLAIMER_ADDRESS as Address,
  sinkConfigured: true,
  destinations: {
    locker: DOPPLER_MAINNET.support.streamableFeesLocker,
    revenueDistributor: '0xF993316E2fC079de4358c489A935E01e03E23E17' as Address,
    treasury: '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d' as Address,
  },
  destinationsUnreadable: false,
  pointsAtOurLocker: true,
  credits: [],
  checkedCount: 2,
  unreadable: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(venueState, {
    plan: resolveEvmGraduationVenue(),
    moduleCheck: { migrator: DOPPLER_MAINNET.modules.uniswapV4Migrator.address, state: 4, whitelisted: true, unreadable: false },
    isChecking: false,
    checkSkipped: false,
  });
  Object.assign(feeLineState, {
    read: { ...baseRead },
    isLoading: false,
    error: null,
    assetsUnavailable: false,
    refetch: vi.fn(),
  });
});

describe('honesty guard — the panel discloses that graduation is external', () => {
  it('renders the resolver disclosure verbatim, so the denial cannot be dropped in the view', () => {
    const plan = resolveEvmGraduationVenue();
    render(<GraduationVenuePanel />);
    expect(screen.getByText(plan.disclosure)).toBeInTheDocument();
  });

  it('never claims LP is burned while the external migrator runs', () => {
    render(<GraduationVenuePanel />);
    expect(screen.queryByText(/LP burned/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not burned/i)).toBeInTheDocument();
  });

  it('shows the operator preconditions and says the migrator address is unset', () => {
    render(<GraduationVenuePanel />);
    expect(screen.getByText(/What venue graduation would require/i)).toBeInTheDocument();
    expect(screen.getByText(/Migrator address is currently unset/i)).toBeInTheDocument();
  });

  it('labels an undetermined pool id as not yet determined, not as none', () => {
    render(<GraduationVenuePanel />);
    // Both rails report an undetermined id for different reasons; neither may print a
    // zero hash or the word "none", which would read as a finding about the pool.
    expect(screen.getAllByText(/not yet determined/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^none$/i)).not.toBeInTheDocument();
  });
});

describe('honesty guard — indicators are earned by real reads', () => {
  it('an unreadable module state is NOT rendered as "not whitelisted"', () => {
    venueState.moduleCheck = {
      migrator: DOPPLER_MAINNET.modules.uniswapV4Migrator.address,
      state: null,
      whitelisted: false,
      unreadable: true,
    };
    render(<GraduationVenuePanel />);
    expect(screen.getByText(/MODULE STATE UNREADABLE/i)).toBeInTheDocument();
    expect(screen.getByText(/not a negative result/i)).toBeInTheDocument();
    expect(screen.queryByText(/NOT WHITELISTED/i)).not.toBeInTheDocument();
  });

  it('a genuinely non-whitelisted module IS called out, with the consequence', () => {
    venueState.moduleCheck = {
      migrator: DOPPLER_MAINNET.modules.uniswapV4Migrator.address,
      state: 0,
      whitelisted: false,
      unreadable: false,
    };
    render(<GraduationVenuePanel />);
    expect(screen.getByText(/NOT WHITELISTED/i)).toBeInTheDocument();
    expect(screen.getByText(/would fail at create/i)).toBeInTheDocument();
  });

  it('with no RPC the badge says the check never ran', () => {
    venueState.moduleCheck = null;
    venueState.checkSkipped = true;
    render(<GraduationVenuePanel />);
    expect(screen.getByText(/NOT CHECKED/i)).toBeInTheDocument();
  });
});

describe('honesty guard — the fee line', () => {
  it('an all-zero read says what it checked and why zero is not "no fee owed"', () => {
    render(<GraduationVenuePanel />);
    expect(screen.getByText(/every one read back zero/i)).toBeInTheDocument();
    expect(screen.getByText(/not that no fee is owed/i)).toBeInTheDocument();
  });

  it('an unreadable balance does not render as a zero balance', () => {
    feeLineState.read = { ...baseRead, unreadable: [NATIVE] };
    render(<GraduationVenuePanel />);
    expect(screen.queryByText(/read back zero/i)).not.toBeInTheDocument();
    expect(screen.getByText(/unknown, not a zero/i)).toBeInTheDocument();
  });

  it('a hard error renders as a failed read, not an empty balance', () => {
    feeLineState.read = null;
    feeLineState.error = 'rpc down';
    render(<GraduationVenuePanel />);
    expect(screen.getByText(/failed read, not a zero balance/i)).toBeInTheDocument();
  });

  it('unreadable destinations are shown as unread rather than omitted silently', () => {
    feeLineState.read = { ...baseRead, destinations: null, destinationsUnreadable: true, pointsAtOurLocker: null };
    render(<GraduationVenuePanel />);
    expect(screen.getByText(/could not be read on-chain/i)).toBeInTheDocument();
  });

  it('offers no claim button — the release path is not buildable here', () => {
    feeLineState.read = { ...baseRead, credits: [{ currency: NATIVE, amount: 10n ** 18n }] };
    render(<GraduationVenuePanel />);
    expect(screen.queryByRole('button', { name: /claim|release|withdraw/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no claim is offered here/i)).toBeInTheDocument();
  });
});

describe('pure formatters', () => {
  it('formatLockDuration returns null rather than inventing a term', () => {
    expect(formatLockDuration(null)).toBeNull();
    expect(formatLockDuration(0)).toBeNull();
    expect(formatLockDuration(NaN)).toBeNull();
    expect(formatLockDuration(365 * 24 * 3600)).toBe('12 months');
  });

  it('formatCredit refuses to assume 18 decimals for an unknown token', () => {
    expect(formatCredit({ currency: NATIVE, amount: 10n ** 18n })).toMatch(/ETH/);
    const unknown = formatCredit({ currency: '0x00000000000000000000000000000000000000cc' as Address, amount: 1234n });
    expect(unknown).toContain('1234');
    expect(unknown).toMatch(/decimals not read/i);
  });
});
