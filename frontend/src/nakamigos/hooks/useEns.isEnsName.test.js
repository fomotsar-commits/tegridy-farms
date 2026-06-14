import { describe, it, expect } from "vitest";
import { isEnsName } from "./useEns";

// Guards the new-DM ENS-resolution branch (F737): the input decides between the
// raw 0x-address path and the ENS forward-resolution path purely from this
// classifier, so its boundaries are load-bearing. Lookalike-scam safety relies
// on NOT treating an address (or address-shaped junk) as a name.

describe("isEnsName (F737)", () => {
  it("accepts plain and nested .eth names", () => {
    expect(isEnsName("vitalik.eth")).toBe(true);
    expect(isEnsName("foo.bar.eth")).toBe(true);
    expect(isEnsName("a-b-c.eth")).toBe(true);
    expect(isEnsName("123.eth")).toBe(true);
  });

  it("admits other ENS-bridged TLDs without hardcoding the suffix", () => {
    expect(isEnsName("name.xyz")).toBe(true);
    expect(isEnsName("name.cb.id")).toBe(true);
  });

  it("trims surrounding whitespace and is case-insensitive", () => {
    expect(isEnsName("  Vitalik.ETH  ")).toBe(true);
  });

  it("rejects raw 0x addresses (must take the address path, never resolve)", () => {
    expect(isEnsName("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
    expect(isEnsName("0x")).toBe(false);
    // An address with a trailing .eth-looking suffix must not be mistaken.
    expect(isEnsName("0xdead.eth")).toBe(false);
  });

  it("rejects names with no dot, no TLD, or a 1-char TLD", () => {
    expect(isEnsName("vitalik")).toBe(false);
    expect(isEnsName("vitalik.")).toBe(false);
    expect(isEnsName(".eth")).toBe(false);
    expect(isEnsName("a.b")).toBe(false); // 1-char TLD "b" fails the {2,} rule
    expect(isEnsName("ab.io")).toBe(true); // 2-char label + 2-char TLD both met
    expect(isEnsName("a.b.c")).toBe(false); // final label "c" is 1 char
  });

  it("rejects malformed labels (leading/trailing/double dots, spaces, bad chars)", () => {
    expect(isEnsName("-foo.eth")).toBe(false);
    expect(isEnsName("foo-.eth")).toBe(false);
    expect(isEnsName("foo..eth")).toBe(false);
    expect(isEnsName("foo .eth")).toBe(false);
    expect(isEnsName("foo bar.eth")).toBe(false);
    expect(isEnsName("foo!.eth")).toBe(false);
  });

  it("rejects non-strings and empty input", () => {
    expect(isEnsName("")).toBe(false);
    expect(isEnsName("   ")).toBe(false);
    expect(isEnsName(null)).toBe(false);
    expect(isEnsName(undefined)).toBe(false);
    expect(isEnsName(123)).toBe(false);
    expect(isEnsName({})).toBe(false);
  });
});
