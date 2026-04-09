import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { shortenAddress } from "../api";
import {
  CHAT_ENABLED,
  fetchMessages,
  sendMessage,
  toggleLike,
  subscribeToMessages,
} from "../lib/supabase";

import { useActiveCollection } from "../contexts/CollectionContext";

const MAX_CHARS = 280;
const FEED_TABS = ["All", "Alpha", "Discussion"];

/* ── localStorage helpers (fallback when Supabase is off) ────────── */

function loadMessages(slug = "nakamigos") {
  try {
    const raw = localStorage.getItem(`${slug}_chat`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveMessages(msgs, slug = "nakamigos") {
  try {
    localStorage.setItem(`${slug}_chat`, JSON.stringify(msgs));
  } catch {
    /* quota exceeded - silently fail */
  }
}

/* ── helpers ──────────────────────────────────────────────────────── */

function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function detectTag(text) {
  if (/#alpha/i.test(text)) return "Alpha";
  if (/#discussion/i.test(text)) return "Discussion";
  return null;
}

/** Strip HTML tags and dangerous characters from user input. */
function sanitize(str) {
  // Use the browser's HTML parser to reliably strip all tags and decode entities.
  // DOMParser is safer than regex which can miss encoded/malformed tags.
  try {
    const doc = new DOMParser().parseFromString(str, "text/html");
    str = doc.body.textContent || "";
  } catch {
    // Fallback: strip tags via regex if DOMParser unavailable (e.g. SSR)
    str = str.replace(/<[^>]*>?/g, "");
  }
  // Collapse control chars
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

// ═══ Chat Moderation ═══
const SPAM_COOLDOWN_MS = 5000; // 5s between messages
const BLOCKED_PATTERNS = [
  /\b(?:free\s*mint|airdrop\s*claim|connect\s*wallet\s*at)\b/i,
  /https?:\/\/[^\s]*(?:mint|claim|airdrop|metamask)[^\s]*/i,
];
const lastMessageTime = {};

function isSpam(text, author) {
  const now = Date.now();
  if (lastMessageTime[author] && (now - lastMessageTime[author]) < SPAM_COOLDOWN_MS) {
    return "slow-down";
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) return "blocked-content";
  }
  return false;
}

/* ── styles ─────────────────────────────────────────────────────── */

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "var(--bg-card, rgba(20,20,30,0.85))",
    borderRadius: 16,
    border: "1px solid rgba(200,168,80,0.15)",
    overflow: "hidden",
  },
  header: {
    padding: "16px 20px 12px",
    borderBottom: "1px solid rgba(200,168,80,0.12)",
    fontFamily: "'Press Start 2P', monospace",
    fontSize: 13,
    color: "var(--gold)",
    letterSpacing: 1,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modeIndicator: (live) => ({
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.5,
    padding: "3px 8px",
    borderRadius: 8,
    background: live ? "rgba(74,222,128,0.12)" : "var(--border)",
    color: live ? "var(--green)" : "var(--text-faint)",
    border: live
      ? "1px solid rgba(74,222,128,0.25)"
      : "1px solid rgba(255,255,255,0.08)",
    fontFamily: "inherit",
  }),
  filterRow: {
    display: "flex",
    gap: 6,
    padding: "10px 20px 6px",
    flexShrink: 0,
  },
  filterTab: (active) => ({
    padding: "5px 14px",
    borderRadius: 20,
    border: "1px solid " + (active ? "var(--gold)" : "rgba(200,168,80,0.2)"),
    background: active
      ? "linear-gradient(135deg, rgba(200,168,80,0.25), rgba(200,168,80,0.10))"
      : "transparent",
    color: active ? "var(--gold)" : "var(--text-faint)",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.2s",
    letterSpacing: 0.5,
  }),
  messageList: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    /* scrollBehavior omitted — smooth scroll causes jank with rapid message arrival */
  },
  bubble: (isOwn) => ({
    maxWidth: "85%",
    alignSelf: isOwn ? "flex-end" : "flex-start",
    background: isOwn
      ? "linear-gradient(135deg, rgba(200,168,80,0.18), rgba(200,168,80,0.06))"
      : "var(--border)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: isOwn
      ? "1px solid rgba(200,168,80,0.25)"
      : "1px solid var(--border)",
    borderRadius: isOwn ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
    padding: "10px 14px",
    transition: "transform 0.15s, box-shadow 0.15s",
  }),
  authorRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  authorName: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--gold)",
    letterSpacing: 0.3,
  },
  timestamp: {
    fontSize: 10,
    color: "var(--text-faint)",
  },
  tag: {
    fontSize: 9,
    fontWeight: 700,
    padding: "2px 7px",
    borderRadius: 8,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  messageText: {
    fontSize: 13,
    color: "var(--text)",
    lineHeight: 1.5,
    wordBreak: "break-word",
  },
  likeRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
  },
  likeBtn: (liked) => ({
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    color: liked ? "var(--red)" : "var(--text-faint)",
    transition: "color 0.2s, transform 0.15s",
    padding: "2px 4px",
    lineHeight: 1,
  }),
  likeCount: {
    fontSize: 11,
    color: "var(--text-faint)",
  },
  inputArea: {
    padding: "12px 16px 16px",
    borderTop: "1px solid rgba(200,168,80,0.12)",
    flexShrink: 0,
  },
  textarea: {
    width: "100%",
    minHeight: 56,
    maxHeight: 120,
    resize: "vertical",
    background: "var(--border)",
    border: "1px solid rgba(200,168,80,0.15)",
    borderRadius: 12,
    padding: "10px 14px",
    color: "var(--text)",
    fontSize: 13,
    lineHeight: 1.5,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
    transition: "border-color 0.2s",
  },
  inputFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  charCount: (over) => ({
    fontSize: 11,
    color: over ? "var(--red)" : "var(--text-faint)",
    transition: "color 0.2s",
  }),
  sendBtn: (disabled) => ({
    padding: "8px 20px",
    borderRadius: 10,
    border: "none",
    background: disabled
      ? "rgba(200,168,80,0.12)"
      : "linear-gradient(135deg, #c8a850, #a08030)",
    color: disabled ? "var(--text-faint)" : "var(--bg)",
    fontWeight: 700,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "all 0.2s",
    letterSpacing: 0.5,
  }),
  connectPrompt: {
    textAlign: "center",
    padding: "16px 12px",
    color: "var(--text-muted)",
    fontSize: 13,
  },
  connectLink: {
    color: "var(--gold)",
    cursor: "pointer",
    textDecoration: "underline",
    background: "none",
    border: "none",
    fontSize: 13,
    fontWeight: 600,
  },
  empty: {
    textAlign: "center",
    padding: "40px 20px",
    color: "var(--text-faint)",
    fontSize: 13,
  },
  tokenBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: "rgba(200,168,80,0.7)",
    background: "rgba(200,168,80,0.08)",
    padding: "2px 7px",
    borderRadius: 6,
    marginLeft: "auto",
  },
};

