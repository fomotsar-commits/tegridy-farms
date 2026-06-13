import { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react";
import { useActiveCollection } from "./CollectionContext";

const CartContext = createContext(undefined);

function loadCart(slug) {
  try { return JSON.parse(localStorage.getItem(`${slug}_cart`) || "[]"); } catch { return []; }
}
function saveCart(cart, slug) {
  try { localStorage.setItem(`${slug}_cart`, JSON.stringify(cart)); } catch {}
}

export function CartProvider({ children }) {
  const collection = useActiveCollection();
  const slug = collection.slug;
  const [cart, setCart] = useState(() => loadCart(slug));

  useEffect(() => {
    setCart(loadCart(slug));
  }, [slug]);

  // Normalize the dedupe/removal key so callers that pass a raw listing or token
  // (which carries `tokenId` but not `id`) still dedupe correctly instead of
  // colliding on "undefined" and wiping every keyless item at once.
  const cartKey = (n) => String(n?.id ?? n?.tokenId);

  const addToCart = useCallback((nft) => {
    setCart(prev => {
      const key = cartKey(nft);
      if (prev.find(n => cartKey(n) === key)) return prev;
      const next = [...prev, nft];
      saveCart(next, slug);
      return next;
    });
  }, [slug]);

  const removeFromCart = useCallback((id) => {
    setCart(prev => {
      const target = String(id);
      const next = prev.filter(n => cartKey(n) !== target);
      saveCart(next, slug);
      return next;
    });
  }, [slug]);

  const clearCart = useCallback(() => {
    setCart([]);
    saveCart([], slug);
  }, [slug]);

  const saveCartBound = useCallback((items) => saveCart(items, slug), [slug]);

  const value = useMemo(
    () => ({ cart, setCart, addToCart, removeFromCart, clearCart, cartCount: cart.length, saveCart: saveCartBound }),
    [cart, setCart, addToCart, removeFromCart, clearCart, saveCartBound],
  );

  return (
    <CartContext.Provider value={value}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
