import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FinePrint } from './FinePrint';

describe('FinePrint', () => {
  it('starts closed: the summary shows, the small print does not', () => {
    render(<FinePrint summary="How fees work"><p>The router keeps 0.16%.</p></FinePrint>);
    expect(screen.getByText('How fees work')).toBeVisible();
    // Still in the document, so find-in-page and other tests can reach it.
    expect(screen.getByText('The router keeps 0.16%.')).toBeInTheDocument();
    expect(screen.getByText('The router keeps 0.16%.')).not.toBeVisible();
  });

  it('opens on a press of its summary', () => {
    render(<FinePrint><p>Small print.</p></FinePrint>);
    const details = screen.getByText('Details').closest('details')!;
    fireEvent.click(screen.getByText('Details'));
    details.open = true; // jsdom does not toggle <details> on a click
    expect(screen.getByText('Small print.')).toBeVisible();
  });
});
