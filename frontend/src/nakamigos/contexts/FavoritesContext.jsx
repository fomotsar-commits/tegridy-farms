import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { useActiveCollection } from "./CollectionContext";

const FavoritesContext = createContext(undefined);

function loadFavorites(slug) {
  try { return JSON.parse(localStorage.getItem(`${slug}_favorites`) || "[]"); } catch { return []; }
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
    setFavorites(prev => {
      const next = prev.includes(tokenId) ? prev.filter(id => id !== tokenId) : [...prev, tokenId];
      saveFavorites(next, slug);
      return next;
    });
  }, [slug]);

  const isFavorite = useCallback((tokenId) => favorites.includes(tokenId), [favorites]);

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
