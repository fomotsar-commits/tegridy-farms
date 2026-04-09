import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { CONTRACT } from "../constants";
import { tagAlchemyEvent, mergeEventStreams } from "../lib/eventFeed";

const ALCHEMY_KEY = import.meta.env.VITE_ALCHEMY_API_KEY || "demo";
const WS_URL = ALCHEMY_KEY === "demo" ? null : `wss://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

function getWsUrl() {
  return WS_URL;
}

// ERC-721 Transfer event topic: Transfer(address,address,uint256)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

export default function useActivityWebSocket(contractAddress = CONTRACT, openSeaEvents = []) {
  const [liveActivities, setLiveActivities] = useState([]);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const subIdRef = useRef(null);
  const manualCloseRef = useRef(false);

  // Use a ref so scheduleReconnect always calls the latest connect
  // without creating a circular useCallback dependency.
  const connectRef = useRef(null);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    const attempt = reconnectAttemptRef.current;
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttemptRef.current = attempt + 1;

    console.info(`useActivityWebSocket: Reconnecting in ${delay}ms (attempt ${attempt + 1})`);

    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        connectRef.current();
      }
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    if (!mountedRef.current) return;

    const wsUrl = getWsUrl();
    if (!wsUrl) {
      console.info("useActivityWebSocket: Skipping WebSocket (no WS URL available)");
      return;
    }
    if (!mountedRef.current) return;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close();
          return;
        }

        reconnectAttemptRef.current = 0;

        // Subscribe to Transfer events on the collection contract
        const subscribeMsg = {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_subscribe",
          params: [
            "logs",
            {
              address: contractAddress,
              topics: [TRANSFER_TOPIC],
            },
          ],
        };

        ws.send(JSON.stringify(subscribeMsg));
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;

        try {
          const data = JSON.parse(event.data);

          // Handle subscription confirmation
          if (data.id === 1 && data.result) {
            subIdRef.current = data.result;
            setIsWebSocketConnected(true);
            console.info("useActivityWebSocket: Subscribed, id:", data.result);
            return;
          }

          // Handle subscription error
          if (data.id === 1 && data.error) {
            console.warn("useActivityWebSocket: Subscription failed:", data.error.message);
            setIsWebSocketConnected(false);
            ws.close();
            return;
          }

          // Handle incoming log events
          if (data.method === "eth_subscription" && data.params?.result) {
            const log = data.params.result;
            const activity = parseTransferLog(log);
            if (activity) {
              setLiveActivities((prev) => {
                // Deduplicate by tx hash + token id
                const key = `${activity.hash}-${activity.token.id}`;
                if (prev.some((a) => `${a.hash}-${a.token.id}` === key)) {
                  return prev;
                }
                // Prepend new activity, cap at 100 items
                return [activity, ...prev].slice(0, 100);
              });
            }
          }
        } catch (err) {
          console.warn("useActivityWebSocket: Failed to parse message:", err);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        subIdRef.current = null;
        if (mountedRef.current) {
          setIsWebSocketConnected(false);
          // Skip reconnect if close was intentional (e.g. tab hidden, cleanup)
          if (!manualCloseRef.current) {
            scheduleReconnect();
          }
          manualCloseRef.current = false;
        }
      };

      ws.onerror = (err) => {
        console.warn("useActivityWebSocket: Connection error:", err);
        // onclose will fire after this, triggering reconnect
      };
    } catch (err) {
      console.warn("useActivityWebSocket: Failed to create WebSocket:", err);
      scheduleReconnect();
    }
  }, [contractAddress, scheduleReconnect]);

  // Keep ref in sync so reconnect always uses the latest connect
  connectRef.current = connect;

  useEffect(() => {
    mountedRef.current = true;
    // Clear stale activities from previous collection before reconnecting
    setLiveActivities([]);
    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        manualCloseRef.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // Pause WebSocket when tab is hidden to save resources / API quota;
  // reconnect when tab becomes visible again.
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden) {
        // Tab hidden — close connection and stop reconnect attempts
        clearTimeout(reconnectTimerRef.current);
        if (wsRef.current) {
          manualCloseRef.current = true;
          wsRef.current.close();
          wsRef.current = null;
        }
        setIsWebSocketConnected(false);
      } else if (mountedRef.current) {
        // Tab visible again — reconnect immediately
        reconnectAttemptRef.current = 0;
        connectRef.current();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

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
