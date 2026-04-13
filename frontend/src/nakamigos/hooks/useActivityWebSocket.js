import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { tagAlchemyEvent, mergeEventStreams } from "../lib/eventFeed";

// ERC-721 Transfer event topic: Transfer(address,address,uint256)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Polling interval — roughly one Ethereum block time
const POLL_INTERVAL_MS = 12_000;

// Post-merge block timestamp estimation
const MERGE_BLOCK = 15537393;
const MERGE_TIME = 1663224162000;
function blockToTimestamp(blockHex) {
  if (!blockHex) return Date.now();
  const blockNumber = parseInt(blockHex, 16);
  return MERGE_TIME + (blockNumber - MERGE_BLOCK) * 12000;
}

function cleanAddr(addr) {
  if (!addr) return null;
  // Remove zero-padding from 32-byte log topic to get 20-byte address
  return "0x" + addr.slice(-40);
}

function shortenAddr(addr) {
  const clean = cleanAddr(addr);
  if (!clean) return null;
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

function parseTransferLog(log) {
  const from = log.topics?.[1];
  const to = log.topics?.[2];
  const tokenIdHex = log.topics?.[3];

  if (!tokenIdHex) return null;

  const tokenId = String(parseInt(tokenIdHex, 16));

  return {
    type: "transfer",
    token: {
      id: tokenId,
      name: `#${tokenId}`,
    },
    price: null,
    from: shortenAddr(from),
    to: shortenAddr(to),
    fromFull: cleanAddr(from),
    toFull: cleanAddr(to),
    time: blockToTimestamp(log.blockNumber),
    marketplace: null,
    hash: log.transactionHash,
    _live: true,
  };
}

/**
 * Fetch the latest block number via the server-side Alchemy proxy.
 */
async function fetchBlockNumber(signal) {
  const res = await fetch("/api/alchemy?endpoint=rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "eth_blockNumber", params: [] }),
    signal,
  });
  if (!res.ok) throw new Error(`eth_blockNumber failed: ${res.status}`);
  const data = await res.json();
  return data.result; // hex string
}

/**
 * Fetch Transfer logs via the server-side Alchemy proxy (eth_getLogs).
 * API key stays server-side — never exposed to the browser.
 */
async function fetchTransferLogs(contractAddress, fromBlock, toBlock, signal) {
  const res = await fetch("/api/alchemy?endpoint=rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "eth_getLogs",
      params: [
        {
          address: contractAddress,
          topics: [TRANSFER_TOPIC],
          fromBlock,
          toBlock,
        },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`eth_getLogs failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "eth_getLogs RPC error");
  return data.result || [];
}

export default function useActivityWebSocket(contractAddress, openSeaEvents = []) {
  const [liveActivities, setLiveActivities] = useState([]);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  const mountedRef = useRef(true);
  const lastBlockRef = useRef(null);
  const seenKeysRef = useRef(new Set());
  const intervalRef = useRef(null);

  const poll = useCallback(async (signal) => {
    if (!contractAddress) return;

    try {
      // Get current block number
      const currentBlock = await fetchBlockNumber(signal);

      // On first poll, only look back ~5 blocks to avoid a huge initial fetch
      let fromBlock;
      if (lastBlockRef.current) {
        // Fetch from the block after the last one we processed
        const next = parseInt(lastBlockRef.current, 16) + 1;
        fromBlock = "0x" + next.toString(16);
      } else {
        const recent = parseInt(currentBlock, 16) - 5;
        fromBlock = "0x" + Math.max(0, recent).toString(16);
      }

      lastBlockRef.current = currentBlock;

      const logs = await fetchTransferLogs(contractAddress, fromBlock, currentBlock, signal);

      if (!mountedRef.current) return;

      if (logs.length > 0) {
        const newActivities = [];
        for (const log of logs) {
          const activity = parseTransferLog(log);
          if (!activity) continue;
          const key = `${activity.hash}-${activity.token.id}`;
          if (seenKeysRef.current.has(key)) continue;
          seenKeysRef.current.add(key);
          newActivities.push(activity);
        }

        if (newActivities.length > 0) {
          setLiveActivities((prev) => {
            const combined = [...newActivities.reverse(), ...prev];
            return combined.slice(0, 100);
          });
        }
      }

      // Mark as connected after a successful poll
      if (mountedRef.current) setIsWebSocketConnected(true);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.warn("useActivityWebSocket: poll error:", err);
      if (mountedRef.current) setIsWebSocketConnected(false);
    }
  }, [contractAddress]);

  useEffect(() => {
    mountedRef.current = true;
    setLiveActivities([]);
    setIsWebSocketConnected(false);
    lastBlockRef.current = null;
    seenKeysRef.current.clear();

    if (!contractAddress) return;

    const controller = new AbortController();

    // Initial poll
    poll(controller.signal);

    // Set up recurring poll
    intervalRef.current = setInterval(() => {
      if (mountedRef.current && !document.hidden) {
        poll(controller.signal);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      controller.abort();
      clearInterval(intervalRef.current);
    };
  }, [contractAddress, poll]);

  // Pause polling when tab is hidden, resume + immediate poll when visible
  useEffect(() => {
    function handleVisibility() {
      if (!document.hidden && mountedRef.current && contractAddress) {
        // Immediate poll on tab focus
        poll(new AbortController().signal);
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [contractAddress, poll]);

  // Merge Alchemy transfer events with any OpenSea stream events passed in
  const mergedLiveActivities = useMemo(() => {
    if (openSeaEvents.length === 0) {
      return liveActivities.map(tagAlchemyEvent);
    }
    return mergeEventStreams(
      openSeaEvents,
      liveActivities.map(tagAlchemyEvent),
      200
    );
  }, [liveActivities, openSeaEvents]);

  return { liveActivities: mergedLiveActivities, isWebSocketConnected };
}
