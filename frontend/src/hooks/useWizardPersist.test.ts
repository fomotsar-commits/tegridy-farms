import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWizardPersist } from './useWizardPersist';
import { initialState } from '../components/launchpad/wizard/wizardReducer';
import type { WizardState } from '../components/launchpad/wizard/wizardReducer';

const STORAGE_KEY = 'tegridy:launchpad:draft';

describe('useWizardPersist (F251 — no pristine clobber)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('does NOT overwrite a stored draft while the wizard is still pristine', () => {
    // Simulate a previously-saved draft (e.g. from a prior session).
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, savedAt: 123, payload: { collectionName: 'Saved Work' } }),
    );

    // Mount with the pristine initialState — the throttled save must NOT fire.
    renderHook(() => useWizardPersist(initialState));
    vi.advanceTimersByTime(1000);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    // The original draft survives untouched.
    expect(parsed.payload.collectionName).toBe('Saved Work');
  });

  it('persists once the wizard diverges from initialState', () => {
    const dirty: WizardState = { ...initialState, collectionName: 'My Collection' };
    renderHook(() => useWizardPersist(dirty));
    vi.advanceTimersByTime(1000);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.payload.collectionName).toBe('My Collection');
  });
});