const tagColors = {
  Alpha: { bg: "rgba(74,222,128,0.12)", color: "var(--green)", border: "rgba(74,222,128,0.25)" },
  Discussion: { bg: "rgba(129,140,248,0.12)", color: "var(--purple)", border: "rgba(129,140,248,0.25)" },
};

/* ── component ──────────────────────────────────────────────────── */

/** Detect NFT references like #1234 and render as inline previews */
function renderMessageText(text, metadataBase, pixelated) {
  const parts = text.split(/(#\d{1,5})/g);
  return parts.map((part, i) => {
    const match = part.match(/^#(\d{1,5})$/);
    if (match) {
      const tokenId = match[1];
      return (
        <span key={i} style={{
          display: "inline-flex", alignItems: "center", gap: 3,
          background: "rgba(200,168,80,0.1)", borderRadius: 4,
          padding: "1px 6px", fontSize: 12, color: "var(--gold)",
          verticalAlign: "middle",
        }}>
          {metadataBase && <img
            src={`${metadataBase}/${tokenId}.png`}
            alt={`#${tokenId}`}
            style={{ width: 16, height: 16, borderRadius: 2, imageRendering: pixelated ? "pixelated" : "auto" }}
            onError={(e) => { e.target.style.display = "none"; }}
          />}
          #{tokenId}
        </span>
      );
    }
    // Highlight @mentions
    const mentionParts = part.split(/(@0x[a-fA-F0-9]{4,}|@\w+)/g);
    return mentionParts.map((mp, j) => {
      if (mp.startsWith("@")) {
        return <span key={`${i}-${j}`} style={{ color: "var(--naka-blue)", fontWeight: 600 }}>{mp}</span>;
      }
      return mp;
    });
  });
}

export default function CommunityChat({ tokenId, wallet, onConnect, addToast, holderTier }) {
  const collection = useActiveCollection();
  const [messages, setMessages] = useState(() =>
    CHAT_ENABLED ? [] : loadMessages(collection.slug)
  );
  const [text, setText] = useState("");
  const [feedFilter, setFeedFilter] = useState("All");
  const listRef = useRef(null);
  const isTokenMode = tokenId != null;

  /* ── Load initial messages (Supabase mode) ─────────────────────── */
  useEffect(() => {
    if (!CHAT_ENABLED) return;
    let cancelled = false;
    fetchMessages({ tokenId: isTokenMode ? tokenId : null, slug: collection.slug }).then((msgs) => {
      if (!cancelled) setMessages(msgs);
    });
    return () => {
      cancelled = true;
    };
  }, [tokenId, isTokenMode, collection.slug]);

  /* ── Real-time subscription (Supabase mode) ────────────────────── */
  useEffect(() => {
    if (!CHAT_ENABLED) return;

    const sub = subscribeToMessages((payload) => {
      if (payload.eventType === "INSERT" && payload.new) {
        setMessages((prev) => {
          // Avoid duplicates (e.g. we already added it optimistically)
          if (prev.some((m) => m.id === payload.new.id)) return prev;
          return [...prev, payload.new];
        });
      } else if (payload.eventType === "UPDATE" && payload.new) {
        setMessages((prev) =>
          prev.map((m) => (m.id === payload.new.id ? payload.new : m))
        );
      } else if (payload.eventType === "DELETE" && payload.old) {
        setMessages((prev) => prev.filter((m) => m.id !== payload.old.id));
      }
    }, { slug: collection.slug });

    return () => sub.unsubscribe();
  }, [collection.slug]);

  /* ── Sync from localStorage on focus (local mode, other tabs) ─── */
  useEffect(() => {
    if (CHAT_ENABLED) return;
    setMessages(loadMessages(collection.slug));
    const onFocus = () => setMessages(loadMessages(collection.slug));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [collection.slug]);

  /* ── Scroll to bottom when messages change (only if already near bottom) */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Only auto-scroll if user is within 80px of the bottom (not reading history)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [messages]);

  /* ── Visible messages ──────────────────────────────────────────── */
  const visibleMessages = useMemo(() => {
    let list = messages;

    if (isTokenMode) {
      list = list.filter((m) => m.tokenId === tokenId);
    } else {
      list = [...list].sort((a, b) => a.timestamp - b.timestamp);
      if (feedFilter !== "All") {
        list = list.filter((m) => detectTag(m.text) === feedFilter);
      }
    }

    return list;
  }, [messages, tokenId, isTokenMode, feedFilter]);

  /* ── Send handler ──────────────────────────────────────────────── */
  const handleSend = useCallback(async () => {
    const trimmed = sanitize(text.trim());
    if (!trimmed || !wallet) return;
    if (trimmed.length > MAX_CHARS) return;

    // Moderation check
    const spamResult = isSpam(trimmed, wallet);
    if (spamResult === "slow-down") {
      if (addToast) addToast("Please wait a few seconds before sending another message", "warning");
      return;
    }
    if (spamResult === "blocked-content") {
      if (addToast) addToast("Message blocked — contains suspicious content", "error");
      return;
    }
    lastMessageTime[wallet] = Date.now();

    if (CHAT_ENABLED) {
      const msg = await sendMessage({
        author: wallet,
        text: trimmed,
        tokenId: isTokenMode ? tokenId : null,
        slug: collection.slug,
      });
      if (msg) {
        // Optimistically add; realtime will deduplicate
        setMessages((prev) =>
          prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
        );
        setText("");
        if (addToast) addToast("Message sent!", "success");
      } else {
        if (addToast) addToast("Failed to send message. Please check your connection and try again.", "error");
      }
    } else {
      // localStorage fallback
      const msg = {
        id: generateId(),
        tokenId: isTokenMode ? tokenId : null,
        author: wallet,
        text: trimmed,
        timestamp: Date.now(),
        likes: [],
      };
      const next = [...messages, msg];
      setMessages(next);
      saveMessages(next, collection.slug);
      setText("");
      if (addToast) addToast("Message sent!", "success");
    }
  }, [text, wallet, tokenId, isTokenMode, messages, addToast, collection.slug]);

  /* ── Like handler ──────────────────────────────────────────────── */
  const handleLike = useCallback(
    async (msgId) => {
      if (!wallet) {
        if (addToast) addToast("Connect wallet to like messages", "info");
        return;
      }

      if (CHAT_ENABLED) {
        const updated = await toggleLike({ messageId: msgId, wallet, slug: collection.slug });
        if (updated) {
          setMessages((prev) =>
            prev.map((m) => (m.id === updated.id ? updated : m))
          );
        }
      } else {
        setMessages((prev) => {
          const next = prev.map((m) => {
            if (m.id !== msgId) return m;
            const already = m.likes.some((w) => w.toLowerCase() === wallet.toLowerCase());
            return {
              ...m,
              likes: already
                ? m.likes.filter((w) => w.toLowerCase() !== wallet.toLowerCase())
                : [...m.likes, wallet],
            };
          });
          saveMessages(next, collection.slug);
          return next;
        });
      }
    },
    [wallet, addToast, collection.slug]
  );

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const charsLeft = MAX_CHARS - text.length;
  const overLimit = charsLeft < 0;
  const canSend = text.trim().length > 0 && !overLimit && !!wallet;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span>
          {isTokenMode ? `# ${collection.name} ${tokenId}` : `${collection.name} Chat`}
        </span>
        <span style={styles.modeIndicator(CHAT_ENABLED)}>
          {CHAT_ENABLED ? "Live" : "Local mode"}
        </span>
      </div>

      {/* Filter tabs (general feed only) */}
      {!isTokenMode && (
        <div style={styles.filterRow}>
          {FEED_TABS.map((tab) => (
            <button
              key={tab}
              style={styles.filterTab(feedFilter === tab)}
              onClick={() => setFeedFilter(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      {/* Message list */}
      <div ref={listRef} style={styles.messageList}>
        {visibleMessages.length === 0 ? (
          <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
            <div className="empty-state-icon">{isTokenMode ? "\uD83D\uDCAC" : "\uD83D\uDDE8\uFE0F"}</div>
            <div className="empty-state-title">
              {isTokenMode
                ? "No Comments Yet"
                : feedFilter !== "All"
                ? `No ${feedFilter} Posts`
                : `Welcome to ${collection.name} Chat`}
            </div>
            <div className="empty-state-text">
              {isTokenMode
                ? "Be the first to leave a comment on this NFT."
                : feedFilter !== "All"
                ? `No ${feedFilter.toLowerCase()} posts have been shared yet.`
                : `Be the first to start a conversation in the ${collection.name} community.`}
            </div>
          </div>
        ) : (
          visibleMessages.map((msg) => {
            const isOwn =
              wallet && msg.author.toLowerCase() === wallet.toLowerCase();
            const liked = wallet && msg.likes.some(l => l.toLowerCase() === wallet.toLowerCase());
            const tag = detectTag(msg.text);

            return (
              <div key={msg.id} style={styles.bubble(isOwn)}>
                <div style={styles.authorRow}>
                  <span style={styles.authorName}>
                    {shortenAddress(msg.author)}
                  </span>
                  <span style={styles.timestamp}>
                    {formatTimeAgo(msg.timestamp)}
                  </span>
                  {tag && (
                    <span
                      style={{
                        ...styles.tag,
                        background: tagColors[tag].bg,
                        color: tagColors[tag].color,
                        border: `1px solid ${tagColors[tag].border}`,
                      }}
                    >
                      {tag}
                    </span>
                  )}
                  {!isTokenMode && msg.tokenId != null && (
                    <span style={styles.tokenBadge}>#{msg.tokenId}</span>
                  )}
                </div>
                <div style={styles.messageText}>{renderMessageText(msg.text, collection.metadataBase, collection.pixelated)}</div>
                <div style={{ ...styles.likeRow, gap: 6 }}>
                  <button
                    style={styles.likeBtn(liked)}
                    onClick={() => handleLike(msg.id)}
                    title={wallet ? (liked ? "Unlike" : "Like") : "Connect wallet to like"}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "scale(1.2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                    }}
                  >
                    {liked ? "\u2764\ufe0f" : "\u2661"}
                  </button>
                  {msg.likes.length > 0 && (
                    <span style={styles.likeCount}>{msg.likes.length}</span>
                  )}
                  {/* Reactions removed — no backend support (schema only has likes array) */}
                  {/* Reply button */}
                  {wallet && (
                    <button
                      onClick={() => {
                        setText(`@${shortenAddress(msg.author)} `);
                        document.querySelector("textarea")?.focus();
                      }}
                      style={{
                        background: "none", border: "none", cursor: "pointer",
                        fontSize: 11, color: "rgba(255,255,255,0.25)", padding: "2px 4px",
                      }}
                      title="Reply"
                    >
                      {"\u21A9"}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input area */}
      <div style={styles.inputArea}>
        {wallet && holderTier ? (
          <>
            <textarea
              style={{
                ...styles.textarea,
                borderColor: overLimit
                  ? "var(--red)"
                  : document.activeElement === document.querySelector("textarea")
                  ? "rgba(200,168,80,0.4)"
                  : "rgba(200,168,80,0.15)",
              }}
              placeholder={
                isTokenMode
                  ? `Comment on this ${collection.name}... Reference NFTs with #1234`
                  : `Share with the ${collection.name} community... Use #alpha, #discussion, or @mention`
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={MAX_CHARS + 20}
            />
            <div style={styles.inputFooter}>
              <span style={styles.charCount(overLimit)}>
                {charsLeft} / {MAX_CHARS}
              </span>
              <button
                style={styles.sendBtn(!canSend)}
                disabled={!canSend}
                onClick={handleSend}
                onMouseEnter={(e) => {
                  if (canSend) e.currentTarget.style.opacity = "0.85";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = "1";
                }}
              >
                Send
              </button>
            </div>
          </>
        ) : wallet && !holderTier ? (
          <div style={{ ...styles.connectPrompt, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <span style={{
              fontSize: 9, fontFamily: "var(--mono)", color: "var(--gold)",
              background: "rgba(212,168,67,0.1)", border: "1px solid rgba(212,168,67,0.2)",
              borderRadius: 4, padding: "2px 8px", letterSpacing: "0.06em",
            }}>HOLDER EXCLUSIVE</span>
            <span style={{ fontSize: 12 }}>Own a {collection.name} to post</span>
          </div>
        ) : (
          <div style={styles.connectPrompt}>
            <button style={styles.connectLink} onClick={onConnect}>
              Connect wallet
            </button>{" "}
            to join the conversation
          </div>
        )}
      </div>
    </div>
  );
}
