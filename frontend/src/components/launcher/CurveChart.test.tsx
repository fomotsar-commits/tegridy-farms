import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CurveChart, UNPLOTTABLE_COPY, type CurveChartState } from './CurveChart';
import type { CurveSnapshot } from '../../lib/launcher/solana/curvePoints';

// Program test parameters — tests/tegridy-launch-constraints.test.ts:56-68.
const V_SOL = 30_000_000_000n;
const V_TOK = 1_073_000_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;
const GRAD_TARGET = 11_544_610_844n;
const MIGRATION_RESERVE = 500_000_000n;

const FRESH: CurveSnapshot = {
  virtualSolReserves: V_SOL,
  virtualTokenReserves: V_TOK,
  realSolReserves: 0n,
  realTokenReserves: SUPPLY,
  tradeFeeBps: 100n,
  graduationTargetLamports: GRAD_TARGET,
  migrationReserveLamports: MIGRATION_RESERVE,
  complete: false,
};

const ready = (curve: CurveSnapshot): CurveChartState => ({
  status: 'ready',
  curve,
  source: { kind: 'chain' },
});

describe('CurveChart — honest states', () => {
  it('says the program is not deployed and draws nothing', () => {
    const { container } = render(<CurveChart state={{ status: 'not-deployed' }} />);
    expect(screen.getByText(/not deployed/i)).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a failed read as a failed read, never as zero', () => {
    render(<CurveChart state={{ status: 'unreadable', detail: 'RPC timed out' }} />);
    expect(screen.getByText(/could not be read/i)).toBeTruthy();
    expect(screen.getByText(/RPC timed out/)).toBeTruthy();
    expect(screen.queryByText(/0\.0000 SOL/)).toBeNull();
    expect(screen.queryByText(/0\.0%/)).toBeNull();
  });

  it('distinguishes "no curve for this mint" from a launch that raised nothing', () => {
    render(<CurveChart state={{ status: 'no-curve' }} />);
    expect(screen.getByText(/has no bonding-curve account/i)).toBeTruthy();
    expect(screen.queryByText(/SOL raised/i)).toBeNull();
  });

  it('refuses to plot a graduated curve and says why', () => {
    render(<CurveChart state={ready({ ...FRESH, realSolReserves: 0n, realTokenReserves: 0n, complete: true })} />);
    expect(screen.getByText(UNPLOTTABLE_COPY.graduated)).toBeTruthy();
    expect(screen.queryByText(/0\.0%/)).toBeNull();
  });

  it('badges an illustrative curve so a shape is never mistaken for a market', () => {
    render(
      <CurveChart
        state={{ status: 'ready', curve: FRESH, source: { kind: 'illustrative', note: "Program defaults." } }}
      />,
    );
    expect(screen.getByText(/Illustrative shape/i)).toBeTruthy();
  });

  it('shows no illustrative badge for a real chain read', () => {
    render(<CurveChart state={ready(FRESH)} />);
    expect(screen.queryByText(/Illustrative shape/i)).toBeNull();
  });
});

describe('CurveChart — plotted curve', () => {
  it('draws the curve, the position marker and the graduation line', () => {
    const { container } = render(<CurveChart state={ready(FRESH)} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(svg!.querySelectorAll('circle').length).toBe(1);
    // baseline + target + ceiling + current guide
    expect(svg!.querySelectorAll('line').length).toBe(4);
  });

  it('measures progress against target + reserve, so a met target is not 100%', () => {
    render(<CurveChart state={ready({ ...FRESH, realSolReserves: GRAD_TARGET })} />);
    expect(screen.getByText('95.8%')).toBeTruthy();
    expect(screen.queryByText('100.0%')).toBeNull();
  });

  it('calls a fully funded curve fully funded and awaiting migration, not complete', () => {
    render(<CurveChart state={ready({ ...FRESH, realSolReserves: GRAD_TARGET + MIGRATION_RESERVE })} />);
    expect(screen.getByText('fully funded')).toBeTruthy();
    expect(screen.getByText(/awaiting migration/i)).toBeTruthy();
  });

  it('labels the spot price in base units when the mint decimals were not read', () => {
    render(<CurveChart state={ready(FRESH)} />);
    expect(screen.getByText('lamports per base unit')).toBeTruthy();
    expect(screen.queryByText('SOL per token')).toBeNull();
  });

  it('switches to SOL per token only once decimals are supplied', () => {
    render(<CurveChart state={ready(FRESH)} tokenDecimals={6} />);
    expect(screen.getByText('SOL per token')).toBeTruthy();
  });

  it('states plainly that no history is shown', () => {
    render(<CurveChart state={ready(FRESH)} />);
    expect(screen.getByText(/shape, not its history/i)).toBeTruthy();
  });

  it('gives two charts distinct gradient ids so one cannot steal the other fill', () => {
    const { container } = render(
      <>
        <CurveChart state={ready(FRESH)} />
        <CurveChart state={ready(FRESH)} />
      </>,
    );
    const ids = [...container.querySelectorAll('linearGradient')].map((el) => el.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
  });
});
