import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { deriveChatRef, CHAT_REF_RE } from "./chatRef.js";

const SECRET = "test-secret-not-a-real-one";

describe("chat_ref is a keyed one-way function of the Telegram id", () => {
  it("produces the shape the table's CHECK constraint demands", () => {
    // migration 020: `chat_ref text NOT NULL UNIQUE CHECK (chat_ref ~ '^[0-9a-f]{64}$')`.
    // A mismatch here is a write that fails in production and nowhere else.
    expect(deriveChatRef(SECRET, 12345)).toMatch(CHAT_REF_RE);
    expect(deriveChatRef(SECRET, "12345")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — the same id always reaches the same row", () => {
    expect(deriveChatRef(SECRET, 777)).toBe(deriveChatRef(SECRET, "777"));
  });

  it("separates ids that differ by one, so no two chats share a binding", () => {
    expect(deriveChatRef(SECRET, 1)).not.toBe(deriveChatRef(SECRET, 2));
  });

  it("is KEYED, so the id space cannot be enumerated from a table dump", () => {
    // The whole reason this is an HMAC and not a hash: Telegram ids are small
    // sequential integers, so a plain digest is invertible by counting.
    const plain = createHmac("sha256", "").update("tg:12345").digest("hex");
    expect(deriveChatRef(SECRET, 12345)).not.toBe(plain);
    expect(deriveChatRef("other-secret", 12345)).not.toBe(deriveChatRef(SECRET, 12345));
  });

  it("refuses a non-integer id rather than deriving a ref every such caller shares", () => {
    expect(() => deriveChatRef(SECRET, "")).toThrow();
    expect(() => deriveChatRef(SECRET, "abc")).toThrow();
    expect(() => deriveChatRef(SECRET, {})).toThrow();
  });

  it("refuses to derive without a secret", () => {
    expect(() => deriveChatRef("", 1)).toThrow();
    expect(() => deriveChatRef(undefined, 1)).toThrow();
  });
});
