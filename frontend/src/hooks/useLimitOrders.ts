import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';

export interface LimitOrder {
  id: string;
  fromToken: { symbol: string; address: string; decimals: number };
  toToken: { symbol: string; address: string; decimals: number };
  amount: string; // human-readable
  targetPrice: string; // price of toToken in fromToken terms
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'expired' | 'filled';
}

function getStorageKey(address: string) {
  return `tegridy_limit_orders_${address.toLowerCase()}`;
}

function loadOrders(address: string): LimitOrder[] {
  try {
    const raw = localStorage.getItem(getStorageKey(address));
    if (raw) {
      const orders: LimitOrder[] = JSON.parse(raw);
      // Mark expired orders
      const now = Date.now();
      return orders.map(o => ({
        ...o,
        status: o.status === 'active' && o.expiresAt < now ? 'expired' : o.status,
      }));
    }
  } catch {}
  return [];
}

function saveOrders(address: string, orders: LimitOrder[]) {
  try {
    localStorage.setItem(getStorageKey(address), JSON.stringify(orders));
  } catch {}
}

export function useLimitOrders() {
  const { address } = useAccount();
  const [orders, setOrders] = useState<LimitOrder[]>([]);

  useEffect(() => {
    if (!address) { setOrders([]); return; }
    setOrders(loadOrders(address));
  }, [address]);

  const createOrder = useCallback((order: Omit<LimitOrder, 'id' | 'createdAt' | 'status'>) => {
    if (!address) return;
    const newOrder: LimitOrder = {
      ...order,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      status: 'active',
    };
    const updated = [newOrder, ...orders];
    setOrders(updated);
    saveOrders(address, updated);
  }, [address, orders]);

  const cancelOrder = useCallback((id: string) => {
    if (!address) return;
    const updated = orders.filter(o => o.id !== id);
    setOrders(updated);
    saveOrders(address, updated);
  }, [address, orders]);

  const activeOrders = orders.filter(o => o.status === 'active');
  const pastOrders = orders.filter(o => o.status !== 'active');

  return { orders, activeOrders, pastOrders, createOrder, cancelOrder };
}
