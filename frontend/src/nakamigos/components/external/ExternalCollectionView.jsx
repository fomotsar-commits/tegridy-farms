import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useActiveCollection } from "../../contexts/CollectionContext";
import { useToast } from "../../contexts/ToastContext";
import { explorerAddressUrl, marketCollectionUrl } from "../../lib/venue";
import useExternalCollection from "../../hooks/useExternalCollection";
import Background from "../Background";
import Header from "../Header";
import MobileNav from "../MobileNav";
import Toast from "../Toast";
import NotFound from "../NotFound";
import ExternalHero from "./ExternalHero";
import ExternalGallery from "./ExternalGallery";
import ExternalItemPanel from "./ExternalItemPanel";
import ExternalAbout from "./ExternalAbout";
import ExternalTabUnavailable from "./ExternalTabUnavailable";
import { EXTERNAL_TABS, TAB_LABELS } from "./externalCopy";

const WalletModal = lazy(() => import("../WalletModal"));

// A collection that is browsed here and trades on its own market (OpenSea or
// Magic Eden). It has a gallery and an About page, both read from that market,
// and a button to it. None of the Ethereum trading app mounts here: no cart,
// no order book, no Alchemy reads, no wallet-gated tabs. Any other tab renders
// an explicit unavailable state.
export default function ExternalCollectionView({ tab, deepLinkTokenId, collectionSlug, themeName, cycleTheme, wallet, walletName, disconnect }) {
  const collection = useActiveCollection();
  const location = useLocation();
  const navigate = useNavigate();
  const { toasts, addToast, removeToast } = useToast();
  const { stats, items, retry } = useExternalCollection(collection);
  const [selected, setSelected] = useState(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  // Junglets are addressed by mint, not by number, so a numeric deep link
  // opens nothing there.
  const deepLinkId = collection.chain === "solana" ? null : deepLinkTokenId;
  const burnedDeepLink = deepLinkId != null && (collection.burnedIds || []).some((b) => String(b) === deepLinkId);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [collectionSlug]);

  useEffect(() => {
    const label = tab === "gallery" ? "" : ` - ${TAB_LABELS[tab] || "Not Found"}`;
    document.title = `${collection.name}${label} | Tradermigos`;
  }, [tab, collection.name]);

  // Deep link /:collection/nft/:id. A burned token opens at once (the market
  // does not list it); any other id opens once the items read has found it.
  const deepLinkItem = useMemo(() => {
    if (deepLinkId == null) return null;
    if (burnedDeepLink) return { id: deepLinkId, name: null, image: null };
    return items.list.find((i) => i.id === deepLinkId) || null;
  }, [deepLinkId, burnedDeepLink, items.list]);
  const panelItem = selected || deepLinkItem;

  // "Not found" only after every page was read and every row could be read.
  // Otherwise the gallery's own "could not be read" line speaks instead.
  const deepLinkNotFound = deepLinkId != null && !burnedDeepLink
    && (items.status === "ready" || items.status === "empty")
    && !(items.dropped > 0)
    && !items.list.some((i) => i.id === deepLinkId);

  const handleTabChange = useCallback((next) => {
    if (next === "landing") navigate("/nakamigos");
    else navigate(`/nakamigos/${collectionSlug}/${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [navigate, collectionSlug]);

  const closePanel = useCallback(() => {
    setSelected(null);
    if (location.pathname.includes("/nft/")) navigate(`/nakamigos/${collectionSlug}/gallery`, { replace: true });
  }, [location.pathname, navigate, collectionSlug]);

  const handleDisconnect = useCallback(() => {
    disconnect?.();
    addToast("Wallet disconnected", "info");
  }, [disconnect, addToast]);

  const notFoundNotice = useMemo(() => (deepLinkNotFound ? (
    <div className="ext-notice" role="status">
      {`${collection.name} #${deepLinkId} was not found in this collection's ${collection.market.name} items.`}
    </div>
  ) : null), [deepLinkNotFound, deepLinkId, collection]);

  const renderTab = () => {
    if (tab === "gallery") {
      return (
        <>
          <ExternalHero collection={collection} stats={stats} />
          <ExternalGallery
            collection={collection}
            items={items}
            listedCount={stats.status === "ready" ? stats.data.listedCount : null}
            onRetry={retry}
            onPick={setSelected}
            notice={notFoundNotice}
          />
        </>
      );
    }
    if (tab === "about") return <ExternalAbout collection={collection} />;
    if (TAB_LABELS[tab]) return <ExternalTabUnavailable collection={collection} tab={tab} onGoTo={handleTabChange} />;
    return <NotFound onGoHome={() => handleTabChange("gallery")} />;
  };

  const marketUrl = marketCollectionUrl(collection);
  const explorerUrl = explorerAddressUrl(collection);

  return (
    <div className="ext-view" style={{ minHeight: "100vh", background: "transparent", color: "var(--text)", fontFamily: "var(--display)", position: "relative", paddingBottom: 60 }}>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <Background />
      <Header
        tab={tab}
        setTab={handleTabChange}
        wallet={wallet}
        setWallet={handleDisconnect}
        onConnect={() => setWalletModalOpen(true)}
        activities={[]}
        isLive={false}
        cartCount={0}
        themeName={themeName}
        onCycleTheme={cycleTheme}
        walletName={walletName}
        lastRefresh={null}
        collectionName={collection.name}
        collectionImage={collection.image}
        collectionPixelated={collection.pixelated}
        allowedTabs={EXTERNAL_TABS}
        showStatus={false}
      />

      <main id="main-content" role="main">
        {renderTab()}
      </main>

      {panelItem && <ExternalItemPanel collection={collection} item={panelItem} onClose={closePanel} />}

      {walletModalOpen && (
        <Suspense fallback={null}>
          <WalletModal onClose={() => setWalletModalOpen(false)} addToast={addToast} />
        </Suspense>
      )}

      <Toast toasts={toasts} onRemove={removeToast} />
      <MobileNav tab={tab} onTabChange={handleTabChange} allowedTabs={EXTERNAL_TABS} />

      <footer className="footer-full pixel-border-top">
        <div className="footer-inner">
          <div className="footer-brand">
            {collection.image && (
              <img src={collection.image} alt="" className="header-logo-icon" style={{ width: 30, height: 30, objectFit: "cover" }} />
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <div className="ext-footer-name">{collection.name.toUpperCase()}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>Browsed here, traded on {collection.market.name}</div>
            </div>
          </div>
          <div className="footer-links">
            {marketUrl && <a href={marketUrl} target="_blank" rel="noopener noreferrer">{collection.market.name}</a>}
            {explorerUrl && <a href={explorerUrl} target="_blank" rel="noopener noreferrer">{collection.explorer.name}</a>}
          </div>
          <div className="footer-meta">
            <div className="footer-tags">
              {(collection.tags || []).map((t) => <span key={t} className="footer-tag">{t}</span>)}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
