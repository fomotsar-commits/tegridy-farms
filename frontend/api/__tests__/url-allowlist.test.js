// AUDIT R053 unit tests: URL-scheme allowlist + recursive sanitizer.

import { describe, it, expect } from "vitest";
import { isAllowedUri, sanitizeUrlFields } from "../_lib/url-allowlist.js";

describe("isAllowedUri", () => {
  it("allows https://", () => {
    expect(isAllowedUri("https://example.com/img.png")).toBe(true);
  });

  it("allows ipfs://", () => {
    expect(isAllowedUri("ipfs://QmZ123")).toBe(true);
  });

  it("allows ar://", () => {
    expect(isAllowedUri("ar://abc-def")).toBe(true);
  });

  it("allows data:image/png;base64,...", () => {
    expect(isAllowedUri("data:image/png;base64,iVBORw0KGgo")).toBe(true);
  });

  it("rejects javascript:", () => {
    expect(isAllowedUri("javascript:alert(1)")).toBe(false);
  });

  it("rejects http:// (insecure scheme)", () => {
    expect(isAllowedUri("http://insecure.example/img.png")).toBe(false);
  });

  it("rejects file:// and gopher://", () => {
    expect(isAllowedUri("file:///etc/passwd")).toBe(false);
    expect(isAllowedUri("gopher://internal.example/")).toBe(false);
  });

  it("rejects data:image/svg+xml", () => {
    expect(isAllowedUri("data:image/svg+xml;base64,PHN2Zw==")).toBe(false);
  });

  it("rejects data:text/html", () => {
    expect(isAllowedUri("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects empty / null / non-string", () => {
    expect(isAllowedUri("")).toBe(false);
    expect(isAllowedUri(null)).toBe(false);
    expect(isAllowedUri(undefined)).toBe(false);
    expect(isAllowedUri(42)).toBe(false);
  });
});

describe("sanitizeUrlFields", () => {
  it("nulls out disallowed image_url at any depth", () => {
    const obj = {
      listings: [{ nft: { image_url: "javascript:alert(1)", external_url: "https://ok.example" } }],
    };
    sanitizeUrlFields(obj);
    expect(obj.listings[0].nft.image_url).toBeNull();
    expect(obj.listings[0].nft.external_url).toBe("https://ok.example");
  });

  it("preserves allowlisted ipfs / ar / data:image", () => {
    const obj = {
      data: {
        image_url: "ipfs://QmZ123",
        animation_url: "ar://abc",
        display_image_url: "data:image/png;base64,iVBO",
      },
    };
    sanitizeUrlFields(obj);
    expect(obj.data.image_url).toBe("ipfs://QmZ123");
    expect(obj.data.animation_url).toBe("ar://abc");
    expect(obj.data.display_image_url).toBe("data:image/png;base64,iVBO");
  });

  it("does not touch non-URL string fields like description/name", () => {
    const obj = {
      name: "Cool NFT <script>",
      description: "https://this is text not a URL",
      image_url: "javascript:alert(1)",
    };
    sanitizeUrlFields(obj);
    expect(obj.name).toBe("Cool NFT <script>");
    expect(obj.description).toBe("https://this is text not a URL");
    expect(obj.image_url).toBeNull();
  });

  it("handles arrays of objects", () => {
    const obj = [{ image_url: "javascript:1" }, { image_url: "https://ok" }];
    sanitizeUrlFields(obj);
    expect(obj[0].image_url).toBeNull();
    expect(obj[1].image_url).toBe("https://ok");
  });

  it("survives non-object / null gracefully", () => {
    expect(sanitizeUrlFields(null)).toBe(null);
    expect(sanitizeUrlFields("string")).toBe("string");
    expect(sanitizeUrlFields(42)).toBe(42);
  });

  it("recursively cleans deeply nested URL fields", () => {
    const obj = {
      a: { b: { c: { d: { image_url: "javascript:alert(1)" } } } },
    };
    sanitizeUrlFields(obj);
    expect(obj.a.b.c.d.image_url).toBeNull();
  });
});
