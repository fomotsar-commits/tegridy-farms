/**
 * WAVE SEVEN, row S: THE CONSENT ASK IS A FOOTER ROW.
 *
 * The island's done-means: the row is present while the six-route overlay sweep
 * (e2e/arrival.spec.ts) stays green, and the storage key appears in no rendered
 * text node. The e2e holds the first half and the key across real routes; this
 * file pins the component, which is where the key used to be printed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConsentRow } from './ConsentRow';
import { getConsent } from '../../lib/consent';

const KEY = 'tegridy_telemetry_consent';
const LINE = 'Analytics are anonymous and off until you say yes.';

beforeEach(() => localStorage.clear());

describe('ConsentRow', () => {
  it('asks in one line and answers in two words', () => {
    render(<ConsentRow />);
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Yes', 'No']);
  });

  it('never prints the storage key it writes to', () => {
    const { container } = render(<ConsentRow />);
    expect(container.textContent ?? '').not.toContain(KEY);
  });

  it('is a group named by its sentence, never a dialog, never over content', () => {
    const { container } = render(<ConsentRow />);
    expect(screen.getByRole('group', { name: LINE })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
      expect(el.className, el.outerHTML.slice(0, 80)).not.toMatch(/(^|\s)(fixed|sticky|absolute)(\s|$)|z-\[/);
      expect(el.style.position).toBe('');
    }
  });

  it('gives both words a 44px target', () => {
    render(<ConsentRow />);
    for (const name of ['Yes', 'No']) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-[44px]');
    }
  });

  it('Yes grants, No denies, and either answer takes the row away', () => {
    const yes = render(<ConsentRow />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(getConsent()).toBe('granted');
    expect(yes.container.textContent).toBe('');
    yes.unmount();

    localStorage.clear();
    const no = render(<ConsentRow />);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(getConsent()).toBe('denied');
    expect(no.container.textContent).toBe('');
  });

  it('renders nothing once the visitor has answered', () => {
    localStorage.setItem(KEY, 'denied');
    const { container } = render(<ConsentRow />);
    expect(container.firstChild).toBeNull();
  });
});
