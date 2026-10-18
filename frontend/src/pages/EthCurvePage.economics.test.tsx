import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CurveHowItWorks } from './EthCurvePage';

// CurveHowItWorks is a prop-free explainer that carries the owner-decided
// economics — pin the load-bearing numbers here. Since 2026-08-28 it also
// packages the survival stack with in-app <Link>s, so it renders under a
// MemoryRouter (still no framer/art/providers).
describe('CurveHowItWorks', () => {
  it('states the zero-toll promise and the 50/25/25 split', () => {
    render(<MemoryRouter><CurveHowItWorks /></MemoryRouter>);
    expect(screen.getByText(/Zero third-party tolls/i)).toBeInTheDocument();
    expect(screen.getByText(/50 \/ 25 \/ 25/)).toBeInTheDocument();
    expect(screen.getByText(/1% trade fee: 50% to the creator, 25% to the Jungle Bay treasury, 25% to the protocol\./)).toBeInTheDocument();
    expect(screen.getByText(/100% of the 1% trade fee/i)).toBeInTheDocument();
  });

  it('states graduate-to-us with burned LP and the 3.69% reserve', () => {
    render(<MemoryRouter><CurveHowItWorks /></MemoryRouter>);
    expect(screen.getByText(/Graduate to us/i)).toBeInTheDocument();
    expect(screen.getByText(/burned to 0x…dEaD/i)).toBeInTheDocument();
    expect(screen.getByText(/3\.69% ecosystem reserve/i)).toBeInTheDocument();
    // Honesty: the reserve's use is discretionary, not contract-enforced — say so.
    expect(screen.getByText(/not enforced on-chain/i)).toBeInTheDocument();
  });
});
