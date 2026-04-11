import { useState, useEffect, useCallback, useMemo } from "react";
import NftImage from "./NftImage";
import { Eth } from "./Icons";
import { fetchWalletNfts, getProvider, shortenAddress } from "../api";
import { WETH, SEAPORT_ADDRESS, SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, CONDUIT_KEY, CONDUIT_ADDRESS } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useWalletState, useWalletActions } from "../contexts/WalletContext";
import { createTradeOffer, getIncomingTrades, updateTradeStatus } from "../lib/userdata";

const cardStyle = {
  background: "var(--surface-glass)",
  backdropFilter: "var(--glass-blur)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minHeight: 340,
};

const searchInputStyle = {
  width: "100%",
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const ethInputStyle = {
  width: "100%",
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const resultItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 8,
  cursor: "pointer",
  transition: "background 0.15s",
};

const tradeButtonStyle = {
  padding: "14px 32px",
  borderRadius: 12,
  border: "none",
  background: "var(--gold)",
  color: "var(--bg)",
  fontFamily: "var(--pixel)",
  fontSize: 10,
  letterSpacing: "0.06em",
  cursor: "pointer",
  fontWeight: 700,
  transition: "opacity 0.2s, transform 0.15s",
};

const incomingCardStyle = {
  background: "var(--surface-glass)",
  backdropFilter: "var(--glass-blur)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 16,
  display: "flex",
  alignItems: "center",
  gap: 16,
  flexWrap: "wrap",
};

function NftSlot({ nft, label, searchValue, onSearchChange, searchResults, onSelect, onClear, placeholder }) {
  if (nft) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
        <div style={{ position: "relative", width: "100%", maxWidth: 200, cursor: "pointer" }} onClick={onClear}>
          <NftImage
            nft={nft}
            large
            style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 12 }}
          />
          <div style={{
            position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: "50%",
            background: "rgba(0,0,0,0.6)", color: "#fff", display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 12, lineHeight: 1,
          }}>
            x
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--display)", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{nft.name}</div>
          {nft.rank && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--gold)", marginTop: 4 }}>Rank #{nft.rank}</div>
          )}
          {nft.owner && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
              Owner: {shortenAddress(nft.owner)}
            </div>
          )}
        </div>
        {nft.attributes && nft.attributes.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "center", maxWidth: 220 }}>
            {nft.attributes.slice(0, 6).map((a) => (
              <span key={a.key} style={{
                fontFamily: "var(--mono)", fontSize: 9, padding: "3px 7px", borderRadius: 6,
                background: "rgba(255,255,255,0.06)", color: "var(--text-dim)", border: "1px solid var(--border)",
              }}>
                {a.key}: {a.value}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        style={searchInputStyle}
        placeholder={placeholder || "Search by name or ID..."}
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        autoComplete="off"
      />
      {searchResults.length > 0 && (
        <div style={{
          maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2,
          background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: 6,
        }}>
          {searchResults.map((n) => (
            <div
              key={n.id}
              style={resultItemStyle}
              onClick={() => onSelect(n)}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <NftImage nft={n} style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }} />
              <span style={{ fontFamily: "var(--display)", fontSize: 13, color: "var(--text)" }}>{n.name}</span>
              {n.rank && <span style={{ marginLeft: "auto", color: "var(--gold)", fontFamily: "var(--mono)", fontSize: 10 }}>#{n.rank}</span>}
            </div>
          ))}
        </div>
      )}
      {!searchValue && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: 120, opacity: 0.15, fontSize: 40,
        }}>
          +
        </div>
      )}
    </div>
  );
}

