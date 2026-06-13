import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fetchTokensByIds } from "./api";
// CSS imported eagerly in main.tsx to avoid Vite CSS preload errors on lazy chunks
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { TradingModeProvider, useTradingMode, LITE_HIDDEN_ALL } from "./contexts/TradingModeContext";
import { WalletProvider, useWallet } from "./contexts/WalletContext";
import { CollectionProvider, useActiveCollection } from "./contexts/CollectionContext";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import { FavoritesProvider, useFavorites } from "./contexts/FavoritesContext";
import { CartProvider, useCart } from "./contexts/CartContext";
import { COLLECTIONS, DEFAULT_COLLECTION, VALID_TABS } from "./constants";
import Background from "./components/Background";
import Header from "./components/Header";
import Hero from "./components/Hero";
import Gallery from "./components/Gallery";
import Toast from "./components/Toast";
import NftMarquee from "./components/NftMarquee";
import SplashScreen from "./components/SplashScreen";
import PageTransition from "./components/PageTransition";
import PriceAlertPanel, { usePriceAlerts } from "./components/PriceAlerts";
import useSmartAlerts from "./hooks/useSmartAlerts";
import ErrorBoundary from "./components/ErrorBoundary";
import NotFound from "./components/NotFound";
import MobileNav from "./components/MobileNav";
import InstallPrompt from "./components/InstallPrompt";

// Lazy-loaded: only rendered conditionally (modal open, cart open, landing route)
const Modal = lazy(() => import("./components/Modal"));
const ShoppingCart = lazy(() => import("./components/ShoppingCart"));
const NotificationCenter = lazy(() => import("./components/NotificationCenter"));
const CollectionLanding = lazy(() => import("./components/CollectionLanding"));
import { GallerySkeleton } from "./components/SkeletonFallback";
import useNfts from "./hooks/useNfts";
import useCollection from "./hooks/useCollection";
import useListings from "./hooks/useListings";
import useSound from "./hooks/useSound";
import useHolderStatus from "./hooks/useHolderStatus.jsx";
import useDmUnread from "./hooks/useDmUnread";
// Lazy-imported to avoid pulling @supabase/supabase-js into the initial bundle.
// These are only needed after wallet connect / user interaction.
const getUserdata = () => import("./lib/userdata");


// Lazy-loaded tab components (code-split to reduce initial bundle)
const About = lazy(() => import("./components/About"));
const Analytics = lazy(() => import("./components/Analytics"));
const MyCollection = lazy(() => import("./components/MyCollection"));
const Listings = lazy(() => import("./components/Listings"));
const TraitExplorer = lazy(() => import("./components/TraitExplorer"));
const ActivityFeed = lazy(() => import("./components/ActivityFeed"));
const Favorites = lazy(() => import("./components/Favorites"));
const NftCompare = lazy(() => import("./components/NftCompare"));
const TradesPanel = lazy(() => import("./components/TradesPanel"));
const Watchlist = lazy(() => import("./components/Watchlist"));
const BidManager = lazy(() => import("./components/BidManager"));
const MyListings = lazy(() => import("./components/MyListings"));
const WhaleIntelligence = lazy(() => import("./components/WhaleIntelligence"));
const CommunityChat = lazy(() => import("./components/CommunityChat"));
const TransactionHistory = lazy(() => import("./components/TransactionHistory"));
const RaritySniper = lazy(() => import("./components/RaritySniper"));
const TheaterMode = lazy(() => import("./components/TheaterMode"));
const OnChainProfile = lazy(() => import("./components/OnChainProfile"));
const WalletModal = lazy(() => import("./components/WalletModal"));
const ShareCard = lazy(() => import("./components/ShareCard"));
const KeyboardHelp = lazy(() => import("./components/KeyboardHelp"));
const Onboarding = lazy(() => import("./components/Onboarding"));
const PortfolioTracker = lazy(() => import("./components/PortfolioTracker"));
const EditProfile = lazy(() => import("./components/EditProfile"));
const Deals = lazy(() => import("./components/Deals"));

// LazyFallback uses the shared GallerySkeleton from SkeletonFallback.jsx
const LazyFallback = GallerySkeleton;

// Tab → dynamic-import thunk, used to warm the lazy chunk on nav hover/focus so
// the first visit to a tab doesn't pay a chunk download + skeleton flash (F555).
// Vite dedupes import() so this resolves to the same module the lazy() loads.
const TAB_PREFETCH = {
  about: () => import("./components/About"),
  analytics: () => import("./components/Analytics"),
  collection: () => import("./components/MyCollection"),
  listings: () => import("./components/Listings"),
  traits: () => import("./components/TraitExplorer"),
  activity: () => import("./components/ActivityFeed"),
  favorites: () => import("./components/Favorites"),
  trade: () => import("./components/NftCompare"),
  trades: () => import("./components/TradesPanel"),
  watchlist: () => import("./components/Watchlist"),
  bids: () => import("./components/BidManager"),
  "my-listings": () => import("./components/MyListings"),
  whales: () => import("./components/WhaleIntelligence"),
  chat: () => import("./components/CommunityChat"),
  history: () => import("./components/TransactionHistory"),
  sniper: () => import("./components/RaritySniper"),
  portfolio: () => import("./components/PortfolioTracker"),
  deals: () => import("./components/Deals"),
};
function prefetchTab(tabKey) {
  TAB_PREFETCH[tabKey]?.().catch(() => { /* prefetch is best-effort */ });
}

