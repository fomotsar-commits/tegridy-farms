import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";
import NftImage from "./components/NftImage";

// F683: the detail modal and theater request `imageLarge` — commonly a full-res
// IPFS original that 503s or times out while the same token's grid thumbnail is
// loading fine two components away. Before the step-down, one failed large URL
// sent the hero straight to the metadata proxy and, on any miss, to the letter
// placeholder: the modal showed "N #id" for a token whose art was already on
// screen in the grid behind it.

const THUMB = "https://cdn.example/thumb/abc.png";
const LARGE = "https://ipfs.example/ipfs/broken-original.png";

const metadataCalls = [];

beforeEach(() => {
  metadataCalls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    metadataCalls.push(String(url));
    return { ok: false, json: async () => ({}) };
  }));
});

function renderLarge(nft) {
  return render(
    <CollectionProvider slug="nakamigos">
      <NftImage nft={nft} large />
    </CollectionProvider>,
  );
}

describe("NftImage large mode steps down to the grid thumbnail", () => {
  it("shows the thumbnail when the large URL errors, without hitting the metadata proxy", async () => {
    // Ids are unique per test: NftImage's resolved-URL cache is module-level and
    // deliberately outlives a single mount.
    const nft = { id: "700001", name: "Nakamigo #700001", image: THUMB, imageLarge: LARGE };
    renderLarge(nft);

    const img = screen.getByAltText(nft.name);
    expect(img).toHaveAttribute("src", LARGE);

    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByAltText(nft.name)).toHaveAttribute("src", THUMB);
    });
    // The whole point of the step-down is that it costs no request.
    expect(metadataCalls).toEqual([]);
  });

  it("falls through to the metadata proxy only after the thumbnail also fails", async () => {
    const nft = { id: "700002", name: "Nakamigo #700002", image: THUMB, imageLarge: LARGE };
    renderLarge(nft);

    fireEvent.error(screen.getByAltText(nft.name));
    await waitFor(() => {
      expect(screen.getByAltText(nft.name)).toHaveAttribute("src", THUMB);
    });

    fireEvent.error(screen.getByAltText(nft.name));
    await waitFor(() => {
      expect(metadataCalls.some((u) => u.includes("/api/alchemy"))).toBe(true);
    });
    // Both URLs and the proxy are exhausted, so the placeholder is now honest.
    await waitFor(() => {
      expect(screen.getByText(`#${nft.id}`)).toBeInTheDocument();
    });
  });

  it("does not cache the step-down, so a later mount retries the large URL", async () => {
    const nft = { id: "700003", name: "Nakamigo #700003", image: THUMB, imageLarge: LARGE };
    const first = renderLarge(nft);
    fireEvent.error(screen.getByAltText(nft.name));
    await waitFor(() => {
      expect(screen.getByAltText(nft.name)).toHaveAttribute("src", THUMB);
    });
    first.unmount();

    // A success entry in the resolved-URL cache has no TTL, so caching the
    // step-down would pin every later hero and theater view of this token to the
    // low-res thumbnail for the rest of the session over one transient 503.
    renderLarge(nft);
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", LARGE);
  });

  it("leaves the grid path alone: a non-large card goes straight to the proxy", async () => {
    const nft = { id: "700004", name: "Nakamigo #700004", image: THUMB, imageLarge: LARGE };
    render(
      <CollectionProvider slug="nakamigos">
        <NftImage nft={nft} />
      </CollectionProvider>,
    );

    const img = screen.getByAltText(nft.name);
    expect(img).toHaveAttribute("src", THUMB);
    fireEvent.error(img);

    await waitFor(() => {
      expect(metadataCalls.some((u) => u.includes("/api/alchemy"))).toBe(true);
    });
  });

  it("skips the step-down when there is no distinct thumbnail to step down to", async () => {
    const nft = { id: "700005", name: "Nakamigo #700005", image: LARGE, imageLarge: LARGE };
    renderLarge(nft);

    fireEvent.error(screen.getByAltText(nft.name));

    await waitFor(() => {
      expect(metadataCalls.some((u) => u.includes("/api/alchemy"))).toBe(true);
    });
  });
});
