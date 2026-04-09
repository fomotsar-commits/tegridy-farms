import { createContext, useContext, useState, useCallback, useEffect } from "react";
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

  const addToCart = useCallback((nft) => {
    setCart(prev => {
      if (prev.find(n => String(n.id) === String(nft.id))) return prev;
      const next = [...prev, nft];
      saveCart(next, slug);
      return next;
    });
  }, [slug]);

  const removeFromCart = useCallback((id) => {
    setCart(prev => {
      const next = prev.filter(n => String(n.id) !== String(id));
      saveCart(next, slug);
      return next;
    });
  }, [slug]);

  const clearCart = useCallback(() => {
    setCart([]);
    saveCart([], slug);
  }, [slug]);

  return (
    <CartContext.Provider value={{ cart, setCart, addToCart, removeFromCart, clearCart, cartCount: cart.length, saveCart: (items) => saveCart(items, slug) }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