// ═══ Route-based tab mapping (multi-collection: /:collection/:tab) ═══
// VALID_TABS lives in constants.js so navRouting.test.jsx can enforce that
// every nav target routes without importing the whole app tree.

function parseRoute(pathname) {
  // Strip the /nakamigos prefix when embedded in Tegriddy Farms
  const stripped = pathname.replace(/^\/nakamigos\/?/, "/");
  const segments = stripped.replace(/^\//, "").split("/").filter(Boolean);

  // "/" — landing page
  if (segments.length === 0) return { collectionSlug: null, tab: "landing", tokenId: null };

  const first = segments[0];

  // Check if the first segment is a known collection slug
  if (COLLECTIONS[first]) {
    // Bare /:collection (and the trailing-slash form the Gallery nav produces)
    // resolves to the gallery — the default tab. Previously defaulted to
    // "listings", which made the Gallery nav button + "G" hotkey land on
    // Listings (F607).
    const second = segments[1] || "gallery";
    // Deep link: /:collection/nft/:id
    if (second === "nft" && segments[2]) {
      // Strict digits only — parseInt("12abc") === 12 would resolve a junk
      // segment to a real token (F547). Mirrors the ?token= reader's regex.
      const seg = segments[2];
      return { collectionSlug: first, tab: "gallery", tokenId: /^\d{1,10}$/.test(seg) ? seg : null };
    }
    const tab = VALID_TABS.includes(second) ? second : "404";
    return { collectionSlug: first, tab, tokenId: null };
  }

  // Legacy routes without collection prefix — redirect to nakamigos
  if (first === "nft" && segments[1]) {
    const seg = segments[1];
    return { collectionSlug: "nakamigos", tab: "gallery", tokenId: /^\d{1,10}$/.test(seg) ? seg : null };
  }
  if (VALID_TABS.includes(first)) {
    return { collectionSlug: "nakamigos", tab: first, tokenId: null };
  }

  return { collectionSlug: null, tab: "404", tokenId: null };
}

// Tab index for keyboard shortcuts (matches PRIMARY_NAV in Header)
const TAB_KEYS = {
  "1": "gallery",
  "2": "listings",
  "3": "traits",
  "4": "analytics",
  "5": "activity",
  "6": "collection",
};

// Service worker disabled when embedded in Tegriddy Farms
// (Tegriddy has its own SW at a different scope)

function AppInner() {
  const { theme: themeName, cycleTheme } = useTheme();
  const { address: wallet, disconnect, walletName } = useWallet();
  const location = useLocation();
  const navigate = useNavigate();

  const route = useMemo(() => parseRoute(location.pathname), [location.pathname]);
  const { collectionSlug, tab, tokenId: deepLinkTokenId } = route;

  // If we're on the landing page, render that directly (no collection context needed)
  const isLanding = tab === "landing";

  // Splash persistence is per-mount only (no sessionStorage): the user asked that
  // every entry to /nakamigos from elsewhere plays the Tradermigos splash. Because
  // NakamigosApp is lazy-loaded, leaving and returning to /nakamigos remounts it
  // and re-fires the splash. Internal route changes (landing → collection) don't
  // remount this component, so the splash only plays once per visit.
  const [splashDone, setSplashDone] = useState(false);

  // Landing page: set title and scroll to top
  useEffect(() => {
    if (isLanding) {
      document.title = "Tradermigos | NFT Collections";
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [isLanding]);

  // 404 page: set title
  useEffect(() => {
    if (tab === "404" && !collectionSlug) {
      document.title = "Not Found | Tradermigos";
    }
  }, [tab, collectionSlug]);

  // ═══ Splash screen — plays on every fresh entry to /nakamigos ═══
  if (!splashDone) {
    return <SplashScreen onComplete={() => setSplashDone(true)} />;
  }

  if (isLanding) {
    return <LandingShell themeName={themeName} onCycleTheme={cycleTheme} walletName={walletName} disconnect={disconnect} />;
  }

  // Global 404: invalid top-level slug (collectionSlug is null but tab is "404")
  if (tab === "404" && !collectionSlug) {
    return (
      <LandingShell themeName={themeName} onCycleTheme={cycleTheme} walletName={walletName} disconnect={disconnect}>
        <NotFound onGoHome={() => navigate("/nakamigos")} />
      </LandingShell>
    );
  }

  // Wrap the collection view in CollectionProvider
  return (
    <CollectionProvider slug={collectionSlug}>
      <FavoritesProvider>
      <CartProvider>
      <CollectionView
        key={collectionSlug}
        tab={tab}
        deepLinkTokenId={deepLinkTokenId}
        collectionSlug={collectionSlug}
        themeName={themeName}
        cycleTheme={cycleTheme}
        wallet={wallet}
        walletName={walletName}
        disconnect={disconnect}
      />
      </CartProvider>
      </FavoritesProvider>
    </CollectionProvider>
  );
}

// Minimal shell for the landing page
function LandingShell({ themeName, onCycleTheme, walletName, disconnect, children }) {
  const navigate = useNavigate();
  const { address } = useWallet();
  const { addToast } = useToast();
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const handleDisconnect = useCallback(() => {
    disconnect();
    addToast("Wallet disconnected", "info");
  }, [disconnect, addToast]);

  return (
    <div style={{ minHeight: "100vh", background: "transparent", color: "var(--text)", fontFamily: "var(--display)", position: "relative" }}>
      <Background />
      <Header
        tab="landing"
        setTab={(t) => navigate(`/nakamigos/${DEFAULT_COLLECTION}/${t}`)}
        wallet={address}
        setWallet={handleDisconnect}
        onConnect={() => setWalletModalOpen(true)}
        activities={[]}
        isLive={false}
        cartCount={0}
        onCartToggle={() => {}}
        themeName={themeName}
        onCycleTheme={onCycleTheme}
        walletName={walletName}
        lastRefresh={null}
        isLanding={true}
      />
      <main id="main-content" role="main">
        {children || <Suspense fallback={<LazyFallback />}><CollectionLanding /></Suspense>}
      </main>
      {walletModalOpen && (
        <Suspense fallback={null}>
          <WalletModal onClose={() => setWalletModalOpen(false)} addToast={addToast} />
        </Suspense>
      )}
    </div>
  );
}

function CollectionView({ tab, deepLinkTokenId, collectionSlug, themeName, cycleTheme, wallet, walletName, disconnect }) {
  const collection = useActiveCollection();
  const location = useLocation();
  const navigate = useNavigate();
  const { toggleMode: toggleTradingMode, isLite } = useTradingMode();
  const { isWrongNetwork, switchChain } = useWallet();

  const { toasts, addToast, removeToast } = useToast();

  const { favorites, setFavorites, toggleFavorite: ctxToggleFavorite, isFavorite, saveFavorites } = useFavorites();
  const { cart, setCart, addToCart: ctxAddToCart, removeFromCart: ctxRemoveFromCart, clearCart: ctxClearCart, saveCart } = useCart();

  const [selected, setSelected] = useState(null);
  const [showTop, setShowTop] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [theaterNft, setTheaterNft] = useState(null);
  const [profileAddress, setProfileAddress] = useState(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [shareNft, setShareNft] = useState(null);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const focusIndexRef = useRef(-1);

  const { play, muted, toggleMute } = useSound();
  const { stats, activities, activitiesLoading, activitiesEmpty, isLive, isWebSocketConnected } = useCollection();

  // Global DM badge + "open DMs" signal for the chat tab
  const [dmSignal, setDmSignal] = useState(0);
  const { unread: dmUnread } = useDmUnread(wallet, {
    onNew: () => addToast?.("📩 New direct message", "info"),
  });

  const nfts = useNfts({ onChainSupply: stats?.supply });

  const tokenParamHandled = useRef(false);

  // ── Shareable NFT deep link: ?token=<id> ↔ the detail modal ──
  // The edge middleware serves unfurl bots a per-token OG card for the same
  // URL, so the modal's copy-link button produces a link that previews.
  useEffect(() => {
    const url = new URL(window.location.href);
    const current = url.searchParams.get("token");
    const next = selected?.id != null ? String(selected.id) : null;
    if (current === next) return;
    // Don't strip an incoming ?token before the read effect below has consumed
    // it: this effect runs first on mount (declared earlier) and, with selected
    // still null, used to delete the param during splash click-through before it
    // could open the modal (F608). Let the read effect win the race.
    if (!next && current && !tokenParamHandled.current) return;
    if (next) url.searchParams.set("token", next);
    else url.searchParams.delete("token");
    window.history.replaceState({}, "", url);
  }, [selected?.id]);

  useEffect(() => {
    if (tokenParamHandled.current) return;
    const id = new URLSearchParams(window.location.search).get("token");
    if (!id || !/^\d{1,10}$/.test(id)) { tokenParamHandled.current = true; return; }
    const loaded = nfts.allTokens?.find((t) => String(t.id) === id);
    if (loaded) {
      tokenParamHandled.current = true;
      setSelected(loaded);
      return;
    }
    // Token outside the loaded pages — fetch it directly once tokens exist
    // (waiting for the first page proves the API path is up).
    if (nfts.allTokens?.length) {
      tokenParamHandled.current = true;
      fetchTokensByIds([id], collection.contract, collection.metadataBase)
        .then((arr) => { if (arr?.[0]) setSelected(arr[0]); })
        .catch(() => { /* bad/burned id — deep link is best-effort */ });
    }
  }, [nfts.allTokens, collection.contract, collection.metadataBase]);
  const { listings, listingsLoading, listingsError, listingsSource, refreshListings, lastRefresh } = useListings();
  const { tier: holderTier, count: holderCount } = useHolderStatus(wallet, collection.contract);
  const [showOnboarding, setShowOnboarding] = useState(() => { try { return !localStorage.getItem(`${collectionSlug}_onboarded`); } catch { return true; } });

  // Re-entry point for the onboarding tour (F561): clearing the per-collection
  // "onboarded" flag lets the freshly-mounted Onboarding re-detect a first visit.
  // Onboarding keys off collection.slug, which equals collectionSlug here.
  const replayOnboarding = useCallback(() => {
    try { localStorage.removeItem(`${collectionSlug}_onboarded`); } catch { /* no-op */ }
    setShowOnboarding(false);
    // Remount on the next tick so the first-visit effect re-runs from scratch.
    setTimeout(() => setShowOnboarding(true), 0);
  }, [collectionSlug]);

  // Lite mode: redirect away from hidden tabs. Show a toast so a deep link to a
  // Pro-only tab doesn't silently dump the user on Floor with no explanation (F826).
  const liteRedirectNotedRef = useRef(null);
  useEffect(() => {
    if (isLite && LITE_HIDDEN_ALL.has(tab)) {
      if (liteRedirectNotedRef.current !== tab) {
        liteRedirectNotedRef.current = tab;
        const label = tab.charAt(0).toUpperCase() + tab.slice(1);
        addToast(`${label} is a Pro feature — switch to Pro in the header to view it`, "info");
      }
      navigate(`/nakamigos/${collectionSlug}`, { replace: true });
    } else if (!isLite || !LITE_HIDDEN_ALL.has(tab)) {
      liteRedirectNotedRef.current = null;
    }
  }, [isLite, tab, collectionSlug, navigate, addToast]);

  // On mount (and collection switch — key={collectionSlug} forces remount),
  // update the page title and scroll to top.
  // All React state resets are handled by the remount itself (useState initializers).
  useEffect(() => {
    document.title = `${collection.name} | Tradermigos`;
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [collectionSlug, collection.name]);

  // ═══ Deep link: /:collection/nft/:id — auto-open modal ═══
  const deepLinkFetchedRef = useRef(null);
  useEffect(() => {
    if (!deepLinkTokenId) return;
    const token = nfts.allTokens.find((t) => String(t.id) === deepLinkTokenId);
    if (token) {
      setSelected(token);
    } else if (nfts.allTokens.length > 0 && deepLinkFetchedRef.current !== deepLinkTokenId) {
      // Not in the loaded window — fetch it directly (same fetch-by-id fallback
      // the ?token= handler uses) so the modal gets real image + traits instead
      // of a bare "#id" placeholder (F583). Show a transient placeholder first.
      // The ref guards against re-fetching as more gallery pages stream in.
      deepLinkFetchedRef.current = deepLinkTokenId;
      setSelected({ id: deepLinkTokenId, name: `#${deepLinkTokenId}`, attributes: [], image: null });
      fetchTokensByIds([deepLinkTokenId], collection.contract, collection.metadataBase)
        .then((arr) => { if (arr?.[0]) setSelected(arr[0]); })
        .catch(() => { /* bad/burned id — deep link is best-effort */ });
    }
  }, [deepLinkTokenId, nfts.allTokens, collection.contract, collection.metadataBase]);

  // Update page title on tab change
  useEffect(() => {
    const tabLabel = tab === "gallery" ? "" : ` - ${tab.charAt(0).toUpperCase() + tab.slice(1)}`;
    document.title = `${collection.name}${tabLabel} | Tradermigos`;
  }, [tab, collection.name]);

  // Scroll listener
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 600);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleTabChange = useCallback((newTab) => {
    if (newTab === "landing") {
      navigate("/nakamigos");
    } else {
      if (!collectionSlug) { navigate("/nakamigos"); return; }
      // Emit the real /gallery segment (not an empty one) so the URL is
      // canonical and parseRoute doesn't fall through to another tab (F607).
      navigate(`/nakamigos/${collectionSlug}/${newTab}`);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    play("click");
    focusIndexRef.current = -1;
  }, [navigate, play, collectionSlug]);

  const toggleFavorite = useCallback((tokenId) => {
    const removing = favorites.includes(tokenId);
    ctxToggleFavorite(tokenId);
    if (wallet) {
      getUserdata().then(({ addFavoriteRemote, removeFavoriteRemote }) => {
        if (removing) removeFavoriteRemote(wallet, tokenId, collectionSlug);
        else addFavoriteRemote(wallet, tokenId, collectionSlug);
      });
    }
    play("favorite");
  }, [ctxToggleFavorite, favorites, play, wallet, collectionSlug]);

  const addToCart = useCallback((nft) => {
    if (cart.find(n => String(n.id) === String(nft.id))) return;
    const listing = listings.find(l => String(l.tokenId) === String(nft.id));
    const enriched = listing
      ? {
          ...nft,
          price: nft.price ?? listing.price,
          orderHash: nft.orderHash || listing.orderHash || null,
          orderData: nft.orderData || listing.orderData || null,
          protocolAddress: nft.protocolAddress || listing.protocolAddress || null,
          isNative: nft.isNative || listing.isNative || false,
          nativeOrder: nft.nativeOrder || listing.nativeOrder || null,
        }
      : nft;
    ctxAddToCart(enriched);
    addToast(`Added #${nft.id} to cart`, "success");
    play("cart");
  }, [ctxAddToCart, cart, addToast, listings, play]);

  // ═══ Keyboard shortcuts (power-user mode) ═══
  useEffect(() => {
    const getCards = () => Array.from(document.querySelectorAll(".nft-card"));
    const scrollToCard = (card) => {
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      card?.classList.add("keyboard-focus");
      getCards().forEach(c => { if (c !== card) c.classList.remove("keyboard-focus"); });
    };

    const handleKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

      // Ctrl+Shift+P — toggle Lite/Pro mode
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        toggleTradingMode();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (TAB_KEYS[e.key]) {
        e.preventDefault();
        handleTabChange(TAB_KEYS[e.key]);
        return;
      }

      const key = e.key.toLowerCase();

      if (key === "j" || key === "k") {
        e.preventDefault();
        const cards = getCards();
        if (!cards.length) return;
        if (key === "j") {
          focusIndexRef.current = Math.min(focusIndexRef.current + 1, cards.length - 1);
        } else {
          focusIndexRef.current = Math.max(focusIndexRef.current - 1, 0);
        }
        scrollToCard(cards[focusIndexRef.current]);
        play("click");
        return;
      }

      if (e.key === "Enter") {
        const cards = getCards();
        const card = cards[focusIndexRef.current];
        if (card) {
          e.preventDefault();
          // Try card-reveal wrapper first (Card.jsx), then click the card itself (VirtualCard)
          const clickTarget = card.closest(".card-reveal") || card;
          clickTarget.click();
          play("click");
        }
        return;
      }

      switch (key) {
        case "g": handleTabChange("gallery"); break;
        case "f": {
          // Toggle favorite on the currently focused card
          const cards = getCards();
          const card = cards[focusIndexRef.current];
          if (card) {
            const idAttr = card.getAttribute("data-token-id") || card.closest("[data-token-id]")?.getAttribute("data-token-id") || card.querySelector("[data-token-id]")?.getAttribute("data-token-id");
            if (idAttr) toggleFavorite(idAttr);
          }
          break;
        }
        case "c": {
          // Add focused card to cart
          const cards = getCards();
          const card = cards[focusIndexRef.current];
          if (card) {
            const idAttr = card.getAttribute("data-token-id") || card.closest("[data-token-id]")?.getAttribute("data-token-id") || card.querySelector("[data-token-id]")?.getAttribute("data-token-id");
            if (idAttr) {
              const token = nfts.allTokens.find(t => String(t.id) === String(idAttr));
              if (token) addToCart(token);
            }
          }
          break;
        }
        case "s":
        case "/":
          e.preventDefault();
          document.querySelector(".search-input")?.focus();
          break;
        case "m":
          toggleMute();
          break;
        case "?":
          e.preventDefault();
          setShowKeyboardHelp(prev => !prev);
          break;
        case "escape":
          if (showKeyboardHelp) {
            setShowKeyboardHelp(false);
          } else if (cartOpen) {
            setCartOpen(false);
          } else if (selected) {
            setSelected(null);
            // Return to the gallery tab explicitly — a bare /:collection close
            // path is ambiguous; the /gallery segment keeps the tab under the
            // modal on Gallery instead of bouncing to Floor (F538).
            if (location.pathname.includes("/nft/")) navigate(`/nakamigos/${collectionSlug}/gallery`, { replace: true });
          } else {
            getCards().forEach(c => c.classList.remove("keyboard-focus"));
            focusIndexRef.current = -1;
          }
          break;
        default: break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleTabChange, play, toggleMute, toggleFavorite, addToCart, nfts.allTokens, showKeyboardHelp, cartOpen, selected, location.pathname, navigate, collectionSlug, toggleTradingMode]);

  const handleConnect = useCallback(() => {
    setWalletModalOpen(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    disconnect();
    addToast("Wallet disconnected", "info");
  }, [disconnect, addToast]);

  // Sync favorites from Supabase on wallet connect or collection change
  useEffect(() => {
    if (!wallet) return;
    getUserdata().then(({ syncFavorites }) =>
      syncFavorites(wallet, favorites, collectionSlug).then((merged) => {
        setFavorites(merged);
        saveFavorites(merged);
      })
    ).catch((err) => {
      console.warn("Favorites sync failed:", err.message);
    });
  }, [wallet, collectionSlug, holderTier]); // eslint-disable-line react-hooks/exhaustive-deps

  // ═══ Cart functions ═══
  const removeFromCart = useCallback((id) => {
    const removed = cart.find((n) => String(n.id) === String(id));
    ctxRemoveFromCart(id);
    if (removed) {
      addToast(`Removed #${id} from cart`, "info", {
        undoAction: () => ctxAddToCart(removed),
      });
    }
  }, [ctxRemoveFromCart, ctxAddToCart, cart, addToast]);

  const clearCart = useCallback(() => {
    ctxClearCart();
  }, [ctxClearCart]);

  const refreshCart = useCallback(() => {
    setCart(prev => {
      const updated = prev.map(item => {
        const currentListing = listings.find(l => String(l.tokenId) === String(item.id));
        if (!currentListing) return item;
        return {
          ...item,
          price: currentListing.price,
          orderHash: currentListing.orderHash || item.orderHash,
          isNative: currentListing.isNative || false,
          nativeOrder: currentListing.nativeOrder || item.nativeOrder || null,
        };
      });
      saveCart(updated);
      return updated;
    });
    addToast("Cart prices refreshed", "success");
  }, [listings, addToast, setCart, saveCart]);

  // ═══ Price Alerts background monitoring ═══
  usePriceAlerts(nfts.allTokens, addToast);

  // ═══ Smart Alerts engine ═══
  const smartAlerts = useSmartAlerts(addToast);

  // ═══ Tab content renderer ═══
  const renderTab = () => {
    switch (tab) {
      case "gallery":
        return (
          <>
            <Hero stats={stats} tokens={nfts.allTokens} onPick={setSelected} />
            <NftMarquee tokens={nfts.allTokens} onPick={setSelected} />
            <Gallery
              tokens={nfts.tokens}
              allTokens={nfts.allTokens}
              loading={nfts.loading}
              error={nfts.error}
              hasMore={nfts.hasMore}
              onLoadMore={nfts.loadMore}
              onRetry={nfts.retry}
              onFilter={nfts.changeFilter}
              onPick={setSelected}
              traitFilters={nfts.traitFilters}
              activeFilters={nfts.activeFilters}
              sortBy={nfts.sortBy}
              onSort={nfts.setSortBy}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              cart={cart}
              onAddToCart={addToCart}
              listings={listings}
              totalSupply={stats?.supply ?? collection.supply}
            />
          </>
        );
      case "deals":
        return (
          <Deals
            tokens={nfts.allTokens}
            listings={listings}
            listingsLoading={listingsLoading}
            stats={stats}
            onPick={setSelected}
            wallet={wallet}
            onConnect={handleConnect}
            addToast={addToast}
            onAddToCart={addToCart}
            onRefresh={refreshListings}
            loadAll={nfts.loadAll}
            hasMore={nfts.hasMore}
          />
        );
      case "listings":
        return (
          <Listings
            tokens={nfts.allTokens} stats={stats} listings={listings}
            listingsLoading={listingsLoading} listingsError={listingsError}
            listingsSource={listingsSource} activities={activities} activitiesLoading={activitiesLoading} activitiesEmpty={activitiesEmpty}
            onPick={setSelected} wallet={wallet} onConnect={handleConnect} addToast={addToast}
            onAddToCart={addToCart} cart={cart}
          />
        );
      case "traits":
        return <TraitExplorer tokens={nfts.allTokens} listings={listings} stats={stats} onPick={setSelected} wallet={wallet} onConnect={handleConnect} addToast={addToast} loadAll={nfts.loadAll} hasMore={nfts.hasMore} onFilterGallery={(key, value) => { nfts.changeFilter({ [key]: [value] }); handleTabChange("gallery"); }} />;
      case "analytics":
        return <Analytics tokens={nfts.allTokens} stats={stats} activities={activities} listings={listings} onPick={setSelected} />;
      case "activity":
        return <ActivityFeed activities={activities} isLive={isLive} isWebSocketConnected={isWebSocketConnected} addToast={addToast} />;
      case "favorites":
        return <Favorites tokens={nfts.allTokens} favorites={favorites} onPick={setSelected} onToggleFavorite={toggleFavorite} />;
      case "trade":
        return <NftCompare tokens={nfts.allTokens} onPick={setSelected} wallet={wallet} onConnect={handleConnect} addToast={addToast} />;
      case "watchlist":
        return <Watchlist tokens={nfts.allTokens} onPick={setSelected} addToast={addToast} setTab={handleTabChange} wallet={wallet} />;
      case "collection":
        return <MyCollection wallet={wallet} onPick={setSelected} onConnect={handleConnect} addToast={addToast} stats={stats} />;
      case "trades":
        return <TradesPanel wallet={wallet} onConnect={handleConnect} addToast={addToast} onViewProfile={setProfileAddress} />;
      case "whales":
        return <WhaleIntelligence onViewProfile={setProfileAddress} stats={stats} />;
      case "about":
        return <About stats={stats} onNavigateGallery={(searchTerm) => { nfts.changeFilter({}); handleTabChange("gallery"); setTimeout(() => { const input = document.querySelector(".search-input"); if (input) { const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; nativeInputValueSetter.call(input, searchTerm); input.dispatchEvent(new Event("input", { bubbles: true })); } }, 150); }} onFilterGallery={(key, value) => { nfts.changeFilter({ [key]: [value] }); handleTabChange("gallery"); }} />;
      case "bids":
        return <BidManager wallet={wallet} onConnect={handleConnect} addToast={addToast} onPick={setSelected} tokens={nfts.allTokens} />;
      case "my-listings":
        return <MyListings wallet={wallet} onConnect={handleConnect} addToast={addToast} onPick={setSelected} tokens={nfts.allTokens} stats={stats} />;
      case "alerts":
        return <PriceAlertPanel tokens={nfts.allTokens} addToast={addToast} />;
      case "chat":
        return <CommunityChat wallet={wallet} onConnect={handleConnect} addToast={addToast} holderTier={holderTier} onOpenTrades={() => handleTabChange("trades")} openDmsSignal={dmSignal} />;
      case "history":
        return <TransactionHistory wallet={wallet} onConnect={handleConnect} />;
      case "sniper":
        return (
          <RaritySniper
            tokens={nfts.allTokens}
            listings={listings}
            supply={stats?.supply}
            onPick={setSelected}
            addToast={addToast}
            onAddToCart={addToCart}
            onRefresh={refreshListings}
            wallet={wallet}
            onConnect={handleConnect}
          />
        );
      case "portfolio":
        return <PortfolioTracker wallet={wallet} onConnect={handleConnect} onPick={setSelected} addToast={addToast} />;
      default:
        return <NotFound onGoHome={() => handleTabChange("gallery")} />;
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "transparent", color: "var(--text)", fontFamily: "var(--display)", position: "relative", paddingBottom: 60 }}>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <Background />

      <Header
        tab={tab}
        setTab={handleTabChange}
        onPrefetch={prefetchTab}
        wallet={wallet}
        setWallet={handleDisconnect}
        onConnect={handleConnect}
        activities={activities}
        isLive={isLive || nfts.isLive}
        cartCount={cart.length}
        onCartToggle={() => setCartOpen(!cartOpen)}
        themeName={themeName}
        onCycleTheme={cycleTheme}
        walletName={walletName}
        lastRefresh={lastRefresh}
        collectionName={collection.name}
        collectionImage={collection.image}
        collectionSlug={collectionSlug}
        collectionPixelated={collection.pixelated}
        dmUnread={dmUnread}
        onOpenDms={() => { handleTabChange("chat"); setDmSignal((s) => s + 1); }}
        notificationCenter={
          <Suspense fallback={null}>
          <NotificationCenter
            config={smartAlerts.config}
            updateConfig={smartAlerts.updateConfig}
            history={smartAlerts.history}
            unreadCount={smartAlerts.unreadCount}
            markRead={smartAlerts.markRead}
            markAllRead={smartAlerts.markAllRead}
            clearHistory={smartAlerts.clearHistory}
            removeNotification={smartAlerts.removeNotification}
          />
          </Suspense>
        }
      />

      <main id="main-content" role="main">
      {/* Global wrong-network banner */}
      {wallet && isWrongNetwork && (
        <div role="alert" style={{
          fontFamily: "var(--mono)", fontSize: 12, padding: "10px 20px",
          background: "rgba(248,113,113,0.1)", borderBottom: "1px solid rgba(248,113,113,0.25)",
          color: "var(--red, #f87171)", textAlign: "center", lineHeight: 1.5,
        }}>
          You are connected to the wrong network. Please switch to Ethereum Mainnet to use marketplace features.{" "}
          <button
            onClick={() => switchChain?.()}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--naka-blue)", textDecoration: "underline",
              fontFamily: "var(--mono)", fontSize: 12, padding: 0,
            }}
          >
            Switch Network
          </button>
        </div>
      )}
      {/* key={tab}: a crashed tab must not stay latched across navigation —
          without it one tab error bricks every subsequent tab (prod 2026-06-11) */}
      {/* No onReset navigation: Try Again should retry THIS tab (the boundary
          clears its own error state); the Go Home button is the escape hatch. */}
      <ErrorBoundary key={tab} title="Tab error">
      <Suspense fallback={<LazyFallback />}>
      <PageTransition tabKey={tab}>
        {renderTab()}
      </PageTransition>
      </Suspense>
      </ErrorBoundary>
      </main>

      {selected && (
      <ErrorBoundary title="Modal error" onReset={() => setSelected(null)}>
      <Suspense fallback={null}>
      <Modal
        nft={selected}
        onClose={() => {
          setSelected(null);
          // Clear deep link URL when closing modal — land back on the gallery
          // tab explicitly so closing a /nft/ deep link doesn't swap the
          // underlying tab from Gallery to Floor (F538).
          if (location.pathname.includes("/nft/")) navigate(`/nakamigos/${collectionSlug}/gallery`, { replace: true });
        }}
        isFavorite={selected ? isFavorite(selected.id) : false}
        onToggleFavorite={toggleFavorite}
        wallet={wallet}
        onConnect={handleConnect}
        addToast={addToast}
        onTheater={() => setTheaterNft(selected)}
        onShare={() => setShareNft(selected)}
        onViewProfile={setProfileAddress}
        floorPrice={stats?.floor}
        statsSupply={stats?.supply}
        allTokens={nfts.allTokens}
      />
      </Suspense>
      </ErrorBoundary>
      )}

      {cartOpen && (
      <ErrorBoundary title="Cart error" onReset={() => setCartOpen(false)}>
      <Suspense fallback={null}>
      <ShoppingCart
        cart={cart}
        onRemove={removeFromCart}
        onClear={clearCart}
        onClose={() => setCartOpen(false)}
        wallet={wallet}
        onConnect={handleConnect}
        addToast={addToast}
        isOpen={cartOpen}
        listings={listings}
        onRefreshCart={refreshCart}
      />
      </Suspense>
      </ErrorBoundary>
      )}

      <ErrorBoundary title="Overlay error" onReset={() => { setTheaterNft(null); setProfileAddress(null); setEditProfileOpen(false); setWalletModalOpen(false); setShareNft(null); }}>
      {theaterNft && (
        <Suspense fallback={null}>
          <TheaterMode
            nft={theaterNft}
            onClose={() => setTheaterNft(null)}
            isFavorite={isFavorite(theaterNft.id)}
            onToggleFavorite={toggleFavorite}
          />
        </Suspense>
      )}

      {profileAddress && (
        <Suspense fallback={null}>
          <OnChainProfile
            address={profileAddress}
            onClose={() => setProfileAddress(null)}
            onPick={setSelected}
            wallet={wallet}
            onEdit={() => { setProfileAddress(null); setEditProfileOpen(true); }}
          />
        </Suspense>
      )}

      {editProfileOpen && (
        <Suspense fallback={null}>
          <EditProfile
            wallet={wallet}
            onClose={() => setEditProfileOpen(false)}
            onConnect={handleConnect}
            addToast={addToast}
          />
        </Suspense>
      )}

      {walletModalOpen && (
        <Suspense fallback={null}>
          <WalletModal
            onClose={() => setWalletModalOpen(false)}
            addToast={addToast}
          />
        </Suspense>
      )}

      {shareNft && (
        <Suspense fallback={null}>
          <ShareCard nft={shareNft} onClose={() => setShareNft(null)} />
        </Suspense>
      )}

      {showKeyboardHelp && (
        <Suspense fallback={null}>
          <KeyboardHelp
            onClose={() => setShowKeyboardHelp(false)}
            onReplayTour={() => { setShowKeyboardHelp(false); replayOnboarding(); }}
          />
        </Suspense>
      )}

      {showOnboarding && (
        <Suspense fallback={null}>
          <Onboarding onComplete={() => setShowOnboarding(false)} />
        </Suspense>
      )}

      </ErrorBoundary>

      <Toast toasts={toasts} onRemove={removeToast} />

      {/* Mobile Bottom Navigation */}
      <MobileNav tab={tab} onTabChange={handleTabChange} />
      <InstallPrompt />

      {/* Sound toggle + keyboard help hint */}
      <div className="desktop-controls" style={{ position: "fixed", bottom: 16, left: 16, zIndex: 100, display: "flex", gap: 8 }}>
        <button
          onClick={toggleMute}
          style={{
            width: 32, height: 32, borderRadius: 8,
            background: "var(--surface-glass)", border: "1px solid var(--border)",
            backdropFilter: "var(--glass-blur)", color: "var(--text-muted)",
            cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
          }}
          title={muted ? "Unmute sounds" : "Mute sounds"}
          aria-label={muted ? "Unmute sounds" : "Mute sounds"}
        >
          {muted ? "\uD83D\uDD07" : "\uD83D\uDD0A"}
        </button>
        <button
          onClick={() => setShowKeyboardHelp(true)}
          data-tour="shortcuts"
          style={{
            height: 32, borderRadius: 8, padding: "0 10px",
            background: "var(--surface-glass)", border: "1px solid var(--border)",
            backdropFilter: "var(--glass-blur)", color: "var(--text-muted)",
            cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10,
            display: "flex", alignItems: "center", gap: 4,
          }}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          <span style={{ background: "rgba(255,255,255,0.08)", borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>?</span>
          <span>Keys</span>
        </button>
      </div>

      <button
        className={`back-to-top ${showTop ? "visible" : ""}`}
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        aria-label="Back to top"
      >
        {"\u2191"}
      </button>

      <footer className="footer-full pixel-border-top">
        <div className="footer-inner">
          <div className="footer-brand">
            <img src={collection.image} alt={collection.name} className="header-logo-icon" style={{ width: 30, height: 30, objectFit: "cover", imageRendering: collection.pixelated ? "pixelated" : "auto" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)", letterSpacing: "0.04em", lineHeight: 1 }}>{collection.name.toUpperCase()}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>Marketplace</div>
            </div>
          </div>
          <div className="footer-links">
            {[
              ["OpenSea", `https://opensea.io/collection/${collection.openseaSlug || collection.slug}`],
              ["Blur", `https://blur.io/eth/collection/${collection.slug}`],
              ["Etherscan", `https://etherscan.io/address/${collection.contract}`],
              collection.twitter ? ["X / Twitter", `https://x.com/${collection.twitter}`] : null,
              collection.discord ? ["Discord", collection.discord] : null,
            ].filter(Boolean).map(([label, url]) => (
              <a key={label} href={url} target="_blank" rel="noopener noreferrer">{label}</a>
            ))}
          </div>
          <div className="footer-meta">
            <div className="footer-tags">
              {collection.tags.map((tag) => (
                <span key={tag} className="footer-tag">{tag}</span>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

// Google Fonts URL is injected at runtime — see useEffect in App() below.
// Only "Press Start 2P" is actually referenced by the .nakamigos-app CSS.
const NAKAMIGOS_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap';

export default function App() {
  // Defer the Google Fonts <link> to the moment Nakamigos mounts. The CSS
  // file is bundled eagerly via main.tsx (so styles are available the
  // instant a /nakamigos route is hit), but the font fetch shouldn't fire
  // on every page of the main app — that produced a visible 503 in the
  // network panel on every navigation.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const existing = document.querySelector(`link[href="${NAKAMIGOS_FONTS_HREF}"]`);
    if (existing) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = NAKAMIGOS_FONTS_HREF;
    link.dataset.nakamigos = 'fonts';
    document.head.appendChild(link);
    // Intentional: do not remove on unmount. Keeps the font cached for
    // subsequent re-mounts (fast in-app navigation back to /nakamigos).
  }, []);

  return (
    <ErrorBoundary title="App initialization error" onReset={() => window.location.href = '/nakamigos'}>
      <WalletProvider>
        <ThemeProvider>
          <TradingModeProvider>
            <ToastProvider>
              <div className="nakamigos-app">
                <AppInner />
              </div>
            </ToastProvider>
          </TradingModeProvider>
        </ThemeProvider>
      </WalletProvider>
    </ErrorBoundary>
  );
}
