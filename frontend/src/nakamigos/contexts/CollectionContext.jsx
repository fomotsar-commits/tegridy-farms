import { createContext, useContext, useMemo } from "react";
import { COLLECTIONS, DEFAULT_COLLECTION } from "../constants";

const CollectionContext = createContext(null);

export function CollectionProvider({ slug, children }) {
  const collection = useMemo(
    () => COLLECTIONS[slug] || COLLECTIONS[DEFAULT_COLLECTION],
    [slug],
  );

  return (
    <CollectionContext.Provider value={collection}>
      {children}
    </CollectionContext.Provider>
  );
}

export function useActiveCollection() {
  const ctx = useContext(CollectionContext);
  if (!ctx) return COLLECTIONS[DEFAULT_COLLECTION];
  return ctx;
}
