import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CurveHowItWorks } from './EthCurvePage';

// CurveHowItWorks is a pure, prop-free explainer (plain divs, no framer/art), so
// it renders standalone. It's the copy that carries the owner-decided economics,
// so pin the load-bearing numbers here.
describe('CurveHowItWorks', () => {
  it('states the zero-toll promise and the 40/25/35 split', () => {
    render(<CurveHowItWorks />);
    expect(screen.getByText(/Zero third-party tolls/i)).toBeInTheDocument();
    expect(screen.getByText(/40 \/ 25 \/ 35/)).toBeInTheDocument();
    expect(screen.getByText(/100% of the 1% trade fee/i)).toBeInTheDocument();
  });

  it('states graduate-to-us with burned LP and the 3.69% reserve', () => {
    render(<CurveHowItWorks />);
    expect(screen.getByText(/Graduate to us/i)).toBeInTheDocument();
    expect(screen.getByText(/burned to 0x…dEaD/i)).toBeInTheDocument();
    expect(screen.getByText(/3\.69% survival reserve/i)).toBeInTheDocument();
  });
});
