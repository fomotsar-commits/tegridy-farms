// The tripwire for the message this bot must never fumble.

import { describe, it, expect } from "vitest";
import { detectSecretShape, secretWarning, SECRET_SHAPES } from "./secretGuard.js";

const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("it catches the shapes people actually paste", () => {
  it("a twelve-word phrase", () => {
    expect(detectSecretShape(PHRASE)).toBe(SECRET_SHAPES.MNEMONIC);
  });

  it("a twenty-four-word phrase", () => {
    expect(detectSecretShape(`${PHRASE} ${PHRASE}`)).toBe(SECRET_SHAPES.MNEMONIC);
  });

  it("a phrase pasted with ragged whitespace, which is how a paste arrives", () => {
    expect(detectSecretShape(PHRASE.split(" ").join("\n  "))).toBe(SECRET_SHAPES.MNEMONIC);
  });

  it("a phrase with a preamble in front of it", () => {
    // The version of this guard that checked the WHOLE message against an exact
    // word count missed every one of these, and users paste with a preamble far
    // more often than they paste twelve bare words.
    expect(detectSecretShape(`here is my seed ${PHRASE}`)).toBe(SECRET_SHAPES.MNEMONIC);
    expect(detectSecretShape(`/import ${PHRASE}`)).toBe(SECRET_SHAPES.MNEMONIC);
    expect(detectSecretShape(`${PHRASE} please help`)).toBe(SECRET_SHAPES.MNEMONIC);
  });

  it("a 0x-prefixed 32-byte hex key", () => {
    expect(detectSecretShape(`0x${"a".repeat(64)}`)).toBe(SECRET_SHAPES.HEX_KEY);
  });

  it("a bare 32-byte hex key", () => {
    expect(detectSecretShape("f".repeat(64))).toBe(SECRET_SHAPES.HEX_KEY);
  });

  it("an exported Solana byte array", () => {
    const arr = `[${Array.from({ length: 64 }, (_, i) => i % 256).join(",")}]`;
    expect(detectSecretShape(arr)).toBe(SECRET_SHAPES.KEY_ARRAY);
  });

  it("an 88-character base58 secret key", () => {
    expect(detectSecretShape("z".repeat(88))).toBe(SECRET_SHAPES.BASE58_KEY);
  });
});

describe("it does not cry wolf over the traffic this bot exists to carry", () => {
  it("a command", () => {
    expect(detectSecretShape("/heat 0x71be63f3384f5fb98995898a86b02fb2426c5788")).toBeNull();
  });

  it("an EVM address", () => {
    expect(detectSecretShape("0x71be63f3384f5fb98995898a86b02fb2426c5788")).toBeNull();
  });

  it("a base58 PUBLIC key — 32-44 chars, the normal content of a message here", () => {
    expect(detectSecretShape("So11111111111111111111111111111111111111112")).toBeNull();
  });

  it("a sentence of ordinary English", () => {
    expect(detectSecretShape("hey is the launch live yet or did it get pushed again")).toBeNull();
  });

  it("eleven short words — one under the shortest phrase length", () => {
    expect(detectSecretShape(PHRASE.split(" ").slice(0, 11).join(" "))).toBeNull();
  });

  it("a 64-hex string embedded in a longer token, which is not a standalone key", () => {
    expect(detectSecretShape(`tx:${"a".repeat(64)}:1`)).toBeNull();
  });

  it("nothing at all", () => {
    expect(detectSecretShape("")).toBeNull();
    expect(detectSecretShape(null)).toBeNull();
    expect(detectSecretShape(undefined)).toBeNull();
  });
});

describe("the warning is usable at the moment it is needed", () => {
  it("names the one action that helps, in every branch", () => {
    for (const shape of Object.values(SECRET_SHAPES)) {
      expect(secretWarning(shape)).toMatch(/move everything/i);
    }
  });

  it("says the bot never asks, so the next impostor is recognisable", () => {
    expect(secretWarning(SECRET_SHAPES.MNEMONIC)).toMatch(/never asks/i);
  });

  it("names the false positive for the hex case rather than alarming blindly", () => {
    // A 64-hex string is also a transaction hash. A warning that does not admit
    // that is one users learn to dismiss — including the time it is real.
    expect(secretWarning(SECRET_SHAPES.HEX_KEY)).toMatch(/transaction hash/i);
  });

  it("never contains the matched text, because it is never given it", () => {
    // The signature is the guarantee: `secretWarning` takes a SHAPE, not the
    // message. There is no argument it could echo.
    expect(secretWarning.length).toBe(1);
    for (const shape of Object.values(SECRET_SHAPES)) {
      expect(secretWarning(shape)).not.toContain(PHRASE);
    }
  });
});
