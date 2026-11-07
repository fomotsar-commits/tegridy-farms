import { useCallback, useEffect, useState } from "react";
import { createNativeListing, fetchNativeListings, fulfillNativeOrder, cancelNativeListing } from "../../lib/orderbook";
import { createItemOffer, fetchTokenOfferBook, acceptOffer } from "../../api-offers";
import { chainTxUrl, walletChainLabel } from "../../lib/venue";
import { getFriendlyError } from "../../lib/errorMessages";
import { isTxNotice } from "../../lib/txOutcome";
import { exactEth } from "../../hooks/useBuyHereListings";
import { askWalletToSwitch } from "../../lib/walletSwitch";

const PRICE_RE = /^\d{1,6}(\.\d{1,18})?$/;
const short = (a) => (typeof a === "string" && a.length > 10 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a || "");

/**
 * The venue's own trading of one Base buy collection item, on Base: its
 * listing on the venue's order book (buy it, or cancel your own), the best
 * offer on it (accept it), and two forms, to list it here and to make an offer.
 *
 * How money moves. A listing here: the buyer pays the price plus Base gas; the
 * seller gets the price minus the venue's 0.5%, which goes to the venue's Base
 * treasury Safe. An offer here: paid in WETH on Base; when the owner accepts,
 * the owner gets the offer minus OpenSea's 1% and the venue's 0.5%.
 */
