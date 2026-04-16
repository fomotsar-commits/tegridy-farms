/**
 * Portfolio P&L tracking library.
 *
 * Uses Alchemy getNFTSales to find acquisition costs, computes realized
 * and unrealized P&L, and caches results in localStorage with a 5-minute TTL.
 */
import { alchemyGet } from "./proxy";

// ── Cache helpers ──────────────────────────────────────────────
const CACHE_PREFIX = "portfolio_cache_";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheKey(parts) {
  return CACHE_PREFIX + parts.map(p => String(p).toLowerCase()).join("_");
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.data;
  } catch { return null; }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* quota exceeded — ignore */ }
}

// ── Block-to-timestamp estimation (post-merge: 12s slots) ─────
const MERGE_BLOCK = 15537393;
const MERGE_TIME = 1663224162000;
const MS_PER_BLOCK = 12000;

function blockToTimestamp(blockNumber) {
  if (!blockNumber) return Date.now();
  return MERGE_TIME + (blockNumber - MERGE_BLOCK) * MS_PER_BLOCK;
}

// ── Wei parsing helper ─────────────────────────────────────────
function saleToEth(sale) {
  const seller = BigInt(sale.sellerFee?.amount || "0");
  const protocol = BigInt(sale.protocolFee?.amount || "0");
  const royalty = BigInt(sale.royaltyFee?.amount || "0");
  const totalWei = seller + protocol + royalty;
  return totalWei > 0n ? Number(totalWei * 10000n / BigInt(1e18)) / 10000 : 0;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Get acquisition cost for a specific token.
 * Finds the most recent purchase by `wallet` from getNFTSales.
 * Returns { costBasis, gasEstimate, timestamp, hash } or null.
 */
export async function getAcquisitionCost(wallet, tokenId, contract) {
  const key = cacheKey(["acq", wallet, contract, tokenId]);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const data = await alchemyGet("getNFTSales", {
      contractAddress: contract,
      tokenId: String(tokenId),
      order: "desc",
      limit: "50",
    });

    const sales = data.nftSales || [];
    const walletLower = wallet.toLowerCase();

    // Find the most recent sale where the wallet was the buyer
    const purchase = sales.find(
      s => s.buyerAddress?.toLowerCase() === walletLower
    );

    if (!purchase) {
      // Could be a mint or airdrop — no sale record
      const result = { costBasis: 0, gasEstimate: 0, timestamp: null, hash: null, isMint: true };
      writeCache(key, result);
      return result;
    }

    const costBasis = saleToEth(purchase);
    // Estimate gas at ~0.003 ETH (typical NFT purchase gas cost)
    const gasEstimate = 0.003;
    const timestamp = blockToTimestamp(purchase.blockNumber);

    const result = { costBasis, gasEstimate, timestamp, hash: purchase.transactionHash, isMint: false };
    writeCache(key, result);
    return result;
  } catch (err) {
    if (import.meta.env.DEV) console.warn("getAcquisitionCost failed:", err.message);
    return null;
  }
}

/**
 * Get the current estimated value for a token.
 * Uses the collection floor price as the baseline value.
 */
export function getCurrentValue(tokenId, contract, floorPrice) {
  // For a more granular valuation we could use rarity-adjusted pricing,
  // but floor price is the standard P&L benchmark.
  return floorPrice != null && isFinite(floorPrice) ? floorPrice : 0;
}

/**
 * Calculate full P&L for a wallet's holdings in a given collection.
 *
 * @param {string} wallet - Wallet address
 * @param {{ contract: string, name: string, floorPrice: number|null }} collection
 * @param {Array} heldTokens - Array of token objects currently held
 * @returns {Promise<Object>} P&L summary
 */
