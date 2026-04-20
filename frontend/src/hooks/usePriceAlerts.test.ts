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

  it('triggers "above" alert when price crosses up', () => {
    const { result, rerender } = renderHook(
      ({ price }) => usePriceAlerts(price),
      { initialProps: { price: 1.0 } },
    );
    act(() => result.current.addAlert('above', 1.5));
    expect(result.current.alerts[0]!.triggered).toBe(false);
    // Price crosses above threshold
    rerender({ price: 1.6 });
    expect(result.current.alerts[0]!.triggered).toBe(true);
  });

  it('triggers "below" alert when price crosses down', () => {
    const { result, rerender } = renderHook(
      ({ price }) => usePriceAlerts(price),
      { initialProps: { price: 2.0 } },
    );
    act(() => result.current.addAlert('below', 1.5));
    expect(result.current.alerts[0]!.triggered).toBe(false);
    // Price crosses below threshold
    rerender({ price: 1.4 });
    expect(result.current.alerts[0]!.triggered).toBe(true);
  });

  it('already-triggered alerts do not re-fire', () => {
    const { result, rerender } = renderHook(
      ({ price }) => usePriceAlerts(price),
      { initialProps: { price: 1.0 } },
    );
    act(() => result.current.addAlert('above', 1.5));
    // Trigger it
    rerender({ price: 1.6 });
    expect(result.current.alerts[0]!.triggered).toBe(true);
    // Move price below and back above — should stay triggered, not re-fire
    rerender({ price: 1.0 });
    rerender({ price: 1.6 });
    expect(result.current.alerts[0]!.triggered).toBe(true);
    // Still only 1 alert
    expect(result.current.alerts).toHaveLength(1);
  });

  it('multiple alerts can coexist independently', () => {
    const { result, rerender } = renderHook(
      ({ price }) => usePriceAlerts(price),
      { initialProps: { price: 1.0 } },
    );
    act(() => {
      result.current.addAlert('above', 2.0);
      result.current.addAlert('below', 0.5);
    });
    expect(result.current.alerts).toHaveLength(2);
    // Only trigger the above alert
    rerender({ price: 2.1 });
    const above = result.current.alerts.find(a => a.type === 'above');
    const below = result.current.alerts.find(a => a.type === 'below');
    expect(above!.triggered).toBe(true);
    expect(below!.triggered).toBe(false);
  });

  it('does not trigger for zero or negative price', () => {
    const { result, rerender } = renderHook(
      ({ price }) => usePriceAlerts(price),
      { initialProps: { price: 1.0 } },
    );
    act(() => result.current.addAlert('below', 0.5));
    // Price goes to 0 — the hook guards against currentPrice <= 0
    rerender({ price: 0 });
    expect(result.current.alerts[0]!.triggered).toBe(false);
    rerender({ price: -1 });
    expect(result.current.alerts[0]!.triggered).toBe(false);
  });

  it('loads alerts from localStorage on mount', () => {
    const stored = {
      alerts: [
        { id: 'above-1-123', type: 'above', price: 5.0, triggered: false },
      ],
    };
    localStorage.setItem('tegridy-price-alerts', JSON.stringify(stored));
    const { result } = renderHook(() => usePriceAlerts(0));
    expect(result.current.alerts).toHaveLength(1);
    expect(result.current.alerts[0]!.price).toBe(5.0);
  });

  it('deduplicates alerts by (type, price) to 6 decimal places', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    act(() => result.current.addAlert('above', 1.23456789));
    act(() => result.current.addAlert('above', 1.23456789));
    // Same direction + same price (rounded to 6dp) is a no-op.
    expect(result.current.alerts).toHaveLength(1);
    // A different direction at the same price is still its own alert.
    act(() => result.current.addAlert('below', 1.23456789));
    expect(result.current.alerts).toHaveLength(2);
    // A meaningfully different price (distinct at 6dp) also adds.
    act(() => result.current.addAlert('above', 1.234570));
    expect(result.current.alerts).toHaveLength(3);
  });

  it('caps alerts per wallet at the MAX_ALERTS ceiling', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    // Add exactly MAX_ALERTS unique above-alerts; next one is rejected.
    act(() => {
      for (let i = 1; i <= 20; i++) result.current.addAlert('above', i);
    });
    expect(result.current.alerts).toHaveLength(20);
    act(() => result.current.addAlert('above', 999));
    expect(result.current.alerts).toHaveLength(20);
  });

  it('rejects non-positive / non-finite price thresholds', () => {
    const { result } = renderHook(() => usePriceAlerts(0));
    act(() => result.current.addAlert('above', 0));
    act(() => result.current.addAlert('above', -1));
    act(() => result.current.addAlert('above', Number.NaN));
    act(() => result.current.addAlert('above', Number.POSITIVE_INFINITY));
    expect(result.current.alerts).toHaveLength(0);
  });
});
