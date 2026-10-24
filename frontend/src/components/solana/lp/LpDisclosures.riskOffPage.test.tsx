// THE VAULT RISK, OFF THE PAGE (owner, 2026-10-17: "remove this warning from everywhere").
// The sentence that sat in an amber box on the forms and the review now leads each closed
// Risks drop-down, word for word: never on screen before a press, never twice on one form.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LpBeforeYouAdd, LpBeforeYouOpen, LpReviewDisclosure, RISK_SHORT } from './LpDisclosures';

/** Every place the sentence is drawn is inside a closed <details>, and it is drawn once. */
function onlyBehindAPress() {
  const found = screen.getAllByText(RISK_SHORT);
  expect(found).toHaveLength(1);
  const box = found[0]!.closest('details');
  expect(box, 'the sentence sits in a drop-down').not.toBeNull();
  expect(box).not.toHaveAttribute('open');
  expect(box!.querySelector('summary')).toHaveTextContent('Risks');
}

describe('the vault sentence is behind a press', () => {
  it('on the Add liquidity form', () => {
    render(<LpBeforeYouAdd launchPool={false} config={null} enableCreatorFee={false} />);
    onlyBehindAPress();
  });

  it('on the Open a pool form', () => {
    render(<LpBeforeYouOpen fee={150_000_000n} neverRefunded={null} />);
    onlyBehindAPress();
  });

  it('on the review, for an add and for an opening', () => {
    const view = render(<LpReviewDisclosure kind="add" origin="standard" />);
    onlyBehindAPress();
    view.unmount();
    render(<LpReviewDisclosure kind="create" />);
    onlyBehindAPress();
  });
});