export async function calculatePnL(wallet, collection, heldTokens) {
  const key = cacheKey(["pnl", wallet, collection.contract]);
  const cached = readCache(key);
  if (cached) return cached;

  const { contract, floorPrice } = collection;

  // Fetch all sales for this wallet + contract to find realized sales
  let allSales = [];
  try {
    const data = await alchemyGet("getNFTSales", {
      contractAddress: contract,
      buyerAddress: wallet,
      order: "desc",
      limit: "100",
    });
    allSales = data.nftSales || [];
  } catch (err) {
    if (import.meta.env.DEV) console.warn("calculatePnL: could not fetch buy sales:", err.message);
  }

  let sellSales = [];
  try {
    const data = await alchemyGet("getNFTSales", {
      contractAddress: contract,
      sellerAddress: wallet,
      order: "desc",
      limit: "100",
    });
    sellSales = data.nftSales || [];
  } catch (err) {
    if (import.meta.env.DEV) console.warn("calculatePnL: could not fetch sell sales:", err.message);
  }

  // Build a map of token purchases (latest buy per token)
  const purchaseMap = new Map();
  for (const sale of allSales) {
    if (sale.buyerAddress?.toLowerCase() === wallet.toLowerCase()) {
      const tid = String(sale.tokenId);
      if (!purchaseMap.has(tid)) {
        purchaseMap.set(tid, {
          costBasis: saleToEth(sale),
          timestamp: blockToTimestamp(sale.blockNumber),
          hash: sale.transactionHash,
        });
      }
    }
  }

  // Calculate unrealized P&L for held tokens
  let totalCostBasis = 0;
  let totalCurrentValue = 0;
  let totalGasSpent = 0;
  const GAS_ESTIMATE = 0.003;

  const tokenDetails = [];
  for (const token of heldTokens) {
    const purchase = purchaseMap.get(String(token.id));
    const costBasis = purchase?.costBasis ?? 0;
    const currentValue = getCurrentValue(token.id, contract, floorPrice);
    const holdTime = purchase?.timestamp
      ? Math.floor((Date.now() - purchase.timestamp) / 86400000)
      : null;

    totalCostBasis += costBasis;
    totalCurrentValue += currentValue;
    totalGasSpent += GAS_ESTIMATE;

    tokenDetails.push({
      tokenId: token.id,
      name: token.name,
      image: token.image,
      costBasis,
      currentValue,
      pnl: currentValue - costBasis,
      pnlPercent: costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0,
      holdDays: holdTime,
      purchaseHash: purchase?.hash || null,
      isMint: !purchase,
    });
  }

  // Calculate realized P&L from past sales.
  // Use a Map to track which buy transactions have already been matched,
  // so each buy is only used once. Process buys chronologically (ascending
  // block number) so the earliest buy is matched first.
  let realizedPnL = 0;
  const matchedBuyHashes = new Set();

  // Sort buys by block number ascending (oldest first) for FIFO matching
  const sortedBuys = [...allSales]
    .filter(s => s.buyerAddress?.toLowerCase() === wallet.toLowerCase())
    .sort((a, b) => (a.blockNumber || 0) - (b.blockNumber || 0));

  for (const sale of sellSales) {
    if (sale.sellerAddress?.toLowerCase() === wallet.toLowerCase()) {
      const sellPrice = saleToEth(sale);
      const tid = String(sale.tokenId);
      // Find the earliest unmatched purchase for this token
      const matchingBuy = sortedBuys.find(
        s => String(s.tokenId) === tid && !matchedBuyHashes.has(s.transactionHash)
      );
      if (matchingBuy) {
        matchedBuyHashes.add(matchingBuy.transactionHash);
      }
      const buyPrice = matchingBuy ? saleToEth(matchingBuy) : 0;
      realizedPnL += sellPrice - buyPrice;
    }
  }

  const unrealizedPnL = totalCurrentValue - totalCostBasis;

  const result = {
    realizedPnL,
    unrealizedPnL,
    totalGasSpent,
    costBasis: totalCostBasis,
    currentValue: totalCurrentValue,
    tokenDetails,
    nftCount: heldTokens.length,
    floorPrice: floorPrice || 0,
  };

  writeCache(key, result);
  return result;
}

// ── Portfolio value snapshots (for the value-over-time chart) ──

const SNAPSHOT_BASE_KEY = "portfolio_snapshots";
const MAX_SNAPSHOTS = 90; // 90 days of daily snapshots

function snapshotKey(wallet, collection) {
  const w = (wallet || "unknown").toLowerCase();
  const c = (collection || "unknown").toLowerCase();
  return `${SNAPSHOT_BASE_KEY}_${w}_${c}`;
}

export function loadSnapshots(wallet, collection) {
  try {
    return JSON.parse(localStorage.getItem(snapshotKey(wallet, collection)) || "[]");
  } catch { return []; }
}

export function saveSnapshot(totalValue, wallet, collection) {
  if (totalValue == null || !isFinite(totalValue) || !wallet) return;

  const snapshots = loadSnapshots(wallet, collection);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Only one snapshot per day
  const existing = snapshots.findIndex(s => s.date === today);
  if (existing >= 0) {
    snapshots[existing].value = totalValue;
  } else {
    snapshots.push({ date: today, value: totalValue });
  }

  // Keep only last MAX_SNAPSHOTS days
  while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();

  try {
    localStorage.setItem(snapshotKey(wallet, collection), JSON.stringify(snapshots));
  } catch { /* quota */ }
}