export default function NftCompare({ tokens, onPick, wallet, onConnect, addToast }) {
  const collection = useActiveCollection();
  const { isWrongNetwork } = useWalletState();
  const { switchChain } = useWalletActions();
  // Left panel (your NFT)
  const [yourNft, setYourNft] = useState(null);
  const [yourSearch, setYourSearch] = useState("");
  const [yourEth, setYourEth] = useState("");
  const [ownedNfts, setOwnedNfts] = useState([]);
  const [loadingOwned, setLoadingOwned] = useState(false);

  // Right panel (their NFT)
  const [theirNft, setTheirNft] = useState(null);
  const [theirSearch, setTheirSearch] = useState("");
  const [theirEth, setTheirEth] = useState("");

  // Trade state
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState("");

  // Incoming trades
  const [incomingTrades, setIncomingTrades] = useState([]);
  const [loadingTrades, setLoadingTrades] = useState(false);

  // Reset selections when collection changes
  useEffect(() => {
    setYourNft(null);
    setTheirNft(null);
    setYourSearch("");
    setTheirSearch("");
    setYourEth("");
    setTheirEth("");
  }, [collection.slug]);

  // Fetch owned NFTs when wallet changes
  useEffect(() => {
    if (!wallet) {
      setOwnedNfts([]);
      return;
    }
    let cancelled = false;
    setLoadingOwned(true);
    fetchWalletNfts(wallet, collection.contract, collection.metadataBase).then(({ tokens: owned }) => {
      if (!cancelled) {
        // Enrich with rarity data from full collection
        const enriched = owned.map((o) => {
          const full = tokens.find((t) => String(t.id) === String(o.id));
          return full ? { ...o, rank: full.rank, rarityScore: full.rarityScore, attributes: full.attributes || o.attributes } : o;
        });
        setOwnedNfts(enriched);
        setLoadingOwned(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setOwnedNfts([]);
        setLoadingOwned(false);
      }
    });
    return () => { cancelled = true; };
  }, [wallet, tokens, collection.contract]);

  // Fetch incoming trades
  const refreshTrades = useCallback(async () => {
    if (!wallet) { setIncomingTrades([]); return; }
    setLoadingTrades(true);
    try {
      const trades = await getIncomingTrades(wallet, collection.slug);
      setIncomingTrades(trades);
    } catch { /* silent */ }
    setLoadingTrades(false);
  }, [wallet, collection.slug]);

  useEffect(() => { refreshTrades(); }, [refreshTrades]);

  // Search: your NFTs (owned only)
  const yourResults = useMemo(() => {
    if (!yourSearch || yourSearch.length < 1) return [];
    const lower = yourSearch.toLowerCase();
    return ownedNfts
      .filter((t) => t.name.toLowerCase().includes(lower) || String(t.id).includes(yourSearch))
      .slice(0, 8);
  }, [ownedNfts, yourSearch]);

  // Search: their NFTs (any token in collection)
  const theirResults = useMemo(() => {
    if (!theirSearch || theirSearch.length < 1) return [];
    const lower = theirSearch.toLowerCase();
    return tokens
      .filter((t) => t.name.toLowerCase().includes(lower) || String(t.id).includes(theirSearch))
      .slice(0, 8);
  }, [tokens, theirSearch]);

  const canSubmit = wallet && yourNft && theirNft && !submitting;

  // Send trade offer via Seaport
  const handleSendTrade = useCallback(async () => {
    if (!wallet) { onConnect?.(); return; }
    if (isWrongNetwork) { addToast?.("Wrong network — please switch to Ethereum Mainnet", "error"); switchChain?.(); return; }
    if (!yourNft || !theirNft) { addToast?.("Select both NFTs", "error"); return; }
    if (!theirNft.owner) { addToast?.("Target NFT owner unknown", "error"); return; }

    const toWallet = theirNft.owner;
    if (toWallet.toLowerCase() === wallet.toLowerCase()) {
      addToast?.("You already own this NFT", "error");
      return;
    }

    setSubmitting(true);

    try {
      const { ethers } = await import("ethers");
      const provider = getProvider();
      if (!provider) { addToast?.("MetaMask not found", "error"); setSubmitting(false); return; }

      const browserProvider = new ethers.BrowserProvider(provider);
      const signer = await browserProvider.getSigner();
      const offererAddress = await signer.getAddress();

      // Step 1: Approve NFT for Seaport conduit
      setStep("Approving NFT...");
      const erc721ABI = [
        "function isApprovedForAll(address owner, address operator) view returns (bool)",
        "function setApprovalForAll(address operator, bool approved)",
      ];
      const nftContract = new ethers.Contract(collection.contract, erc721ABI, signer);
      const isApproved = await nftContract.isApprovedForAll(offererAddress, CONDUIT_ADDRESS);
      if (!isApproved) {
        const approveTx = await nftContract.setApprovalForAll(CONDUIT_ADDRESS, true);
        await approveTx.wait();
      }

      // Handle WETH wrapping/approval if ETH sweetener is offered
      const ethOfferedNum = parseFloat(yourEth) || 0;
      const ethRequestedNum = parseFloat(theirEth) || 0;
      let offerEthWei = 0n;
      let requestEthWei = 0n;

      if (ethOfferedNum > 0) {
        offerEthWei = ethers.parseEther(String(ethOfferedNum));

        // Import WETH helpers
        const { getWethBalance, getWethAllowance, wrapEth, approveWeth } = await import("../lib/weth");

        setStep("Wrapping ETH...");
        const wethBal = await getWethBalance(offererAddress);
        if (wethBal < offerEthWei) {
          const ethBal = await browserProvider.getBalance(offererAddress);
          const needed = offerEthWei - wethBal;
          if (ethBal < needed) {
            addToast?.("Insufficient ETH to wrap", "error");
            setSubmitting(false);
            setStep("");
            return;
          }
          await wrapEth(needed);
        }

        setStep("Approving WETH...");
        const allowance = await getWethAllowance(offererAddress);
        if (allowance < offerEthWei) {
          await approveWeth(offerEthWei);
        }
      }

      if (ethRequestedNum > 0) {
        requestEthWei = ethers.parseEther(String(ethRequestedNum));
      }

      // Step 2: Build Seaport order
      setStep("Signing order...");
      const now = Math.floor(Date.now() / 1000);
      const endTime = now + 7 * 24 * 3600; // 7 days

      // Offer: user's NFT + optional WETH
      const offer = [
        {
          itemType: 2, // ERC721
          token: collection.contract,
          identifierOrCriteria: String(yourNft.id),
          startAmount: "1",
          endAmount: "1",
        },
      ];

      if (offerEthWei > 0n) {
        offer.push({
          itemType: 1, // ERC20 (WETH)
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: offerEthWei.toString(),
          endAmount: offerEthWei.toString(),
        });
      }

      // Consideration: their NFT (to offerer) + optional WETH (to offerer)
      const consideration = [
        {
          itemType: 2, // ERC721
          token: collection.contract,
          identifierOrCriteria: String(theirNft.id),
          startAmount: "1",
          endAmount: "1",
          recipient: offererAddress,
        },
      ];

      if (requestEthWei > 0n) {
        consideration.push({
          itemType: 1, // ERC20 (WETH)
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: requestEthWei.toString(),
          endAmount: requestEthWei.toString(),
          recipient: offererAddress,
        });
      }

      // Add zone restriction consideration for the target wallet (private sale pattern)
      consideration.push({
        itemType: 0,
        token: "0x0000000000000000000000000000000000000000",
        identifierOrCriteria: "0",
        startAmount: "0",
        endAmount: "0",
        recipient: toWallet,
      });

      const OPENSEA_SIGNED_ZONE = "0x000056f7000000ece9003ca63978907a00ffd100";

      const orderParameters = {
        offerer: offererAddress,
        zone: OPENSEA_SIGNED_ZONE,
        offer,
        consideration,
        orderType: 2, // FULL_RESTRICTED (private)
        startTime: String(now),
        endTime: String(endTime),
        zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        salt: ethers.hexlify(ethers.randomBytes(32)),
        conduitKey: CONDUIT_KEY,
        totalOriginalConsiderationItems: consideration.length,
      };

      // Step 3: Get counter
      const seaportABI = ["function getCounter(address) view returns (uint256)"];
      const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, browserProvider);
      const counter = await seaport.getCounter(offererAddress);

      // Step 4: Sign EIP-712
      const signData = { ...orderParameters, counter: counter.toString() };
      const signature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);

      // Step 5: Store in Supabase for discovery
      setStep("Storing trade...");
      await createTradeOffer(wallet, {
        fromTokenId: String(yourNft.id),
        toTokenId: String(theirNft.id),
        toWallet,
        ethOffered: ethOfferedNum,
        ethRequested: ethRequestedNum,
        orderData: orderParameters,
        signature,
      }, collection.slug);

      addToast?.(`Trade offer sent: #${yourNft.id} for #${theirNft.id}`, "success");
      setYourNft(null);
      setTheirNft(null);
      setYourEth("");
      setTheirEth("");
      setYourSearch("");
      setTheirSearch("");
      refreshTrades();
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        addToast?.("Trade cancelled", "info");
      } else {
        console.error("Trade error:", err);
        addToast?.("Trade failed. Please try again or check your wallet connection.", "error");
      }
    }
    setSubmitting(false);
    setStep("");
  }, [wallet, onConnect, yourNft, theirNft, yourEth, theirEth, addToast, refreshTrades, collection.contract, collection.slug]);

  // Handle accept/decline on incoming trades
  const handleTradeAction = useCallback(async (tradeId, action) => {
    try {
      await updateTradeStatus(tradeId, action, collection.slug);
      addToast?.(`Trade ${action}`, action === "accepted" ? "success" : "info");
      refreshTrades();
    } catch (err) {
      addToast?.("Failed to update trade. Please try again.", "error");
    }
  }, [addToast, refreshTrades, collection.slug]);

  // Find token data from tokens array
  const findToken = useCallback((tokenId) => {
    return tokens.find((t) => String(t.id) === String(tokenId)) || null;
  }, [tokens]);

  if (!wallet) {
    return (
      <section style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
        <div className="wallet-connect-prompt">
          <div className="wallet-connect-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
            </svg>
          </div>
          <h3 className="wallet-connect-title">Connect Your Wallet</h3>
          <p className="wallet-connect-desc">
            Connect your wallet to swap {collection.name} directly with other holders through peer-to-peer trades.
          </p>
          <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
            Connect Wallet
          </button>
        </div>
      </section>
    );
  }

  return (
    <section style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontFamily: "var(--pixel)", fontSize: 12, color: "var(--gold)", letterSpacing: "0.08em", marginBottom: 8 }}>
          P2P TRADE
        </div>
        <div style={{ fontFamily: "var(--display)", fontSize: 14, color: "var(--text-dim)", maxWidth: 500, margin: "0 auto" }}>
          Swap {collection.name} directly with other holders. Select your NFT, pick the one you want, and send a trade offer.
        </div>
      </div>

      {/* Two-panel layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 16, alignItems: "start", marginBottom: 32 }}>
        {/* Left: YOUR NFT */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 9, color: "var(--naka-blue)", letterSpacing: "0.06em", textAlign: "center" }}>
            YOUR NFT
          </div>
          {loadingOwned ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="skeleton" style={{ height: 40, borderRadius: 8, animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          ) : ownedNfts.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDDBC"}</div>
              <div className="empty-state-title" style={{ fontSize: 13 }}>No {collection.name} Found</div>
              <div className="empty-state-text" style={{ fontSize: 10 }}>Your wallet does not hold any {collection.name} NFTs to trade.</div>
            </div>
          ) : (
            <NftSlot
              nft={yourNft}
              searchValue={yourSearch}
              onSearchChange={setYourSearch}
              searchResults={yourResults}
              onSelect={(n) => { setYourNft(n); setYourSearch(""); }}
              onClear={() => setYourNft(null)}
              placeholder="Search your NFTs..."
            />
          )}

          {/* ETH sweetener */}
          <div style={{ marginTop: "auto" }}>
            <div style={{ fontFamily: "var(--pixel)", fontSize: 8, color: "var(--text-dim)", marginBottom: 6, letterSpacing: "0.04em" }}>
              ADD ETH (OPTIONAL)
            </div>
            <div style={{ position: "relative" }}>
              <input
                style={ethInputStyle}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={yourEth}
                onChange={(e) => setYourEth(e.target.value)}
              />
              <span style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", pointerEvents: "none",
              }}>
                <Eth size={10} /> ETH
              </span>
            </div>
          </div>
        </div>

        {/* Center: Arrow + Button */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 16, paddingTop: 60, minWidth: 60,
        }}>
          <div style={{ fontSize: 28, color: "var(--gold)", opacity: 0.6 }}>
            &#8596;
          </div>
          <button
            disabled={!canSubmit}
            onClick={handleSendTrade}
            style={{
              ...tradeButtonStyle,
              opacity: canSubmit ? 1 : 0.35,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {submitting ? step || "SENDING..." : "SEND TRADE"}
          </button>
        </div>

        {/* Right: THEIR NFT */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 9, color: "var(--gold)", letterSpacing: "0.06em", textAlign: "center" }}>
            THEIR NFT
          </div>
          <NftSlot
            nft={theirNft}
            searchValue={theirSearch}
            onSearchChange={setTheirSearch}
            searchResults={theirResults}
            onSelect={(n) => { setTheirNft(n); setTheirSearch(""); }}
            onClear={() => setTheirNft(null)}
            placeholder={`Search any ${collection.name}...`}
          />

          {/* ETH request */}
          <div style={{ marginTop: "auto" }}>
            <div style={{ fontFamily: "var(--pixel)", fontSize: 8, color: "var(--text-dim)", marginBottom: 6, letterSpacing: "0.04em" }}>
              REQUEST ETH (OPTIONAL)
            </div>
            <div style={{ position: "relative" }}>
              <input
                style={ethInputStyle}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={theirEth}
                onChange={(e) => setTheirEth(e.target.value)}
              />
              <span style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", pointerEvents: "none",
              }}>
                <Eth size={10} /> ETH
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Incoming Trades */}
      <div style={{
        background: "var(--surface-glass)", backdropFilter: "var(--glass-blur)",
        border: "1px solid var(--border)", borderRadius: 16, padding: 24,
      }}>
        <div style={{
          fontFamily: "var(--pixel)", fontSize: 10, color: "var(--gold)", letterSpacing: "0.06em", marginBottom: 16,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span>INCOMING TRADES</span>
          <button
            onClick={refreshTrades}
            style={{
              padding: "4px 12px", borderRadius: 8, border: "1px solid var(--border)",
              background: "transparent", color: "var(--text-dim)", fontFamily: "var(--mono)",
              fontSize: 10, cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>

        {!wallet ? (
          <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
            <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDD12"}</div>
            <div className="empty-state-title" style={{ fontSize: 13 }}>Wallet Not Connected</div>
            <div className="empty-state-text" style={{ fontSize: 10 }}>Connect your wallet to see incoming trade offers.</div>
          </div>
        ) : loadingTrades ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 44, borderRadius: 8, animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : incomingTrades.length === 0 ? (
          <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
            <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83E\uDD1D"}</div>
            <div className="empty-state-title" style={{ fontSize: 13 }}>No Pending Trades</div>
            <div className="empty-state-text" style={{ fontSize: 10 }}>Incoming trade offers will appear here.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {incomingTrades.map((trade) => {
              const fromToken = findToken(trade.fromTokenId || trade.from_token_id);
              const toToken = findToken(trade.toTokenId || trade.to_token_id);
              const fromW = trade.fromWallet || trade.from_wallet;
              const ethOff = trade.ethOffered ?? trade.eth_offered ?? 0;
              const ethReq = trade.ethRequested ?? trade.eth_requested ?? 0;
              const tradeId = trade.id;

              return (
                <div key={tradeId} style={incomingCardStyle}>
                  {/* Their offered NFT */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 0" }}>
                    {fromToken ? (
                      <NftImage nft={fromToken} style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} />
                    ) : (
                      <div style={{ width: 48, height: 48, borderRadius: 8, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
                        #{trade.fromTokenId || trade.from_token_id}
                      </div>
                    )}
                    <div>
                      <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)" }}>
                        {fromToken?.name || `#${trade.fromTokenId || trade.from_token_id}`}
                      </div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>
                        from {shortenAddress(fromW)}
                      </div>
                      {ethOff > 0 && (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)", marginTop: 2 }}>
                          +<Eth size={9} /> {ethOff} ETH
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Arrow */}
                  <div style={{ fontFamily: "var(--pixel)", fontSize: 14, color: "var(--gold)", padding: "0 8px" }}>
                    &#8594;
                  </div>

                  {/* Your NFT they want */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 0" }}>
                    {toToken ? (
                      <NftImage nft={toToken} style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} />
                    ) : (
                      <div style={{ width: 48, height: 48, borderRadius: 8, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
                        #{trade.toTokenId || trade.to_token_id}
                      </div>
                    )}
                    <div>
                      <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)" }}>
                        {toToken?.name || `#${trade.toTokenId || trade.to_token_id}`}
                      </div>
                      {ethReq > 0 && (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--gold)", marginTop: 2 }}>
                          +<Eth size={9} /> {ethReq} ETH requested
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => handleTradeAction(tradeId, "accepted")}
                      style={{
                        padding: "8px 16px", borderRadius: 8, border: "none",
                        background: "var(--gold)", color: "var(--bg)", fontFamily: "var(--pixel)",
                        fontSize: 8, cursor: "pointer", letterSpacing: "0.04em", fontWeight: 700,
                      }}
                    >
                      ACCEPT
                    </button>
                    <button
                      onClick={() => handleTradeAction(tradeId, "declined")}
                      style={{
                        padding: "8px 16px", borderRadius: 8, border: "1px solid var(--border)",
                        background: "transparent", color: "var(--text-dim)", fontFamily: "var(--pixel)",
                        fontSize: 8, cursor: "pointer", letterSpacing: "0.04em",
                      }}
                    >
                      DECLINE
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
