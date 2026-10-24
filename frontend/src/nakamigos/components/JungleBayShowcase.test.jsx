// The Jungle Bay page states only what the chain and the collections say.
//
// Its ecosystem map and timeline were written before any of the family
// collections were read, and the reads for this change contradict them:
//   - "Junglets: Hand-painted by core team artist @rodritoh89": the sampled
//     Junglets credit FilthyTrikksEth, puromay, reymushaka and SCREAM.VISION;
//   - "2024: Seeds, Bojungles, Junglets launched": Seeds was deployed on
//     2025-07-15, and no Junglets mint date was read;
//   - "Meme Cards ... with burn mechanics": nothing read supports it.
// And the map named four of the island's six family collections. It now draws
// all six from the registry (name, chain, supply) and links each to its page;
// the timeline keeps only the dates a contract creation proves.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { COLLECTIONS, COLLECTION_LORE } from "../constants";
import { FAMILY_SLUGS, EXPECTED_FAMILY } from "../__fixtures__/jungleBayFamily";

afterEach(() => cleanup());

const text = () => (document.body.textContent || "").replace(/\s+/g, " ");

let everything = "";

/** Render, then open each timeline entry in turn (one opens at a time) and
 *  keep every description that appeared, so a claim cannot hide behind a fold. */
async function renderShowcase() {
  const { default: JungleBayShowcase } = await import("./JungleBayShowcase.jsx");
  render(<MemoryRouter><JungleBayShowcase /></MemoryRouter>);
  everything = text();
  const toggles = () => screen.queryAllByText(/^(EXPAND|COLLAPSE)$/);
  const n = toggles().length;
  for (let i = 0; i < n; i++) {
    fireEvent.click(toggles()[i]);
    everything += " " + text();
  }
}

const CHAIN = { ethereum: "Ethereum", base: "Base", solana: "Solana" };

describe("the ecosystem map", () => {
  it.each(FAMILY_SLUGS)("lists %s by its registry name, chain and supply, linked to its page", async (slug) => {
    await renderShowcase();
    const c = COLLECTIONS[slug] ?? EXPECTED_FAMILY[slug];
    const link = screen.queryAllByRole("link").find((a) => a.getAttribute("href") === `/nakamigos/${slug}`);
    expect(link, `no link to /nakamigos/${slug}`).toBeTruthy();
    expect(link.textContent).toContain(c.name);
    const entry = link.closest("div") ?? link;
    const block = (entry.parentElement ?? entry).textContent;
    expect(block).toContain(CHAIN[c.chain]);
  });

  it("states an ERC-1155's supply as designs and editions", async () => {
    await renderShowcase();
    expect(text()).toMatch(/22 designs, 975 editions/);
    expect(text()).toMatch(/61 designs, 3,529 editions/);
  });

  // Every market link is OpenSea (owner ruling, 2026-10-02). A collection
  // OpenSea does not list names no market, rather than "Trades on undefined".
  it.each(FAMILY_SLUGS)("says where %s trades: here, on OpenSea, or not traded here", async (slug) => {
    await renderShowcase();
    const link = screen.queryAllByRole("link").find((a) => a.getAttribute("href") === `/nakamigos/${slug}`);
    const block = (link.closest("div")?.parentElement ?? link).textContent;
    expect(block).toMatch(/Trades here|Trades on OpenSea|Not traded here/);
    expect(block).not.toMatch(/undefined|null/);
    if (!EXPECTED_FAMILY[slug].market) expect(block).toMatch(/Not traded here/);
  });
});

describe("nothing the reads contradict", () => {
  it("credits no artist the Junglets do not credit", async () => {
    await renderShowcase();
    expect(everything).not.toMatch(/rodritoh89/);
    expect(everything).not.toMatch(/Hand-painted/i);
  });

  it("claims no burn mechanics", async () => {
    await renderShowcase();
    expect(everything).not.toMatch(/burn mechanics/i);
  });

  it("dates Seeds and Bojungles by their contracts, not as a 2024 launch of three", async () => {
    await renderShowcase();
    expect(everything).toMatch(/Seeds|Bojungles/);
    expect(everything).not.toMatch(/Seeds \(369, Base\), Bojungles \(250, Base\), Junglets \(208, Solana\) launched/);
    expect(everything).toMatch(/2025-07-15|Jul(y)? 15, 2025/);
    expect(everything).toMatch(/2024-12-21|Dec(ember)? 21, 2024/);
    expect(everything).toMatch(/2023-02-01|Feb(ruary)? 1, 2023/);
  });

  it("places no contract deployment among the timeline's entries of unknown day", async () => {
    // "Rebranded to Artists Collective" is known only as 2023, so nothing can
    // say whether the memes contract (Feb 1, 2023) came before or after it.
    await renderShowcase();
    const timeline = screen.getByRole("group", { name: /rug-to-riches timeline/i });
    const labels = within(timeline).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.some((l) => /Rebranded to Artists Collective/.test(l))).toBe(true);
    for (const l of labels) expect(l).not.toMatch(/contract deployed/i);
  });

  it("lists the family contract deployments as their own group, in the order of their dates", async () => {
    await renderShowcase();
    const group = screen.getByRole("group", { name: /family contracts/i });
    const labels = within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    const dated = FAMILY_SLUGS.map((s) => COLLECTIONS[s]).filter((c) => c?.deploy?.date);
    expect(labels).toHaveLength(dated.length);
    for (const l of labels) expect(l).toMatch(/contract deployed/);
    const times = labels.map((l) => Date.parse(l.split(": ")[0]));
    for (const t of times) expect(Number.isFinite(t)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("the registry's lore for Jungle Bay carries none of those claims either", () => {
    const eco = JSON.stringify(COLLECTION_LORE.junglebay.ecosystem);
    expect(eco).not.toMatch(/rodritoh89/);
    expect(eco).not.toMatch(/burn mechanics/i);
    expect(eco).not.toMatch(/Hand-painted/i);
  });
});
