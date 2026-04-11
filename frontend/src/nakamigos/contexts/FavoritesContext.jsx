import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { useActiveCollection } from "./CollectionContext";

const FavoritesContext = createContext(undefined);

function loadFavorites(slug) {
  try { return JSON.parse(localStorage.getItem(`${slug}_favorites`) || "[]").map(String); } catch { return []; }
}
function saveFavorites(favs, slug) {
  try { localStorage.setItem(`${slug}_favorites`, JSON.stringify(favs)); } catch {}
}

export function FavoritesProvider({ children }) {
  const collection = useActiveCollection();
  const slug = collection.slug;
  const [favorites, setFavorites] = useState(() => loadFavorites(slug));

  useEffect(() => {
    setFavorites(loadFavorites(slug));
  }, [slug]);

  const toggleFavorite = useCallback((tokenId) => {
    const id = String(tokenId); // normalize to string to prevent number/string mismatch after JSON roundtrip
    setFavorites(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      saveFavorites(next, slug);
      return next;
    });
  }, [slug]);

  const isFavorite = useCallback((tokenId) => favorites.includes(String(tokenId)), [favorites]);

  return (
    <FavoritesContext.Provider value={{ favorites, setFavorites, toggleFavorite, isFavorite, saveFavorites: (favs) => saveFavorites(favs, slug) }}>
      {children}
    </FavoritesContext.Provider>
  );
}

export function useFavorites() {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error("useFavorites must be used within FavoritesProvider");
  return ctx;
}