export default function TradeHereBase({ collection, item, wallet, onConnect, addToast }) {
  const chainName = walletChainLabel(collection.chain);
  const tokenId = String(item.id);
  const [book, setBook] = useState({ status: "loading", order: null });
  const [offers, setOffers] = useState({ status: "loading", best: null });
  const [busy, setBusy] = useState(null); // list | offer | buy | cancel | accept
  const [notice, setNotice] = useState(null);
  const [listPrice, setListPrice] = useState("");
  const [offerPrice, setOfferPrice] = useState("");

  const [reads, setReads] = useState(0);
  const load = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetchNativeListings(collection.contract, { limit: 200 });
      if (!live) return;
      const order = (res.orders || []).find((o) => String(o.token_id) === tokenId && o.status === "active") || null;
      setBook({ status: res.error ? "unavailable" : "ready", order });
      const ob = await fetchTokenOfferBook(tokenId, { contract: collection.contract });
      if (!live) return;
      setOffers({ status: ob.unavailable ? "unavailable" : "ready", best: ob.bestOffer });
    })();
    return () => { live = false; };
  }, [collection.contract, tokenId, reads]);

  // One answer for every action: success, a chain switch, or what went wrong.
  const settle = (res, { done, verb }) => {
    setBusy(null);
    if (res?.success) {
      addToast?.(done, "success");
      setNotice(res.hash ? { text: done, href: chainTxUrl(collection.chain, res.hash) } : null);
      load();
      return;
    }
    if (res?.error === "wrong-chain" && res.chainId) {
      addToast?.(`Switch your wallet to ${chainName}, then press ${verb} again.`, "info");
      askWalletToSwitch(res.chainId);
      return;
    }
    if (res?.error === "rejected") return;
    if (isTxNotice(res)) {
      setNotice({ text: res.message, href: chainTxUrl(collection.chain, res.hash) });
      return;
    }
    setNotice({ text: getFriendlyError(res?.message || "That did not go through") });
  };

  const needWallet = () => {
    if (wallet) return false;
    onConnect?.();
    return true;
  };

  const order = book.order;
  const mine = order && wallet && String(order.maker).toLowerCase() === String(wallet).toLowerCase();
  const orderPrice = order ? exactEth(String(order.price_wei)) : null;
  const best = offers.best;

  const list = async () => {
    if (needWallet()) return;
    if (!PRICE_RE.test(listPrice) || Number(listPrice) <= 0) {
      setNotice({ text: "Enter a price in ETH, like 0.02." });
      return;
    }
    setNotice(null);
    setBusy("list");
    settle(await createNativeListing({ contract: collection.contract, tokenId, priceEth: listPrice }), { done: `Listed #${tokenId} for ${listPrice} ETH`, verb: "List" });
  };
  const offer = async () => {
    if (needWallet()) return;
    if (!PRICE_RE.test(offerPrice) || Number(offerPrice) <= 0) {
      setNotice({ text: "Enter an offer in WETH, like 0.01." });
      return;
    }
    setNotice(null);
    setBusy("offer");
    settle(await createItemOffer({ tokenId, priceEth: offerPrice, contract: collection.contract }), { done: `Offer of ${offerPrice} WETH made on #${tokenId}`, verb: "Make offer" });
  };
  const buy = async () => {
    if (needWallet()) return;
    setNotice(null);
    setBusy("buy");
    settle(await fulfillNativeOrder(order), { done: `Bought ${collection.name} #${tokenId}`, verb: "Buy" });
  };
  const cancel = async () => {
    if (needWallet()) return;
    setNotice(null);
    setBusy("cancel");
    settle(await cancelNativeListing(order), { done: `Listing of #${tokenId} cancelled`, verb: "Cancel" });
  };
  const accept = async () => {
    if (needWallet()) return;
    setNotice(null);
    setBusy("accept");
    settle(await acceptOffer(best), { done: `Offer accepted: #${tokenId} sold`, verb: "Accept" });
  };

  return (
    <div className="ext-trade" aria-label={`Trade ${collection.name} #${tokenId} here, on ${chainName}`}>
      <div className="ext-trade-row">
        <span className="ext-fact-label">Listed here</span>
        {book.status === "loading" && <span className="ext-panel-note" role="status">Reading the venue's book...</span>}
        {book.status === "unavailable" && <span className="ext-panel-note" role="status">The venue's book could not be read right now.</span>}
        {book.status === "ready" && !order && <span className="ext-panel-note">Not listed here.</span>}
        {order && (
          <>
            <strong className="ext-trade-price">{orderPrice} ETH</strong>
            {mine ? (
              <button type="button" className="btn-secondary ext-trade-btn" disabled={busy === "cancel"} onClick={cancel}>
                {busy === "cancel" ? "Confirming..." : "Cancel my listing"}
              </button>
            ) : (
              <button type="button" className="btn-primary ext-trade-btn" disabled={busy === "buy"} onClick={buy}>
                {busy === "buy" ? "Confirming..." : !wallet ? "Connect Wallet to Buy" : `Buy for ${orderPrice} ETH`}
              </button>
            )}
          </>
        )}
      </div>

      <div className="ext-trade-row">
        <span className="ext-fact-label">Best offer</span>
        {offers.status === "loading" && <span className="ext-panel-note" role="status">Reading offers...</span>}
        {offers.status === "unavailable" && <span className="ext-panel-note" role="status">Offers could not be read right now.</span>}
        {offers.status === "ready" && !best && <span className="ext-panel-note">No offers yet.</span>}
        {best && (
          <>
            <strong className="ext-trade-price">{best.price} {best.currency || "WETH"}</strong>
            <span className="ext-panel-note">from {short(best.maker)}</span>
            {wallet && (
              <button type="button" className="btn-secondary ext-trade-btn" disabled={busy === "accept"} onClick={accept}>
                {busy === "accept" ? "Confirming..." : "Accept (owner)"}
              </button>
            )}
          </>
        )}
      </div>

      <form className="ext-trade-form" onSubmit={(e) => { e.preventDefault(); list(); }}>
        <label className="ext-fact-label" htmlFor={`ext-list-${tokenId}`}>List it here (owner)</label>
        <div className="ext-trade-inputs">
          <input id={`ext-list-${tokenId}`} inputMode="decimal" placeholder="Price in ETH" value={listPrice} onChange={(e) => setListPrice(e.target.value.trim())} />
          <button type="submit" className="btn-primary ext-trade-btn" disabled={busy === "list"}>
            {busy === "list" ? "Confirming..." : !wallet ? "Connect Wallet" : "List"}
          </button>
        </div>
        <p className="ext-panel-note">{`You get the price minus the venue's 0.5%, which goes to the venue's ${chainName} treasury. Listed for 7 days, on Seaport on ${chainName}.`}</p>
      </form>

      <form className="ext-trade-form" onSubmit={(e) => { e.preventDefault(); offer(); }}>
        <label className="ext-fact-label" htmlFor={`ext-offer-${tokenId}`}>Make an offer</label>
        <div className="ext-trade-inputs">
          <input id={`ext-offer-${tokenId}`} inputMode="decimal" placeholder="Offer in WETH" value={offerPrice} onChange={(e) => setOfferPrice(e.target.value.trim())} />
          <button type="submit" className="btn-primary ext-trade-btn" disabled={busy === "offer"}>
            {busy === "offer" ? "Confirming..." : !wallet ? "Connect Wallet" : "Make offer"}
          </button>
        </div>
        <p className="ext-panel-note">{`Paid in WETH on ${chainName}: your ETH is wrapped first if needed. If the owner accepts, they get your offer minus OpenSea's 1% and the venue's 0.5%. Open for 7 days.`}</p>
      </form>

      {notice && (
        <p className="ext-panel-note ext-buy-notice" role="alert">
          {notice.text}
          {notice.href && (
            <>
              {" "}
              <a href={notice.href} target="_blank" rel="noopener noreferrer">Basescan {"↗"}</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
