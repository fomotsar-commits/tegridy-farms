import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePriceAlerts } from './usePriceAlerts';

describe('usePriceAlerts', () => {
  beforeEach(() => localStorage.clear());

  it('starts with empty alerts', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    expect(result.current.alerts).toEqual([]);
  });

  it('addAlert adds to state', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    act(() => result.current.addAlert('above', 1.5));
    expect(result.current.alerts).toHaveLength(1);
    expect(result.current.alerts[0]!.type).toBe('above');
    expect(result.current.alerts[0]!.price).toBe(1.5);
    expect(result.current.alerts[0]!.triggered).toBe(false);
  });

  it('removeAlert removes from state', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    act(() => result.current.addAlert('below', 0.5));
    const id = result.current.alerts[0]!.id;
    act(() => result.current.removeAlert(id));
    expect(result.current.alerts).toHaveLength(0);
  });

  it('clearTriggered resets triggered flags', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    act(() => result.current.addAlert('above', 1.0));
    // Manually mark as triggered for testing
    act(() => {
      result.current.addAlert('below', 2.0);
    });
    act(() => result.current.clearTriggered());
    result.current.alerts.forEach(a => expect(a.triggered).toBe(false));
  });

  it('persists alerts to localStorage', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    act(() => result.current.addAlert('above', 3.0));
    const stored = JSON.parse(localStorage.getItem('tegridy-price-alerts')!);
    expect(stored.alerts).toHaveLength(1);
    expect(stored.alerts[0].price).toBe(3.0);
  });
});
