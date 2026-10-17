/**
 * The Privacy page and error reports (owner's decisions, 2026-10-02).
 *
 * Section 9 of this page promises that a change which broadens what we collect is
 * "called out at the top of this page for at least 14 days". Storing error reports on our
 * server is such a change, so the page carries that notice from 2026-10-02, and nothing
 * is sent or stored before 2026-10-16. Sections 3 and 5 say exactly what a report holds
 * and that it is kept 30 days, then deleted automatically.
 *
 * The date and the 30 days are read from api/_lib/errorPolicy.js, the constants the
 * browser and the server enforce, so the page cannot promise one thing while the code
 * does another.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrivacyPage from './PrivacyPage';
import {
  ANALYTICS_RETENTION_DAYS,
  ERROR_REPORTING_STARTS_AT,
  ERROR_RETENTION_DAYS,
} from '../../api/_lib/errorPolicy.js';

const EFFECTIVE = new Date(ERROR_REPORTING_STARTS_AT).toLocaleDateString('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const KEPT = `${ERROR_RETENTION_DAYS} days`;
const ANALYTICS_KEPT = `${ANALYTICS_RETENTION_DAYS} days`;

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ');
const section = (id: string) => {
  const el = document.getElementById(id);
  expect(el, `section #${id}`).not.toBeNull();
  return text(el);
};

describe('Privacy page: notice of the error-report change', () => {
  it('reads the date and the retention from the enforced constants', () => {
    expect(EFFECTIVE).toBe('16 October 2026');
    expect(KEPT).toBe('30 days');
  });

  it('is at the top of the page, before section 1', () => {
    render(<PrivacyPage />);
    const notice = screen.getByRole('note');
    const first = document.getElementById('information-we-collect');
    expect(first).not.toBeNull();
    expect(notice.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says what changes, when, and for how long, in plain words with no em dash', () => {
    render(<PrivacyPage />);
    const notice = screen.getByRole('note');
    const t = text(notice);
    expect(notice).toHaveAccessibleName(new RegExp(EFFECTIVE));
    expect(t).toContain(EFFECTIVE);
    expect(t).toMatch(/error report/i);
    expect(t).toContain(KEPT);
    expect(t).toMatch(/deleted automatically/i);
    expect(t).toMatch(/only if you (have )?opt(ed)? in|only while you have opted in|if you have opted in/i);
    expect(t).toMatch(/until 16 October 2026,? no error report is sent/i);
    expect(t).not.toContain('—');
  });

  it('names section 9, the promise it keeps', () => {
    render(<PrivacyPage />);
    expect(text(screen.getByRole('note'))).toMatch(/section 9/i);
  });
});

describe('Privacy page: sections 3 and 5 say exactly what is stored, and for how long', () => {
  it('section 3 lists every stored field, the start date and the 30 days', () => {
    render(<PrivacyPage />);
    const s3 = section('analytics');
    const errors = s3.slice(s3.indexOf('Separately'));
    expect(errors.length).toBeGreaterThan(200);
    for (const field of [
      'the error message',
      'the stack trace',
      'the component stack',
      'the page address',
      'the time the error happened',
      'the time our server received it',
    ]) {
      expect(errors).toContain(field);
    }
    expect(errors).toContain(EFFECTIVE);
    expect(errors).toContain(`kept for ${KEPT} and then deleted automatically`);
    expect(errors).not.toContain('—');
  });

  it('section 5 lists error_events with what it holds and the 30 days', () => {
    render(<PrivacyPage />);
    const s5 = section('data-storage');
    const start = s5.indexOf('`error_events`');
    expect(start).toBeGreaterThan(-1);
    const entry = s5.slice(start, s5.indexOf(')', start) + 1);
    for (const field of ['message', 'stack', 'page address', 'time']) expect(entry).toContain(field);
    expect(entry).toContain(EFFECTIVE);
    expect(entry).toContain(`kept for ${KEPT} and then deleted automatically`);
    expect(entry).not.toContain('—');
  });
});

/**
 * Analytics events (owner's decision, 2026-10-03): kept 90 days, then deleted
 * automatically, by the same hourly job as error reports. The 90 days is read from
 * ANALYTICS_RETENTION_DAYS, the constant the purge measures from. Shortening how long we
 * keep something narrows what we hold, so section 9's 14-day notice does not apply and
 * there is no notice for it at the top of the page.
 */
describe('Privacy page: analytics events are kept 90 days, then deleted automatically', () => {
  it('reads the 90 days from the enforced constant', () => {
    expect(ANALYTICS_KEPT).toBe('90 days');
  });

  it('section 3 says so for analytics events, apart from the error reports', () => {
    render(<PrivacyPage />);
    const s3 = section('analytics');
    const analytics = s3.slice(0, s3.indexOf('Separately'));
    expect(analytics).toMatch(/event records/i);
    expect(analytics).toContain(`kept for ${ANALYTICS_KEPT} and then deleted automatically`);
    // The 30 days belongs to error reports alone; the analytics half must not borrow it.
    expect(analytics).not.toContain(KEPT);
    expect(s3.slice(s3.indexOf('Separately'))).not.toContain(ANALYTICS_KEPT);
  });

  it('section 5 lists analytics_events with what it holds and the 90 days', () => {
    render(<PrivacyPage />);
    const s5 = section('data-storage');
    const start = s5.indexOf('`analytics_events`');
    expect(start).toBeGreaterThan(-1);
    const entry = s5.slice(start, s5.indexOf(')', start) + 1);
    for (const field of ['event', 'session identifier', 'time']) expect(entry).toContain(field);
    expect(entry).toContain('no wallet address');
    expect(entry).toContain(`kept for ${ANALYTICS_KEPT} and then deleted automatically`);
    expect(entry).not.toContain(KEPT);
    expect(entry).not.toContain('—');
  });
});
