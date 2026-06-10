import { describe, it, expect } from "vitest";
import { dmChannelKey, groupConversations } from "./lib/dm";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

const msg = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  channelKey: dmChannelKey(over.sender || A, over.recipient || B),
  sender: A,
  recipient: B,
  text: "hi",
  tradeId: null,
  readAt: null,
  timestamp: 1_000,
  ...over,
});

describe("dmChannelKey", () => {
  it("is order-independent and lowercased with the proxy-safe '_' separator", () => {
    expect(dmChannelKey(A, B)).toBe(`${A}_${B}`);
    expect(dmChannelKey(B, A)).toBe(`${A}_${B}`);
    expect(dmChannelKey(A.toUpperCase(), B)).toBe(`${A}_${B}`);
    expect(dmChannelKey(A, B)).not.toContain(":");
  });
});

describe("groupConversations", () => {
  it("groups by channel, keeps the newest message, sorts threads newest-first", () => {
    const rows = [
      msg({ sender: A, recipient: B, timestamp: 100, text: "old" }),
      msg({ sender: B, recipient: A, timestamp: 300, text: "newest-ab" }),
      msg({ sender: C, recipient: A, channelKey: dmChannelKey(A, C), timestamp: 200, text: "from-c" }),
    ];
    const convos = groupConversations(rows, A);
    expect(convos).toHaveLength(2);
    expect(convos[0].last.text).toBe("newest-ab");
    expect(convos[0].peer).toBe(B);
    expect(convos[1].peer).toBe(C);
  });

  it("counts unread = messages TO me without read_at, regardless of recency", () => {
    const rows = [
      msg({ sender: B, recipient: A, timestamp: 100, readAt: null }),
      msg({ sender: B, recipient: A, timestamp: 200, readAt: "2026-06-10T00:00:00Z" }),
      msg({ sender: B, recipient: A, timestamp: 300, readAt: null }),
      msg({ sender: A, recipient: B, timestamp: 400, readAt: null }), // mine — never unread for me
    ];
    const convos = groupConversations(rows, A);
    expect(convos[0].unread).toBe(2);
    expect(convos[0].last.sender).toBe(A);
  });

  it("returns peers lowercased and handles empty input", () => {
    expect(groupConversations([], A)).toEqual([]);
    const convos = groupConversations([msg({ sender: B.toUpperCase(), recipient: A, timestamp: 5 })], A);
    expect(convos[0].peer).toBe(B);
  });
});
