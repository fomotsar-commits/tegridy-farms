import { useState } from "react";
import { fulfillSeaportOrder } from "../../api";
import { chainTxUrl, walletChainLabel } from "../../lib/venue";
import { getFriendlyError } from "../../lib/errorMessages";
import { isTxNotice } from "../../lib/txOutcome";
import { exactEth } from "../../hooks/useBuyHereListings";
import { askWalletToSwitch } from "../../lib/walletSwitch";

/**
 * Buying one OpenSea listing of a Base buy collection here. The buy goes
 * through the venue's own fulfillSeaportOrder, which checks the wallet is on
 * the listing NFT's chain (Base) and that the call OpenSea built moves this
 * NFT and nothing else. A wallet on another chain is asked to switch; the
 * buyer then presses Buy again.
 *
 * How money moves: the buyer pays the seller's OpenSea price (OpenSea's fee and
 * any creator fee come out of it, as on OpenSea) plus Base gas. The venue
 * takes no fee on this purchase.
 */
export default function BuyHere({ collection, item, listing, listingsStatus, wallet, onConnect, addToast, onBought }) {
  const [phase, setPhase] = useState("idle"); // idle | buying | bought
  const [boughtHash, setBoughtHash] = useState(null);
  const [notice, setNotice] = useState(null);
  const chainName = walletChainLabel(collection.chain);

  if (phase === "bought") {
    const url = chainTxUrl(collection.chain, boughtHash);
    return (
      <div className="ext-buy">
        {url ? (
          <a className="btn-primary ext-buy-btn" href={url} target="_blank" rel="noopener noreferrer">
            {"Bought ✓ · View on Basescan ↗"}
          </a>
        ) : (
          <button type="button" className="btn-primary ext-buy-btn" disabled>{"Bought ✓"}</button>
        )}
      </div>
    );
  }

  if (!listing) {
    if (listingsStatus === "loading") return <p className="ext-panel-note" role="status">Reading OpenSea listings...</p>;
    if (listingsStatus === "unavailable") return <p className="ext-panel-note" role="status">Listings could not be read from OpenSea right now.</p>;
    return <p className="ext-panel-note">Not listed for sale right now.</p>;
  }

  // Exact, from wei: never a rounded figure below what the wallet will ask for.
  const price = exactEth(listing.priceWei);

  const buy = async () => {
    if (!wallet) {
      onConnect?.();
      return;
    }
    setNotice(null);
    setPhase("buying");
    const res = await fulfillSeaportOrder(listing, { buyerAddress: wallet });
    if (res?.success) {
      setBoughtHash(res.hash || null);
      setPhase("bought");
      addToast?.(`Bought ${collection.name} #${item.id}`, "success");
      onBought?.(String(item.id));
      return;
    }
    setPhase("idle");
    if (res?.error === "wrong-chain" && res.chainId) {
      addToast?.(`Switch your wallet to ${chainName}, then press Buy again.`, "info");
      askWalletToSwitch(res.chainId);
      return;
    }
    if (res?.error === "rejected") return;
    if (isTxNotice(res)) {
      setNotice({
        text: res.error === "unconfirmed"
          ? "We couldn't confirm this purchase. Check it on Basescan before you buy again: if it landed, the NFT is already yours."
          : res.message,
        href: chainTxUrl(collection.chain, res.hash),
      });
      return;
    }
    if (res?.error === "stale") {
      setNotice({ text: "This listing is no longer available. It was likely just sold or cancelled." });
      return;
    }
    setNotice({ text: getFriendlyError(res?.message || "Transaction failed") });
  };

  return (
    <div className="ext-buy">
      <div className="ext-buy-price">
        <span className="ext-fact-label">Price</span> <strong>{price} ETH</strong> <span>on {chainName}</span>
      </div>
      <button
        type="button"
        className="btn-primary ext-buy-btn"
        disabled={phase === "buying"}
        onClick={buy}
      >
        {phase === "buying" ? "Confirming..." : !wallet ? "Connect Wallet to Buy" : `Buy for ${price} ETH`}
      </button>
      <p className="ext-panel-note">
        {`No venue fee: you pay the seller's OpenSea price plus ${chainName} gas. It settles through Seaport, OpenSea's own contract, on ${chainName}.`}
      </p>
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
