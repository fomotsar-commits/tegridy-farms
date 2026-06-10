import { useState, useEffect, useRef, useCallback } from "react";
import { shortenAddress } from "../api";
import { useSiweAuth } from "../hooks/useSiweAuth";
import { fetchThread, fetchConversations, sendDm, markThreadRead } from "../lib/dm";

const POLL_MS = 15_000; // inside the proxy's 20/min wallet budget
const MAX_CHARS = 500;

const fmtTime = (ts) => {
  const d = new Date(ts);
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/**
 * Wallet-to-wallet DMs, server-mediated (SIWE cookie → RLS). Renders as an
 * embeddable panel; TradesPanel wraps it in a modal with an initial peer.
 * A message carrying trade_id renders as a trade card deep-linking to the
 * Trades inbox.
 */
export default function DirectMessages({ wallet, addToast, initialPeer = null, initialTradeId = null, onOpenTrades, embedded = false }) {
  const { isAuthenticated, isAuthenticating, signIn } = useSiweAuth();
  const [convos, setConvos] = useState([]);
  const [peer, setPeer] = useState(initialPeer ? initialPeer.toLowerCase() : null);
  const [peerInput, setPeerInput] = useState("");
  const [thread, setThread] = useState([]);
  const [text, setText] = useState("");
  const [state, setState] = useState("loading"); // loading | ready | needs-auth | not-enabled
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const pendingTradeRef = useRef(initialTradeId);

  const classify = (err) => {
    if (err?.needsAuth) return "needs-auth";
    return "not-enabled"; // pre-migration / proxy unconfigured → honest banner
  };

  const loadConvos = useCallback(async () => {
    if (!wallet) return;
    try {
      const list = await fetchConversations(wallet);
      setConvos(list);
      setState("ready");
    } catch (err) {
      setState(classify(err));
    }
  }, [wallet]);

  const loadThread = useCallback(async () => {
    if (!wallet || !peer) return;
    try {
      const msgs = await fetchThread(wallet, peer);
      setThread(msgs);
      setState("ready");
      markThreadRead(wallet, peer);
    } catch (err) {
      setState(classify(err));
    }
  }, [wallet, peer]);

  // Initial + polling loads
  useEffect(() => { loadConvos(); }, [loadConvos]);
  useEffect(() => {
    loadThread();
    if (!peer) return;
    const t = setInterval(() => { if (!document.hidden) loadThread(); }, POLL_MS);
    return () => clearInterval(t);
  }, [peer, loadThread]);

  // Auto-scroll on thread growth
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !wallet || !peer || sending) return;
    if (trimmed.length > MAX_CHARS) return;
    setSending(true);
    try {
      const tradeId = pendingTradeRef.current;
      pendingTradeRef.current = null;
      const msg = await sendDm({ me: wallet, other: peer, text: trimmed, tradeId });
      if (msg) {
        setThread((prev) => [...prev, msg]);
        setText("");
      }
    } catch (err) {
      if (err.needsAuth) setState("needs-auth");
      else addToast?.(err.message || "Send failed", "error");
    } finally {
      setSending(false);
    }
  }, [text, wallet, peer, sending, addToast]);

  if (!wallet) {
    return (
      <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
        <div className="empty-state-icon">{"✉"}</div>
        <div className="empty-state-title">Direct Messages</div>
        <div className="empty-state-text">Connect your wallet to message other traders.</div>
      </div>
    );
  }

  if (state === "needs-auth") {
    return (
      <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
        <div className="empty-state-icon">{"✉"}</div>
        <div className="empty-state-title">Sign in for DMs</div>
        <div className="empty-state-text">Direct messages are private — a one-time signature proves this wallet is yours.</div>
        <button
          className="btn-primary"
          style={{ marginTop: 14, padding: "10px 24px" }}
          disabled={isAuthenticating}
          onClick={async () => {
            const ok = await signIn();
            if (ok) { setState("loading"); loadConvos(); if (peer) loadThread(); }
          }}
        >
          {isAuthenticating ? "Check your wallet…" : "Sign in"}
        </button>
      </div>
    );
  }

  if (state === "not-enabled") {
    return (
      <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
        <div className="empty-state-icon">{"✉"}</div>
        <div className="empty-state-title">DMs aren't enabled yet</div>
        <div className="empty-state-text">The messaging backend (migration 007) hasn't been switched on. Check back soon.</div>
      </div>
    );
  }

  const isAuthGatePending = !isAuthenticated && state === "loading";

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", minHeight: embedded ? 360 : 420 }}>
      {/* Conversation list */}
      <div style={{ flex: "1 1 200px", maxWidth: 280 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            value={peerInput}
            onChange={(e) => setPeerInput(e.target.value.trim())}
            placeholder="New DM: 0x…"
            spellCheck={false}
            style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "rgba(0,0,0,0.25)", color: "var(--text)" }}
          />
          <button
            className="btn-secondary"
            style={{ fontSize: 10, padding: "6px 10px" }}
            disabled={!/^0x[a-fA-F0-9]{40}$/.test(peerInput) || peerInput.toLowerCase() === wallet.toLowerCase()}
            onClick={() => { setPeer(peerInput.toLowerCase()); setPeerInput(""); }}
          >
            Open
          </button>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {isAuthGatePending ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : convos.length === 0 ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", padding: 14, textAlign: "center" }}>
              No conversations yet
            </div>
          ) : (
            convos.map((c) => (
              <button
                key={c.channelKey}
                onClick={() => setPeer(c.peer)}
                style={{
                  display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                  padding: "10px 12px", background: peer === c.peer ? "rgba(111,168,220,0.08)" : "transparent",
                  border: "none", borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)" }}>{shortenAddress(c.peer)}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)" }}>{fmtTime(c.last.timestamp)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6, marginTop: 3 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
                    {c.last.tradeId ? "⇄ Trade offer" : c.last.text}
                  </span>
                  {c.unread > 0 && (
                    <span style={{ fontFamily: "var(--mono)", fontSize: 8, background: "var(--naka-blue)", color: "#000", borderRadius: 8, padding: "1px 6px", fontWeight: 700 }}>
                      {c.unread}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Thread */}
      <div style={{ flex: "2 1 320px", display: "flex", flexDirection: "column" }}>
        {!peer ? (
          <div className="empty-state" style={{ flex: 1, borderRadius: 10, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
            <div className="empty-state-icon">{"✉"}</div>
            <div className="empty-state-text">Pick a conversation or start a new one.</div>
          </div>
        ) : (
          <>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)", padding: "4px 2px 8px" }}>
              {shortenAddress(peer)}
            </div>
            <div ref={listRef} style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, padding: 12, minHeight: 240, maxHeight: 380 }}>
              {thread.length === 0 ? (
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", textAlign: "center", paddingTop: 40 }}>
                  No messages yet — say hi or send a trade offer.
                </div>
              ) : thread.map((m) => {
                const own = m.sender.toLowerCase() === wallet.toLowerCase();
                return (
                  <div key={m.id} style={{ display: "flex", justifyContent: own ? "flex-end" : "flex-start", marginBottom: 8 }}>
                    <div style={{
                      maxWidth: "78%", padding: "8px 12px", borderRadius: 10,
                      background: own ? "rgba(111,168,220,0.10)" : "rgba(255,255,255,0.04)",
                      border: "1px solid var(--border)",
                    }}>
                      {m.tradeId && (
                        <button
                          onClick={() => onOpenTrades?.()}
                          style={{
                            display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                            fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)",
                            background: "rgba(212,168,67,0.08)", border: "1px solid rgba(212,168,67,0.2)",
                            borderRadius: 6, padding: "6px 8px", marginBottom: 6,
                          }}
                        >
                          {"⇄"} Trade offer attached — view in Trades
                        </button>
                      )}
                      <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {m.text}
                      </div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: "var(--text-muted)", marginTop: 4, textAlign: own ? "right" : "left" }}>
                        {fmtTime(m.timestamp)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder={`Message ${shortenAddress(peer)}…`}
                rows={1}
                maxLength={MAX_CHARS}
                style={{ flex: 1, fontFamily: "var(--display)", fontSize: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "rgba(0,0,0,0.25)", color: "var(--text)", resize: "none" }}
              />
              <button className="btn-primary" style={{ fontSize: 11, padding: "0 18px" }} disabled={sending || !text.trim()} onClick={handleSend}>
                {sending ? "…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
