import { describe, it, expect, vi, afterEach } from "vitest";
import { drawCard } from "./ShareCard";
import { SITE_HOST } from "../../lib/constants";

// The share card prints a host along its bottom edge, in the last text it draws. That host
// is the one that served the page, and with no window it is the canonical one.

/** A canvas context that keeps the text drawn on it and accepts every other call. */
function recordingCtx() {
  const texts = [];
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === "fillText") return (text) => { texts.push(text); };
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "createLinearGradient") return () => ({ addColorStop() {} });
      return prop in target ? target[prop] : () => {};
    },
  });
  return { ctx, texts };
}

const NFT = { id: "7", name: "Card #7" };
const COLLECTION = { name: "Gold Cards", supply: 100 };

function hostLine() {
  const { ctx, texts } = recordingCtx();
  drawCard(ctx, null, NFT, COLLECTION);
  return texts.at(-1);
}

describe("the host printed on a share card", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is the host that served the page", () => {
    expect(window.location.host).not.toBe("");
    expect(hostLine()).toBe(window.location.host);
  });

  it("is the canonical host when there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(hostLine()).toBe(SITE_HOST);
  });
});
