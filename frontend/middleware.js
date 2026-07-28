/**
 * Edge middleware: dynamic OpenGraph cards for share links.
 *
 * The app is a SPA — every route serves the same index.html, so link-unfurl
 * crawlers (which don't run JS) see only the global site card. This
 * middleware intercepts KNOWN UNFURL BOTS and returns a tiny meta-only HTML
 * document:
 *   /nakamigos/*  collection cards with live floor price, and per-NFT cards
 *                 (name + image + floor) for ?token=<id> share links.
 *   /scan         token-scan share links (?token=<address>) — the scanner and
 *                 deployer graph both emit "Copy share link" URLs, so without
 *                 this every shared read unfurled as the generic site card.
 *   /deployer     deployer-report share links (?address=<address>).
 *
 * HONESTY RULE for the trust cards: the card states WHAT THE PAGE MEASURES and
 * identifies the subject — it NEVER asserts a verdict, score or band. The real
 * read is computed client-side from holder data that is partly key-gated, so a
 * card claiming "safe"/"concentrated" could contradict the page it links to.
 * Identity (name/symbol) is fetched from a keyless upstream and is factual; if
 * that lookup fails the card degrades to the address alone. Never invent either.
 *
 * Humans and JS-rendering crawlers (Google/Bing) fall straight through to
 * the SPA — serving them the stub would hurt UX and SEO. Zero serverless
 * functions added: this runs at the edge.
 */

export const config = {
  matcher: ["/nakamigos/:path*", "/scan", "/deployer"],
};

// Social unfurlers only — all fetch previews without executing JS.
const UNFURL_BOTS = /twitterbot|discordbot|telegrambot|facebookexternalhit|linkedinbot|slackbot|slack-imgproxy|slack-linkexpanding|whatsapp|embedly|pinterest(bot)?|redditbot|skypeuripreview|vkshare|tumblr/i;

// Inline copy of the supported collections — middleware bundles standalone.
// KEEP IN SYNC with src/nakamigos/constants.js COLLECTIONS.
const COLLECTIONS = {
  nakamigos: {
    name: "Nakamigos",
    contract: "0xd774557b647330C91Bf44cfEAB205095f7E6c367",
    supply: "20,000",
    image: "/splash/skeleton.jpg",
  },
  gnssart: {
    name: "GNSS Art",
    contract: "0xa1De9f93C56C290C48849B1393b09EB616D55dbb",
    supply: "9,696",
    image: "/collections/gnssart.jpg",
  },
  junglebay: {
    name: "Jungle Bay Ape Club",
    contract: "0xd37264c71e9AF940E49795f0D3A8336aFAaFdda9",
    supply: "5,555",
    image: "https://nft-cdn.alchemy.com/eth-mainnet/5da8fc69b3357b9bfe42717280e7c102",
  },
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function fetchJson(url, init, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ogHtml({ title, description, image, url, siteName = "Tradermigos" }) {
  const t = esc(title);
  const d = esc(description);
  const i = esc(image);
  const u = esc(url);
  const s = esc(siteName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t}</title>
<link rel="canonical" href="${u}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${s}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${i}">
<meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${i}">
</head>
<body><a href="${u}">${t}</a></body>
</html>`;
}

function respond(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Unfurls tolerate staleness; keep bot traffic off the data APIs.
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      "X-Robots-Tag": "noindex", // stub is for unfurlers, not search indexes
    },
  });
}

// ── Trust-tool cards (/scan, /deployer) ───────────────────────────────────
//
// These pages compute a DESCRIPTIVE MEASUREMENT client-side, partly from
// key-gated holder data. The card therefore identifies the subject and states
// what the page measures; it never asserts an outcome. See the file header.

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// Solana mints are base58, 32-44 chars — the scanner accepts them too.
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const shortAddr = (a) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/**
 * Factual identity for a token address from GeckoTerminal (keyless, no secret at
 * the edge). Returns { name, symbol } or null. Purely descriptive — never a score.
 */
async function tokenIdentity(address) {
  const network = EVM_ADDRESS_RE.test(address) ? "eth" : "solana";
  const json = await fetchJson(
    `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}`,
    { headers: { Accept: "application/json" } },
  );
  const attrs = json?.data?.attributes;
  if (!attrs) return null;
  const name = typeof attrs.name === "string" ? attrs.name.slice(0, 64) : null;
  const symbol = typeof attrs.symbol === "string" ? attrs.symbol.slice(0, 16) : null;
  return name || symbol ? { name, symbol } : null;
}

async function trustCard(url, origin) {
  const pageUrl = origin + url.pathname + url.search;
  const image = `${origin}/og.png`;
  const siteName = "Tegridy Farms";

  if (url.pathname === "/scan") {
    const token = (url.searchParams.get("token") || "").trim();
    const valid = EVM_ADDRESS_RE.test(token) || SOLANA_MINT_RE.test(token);
    if (!valid) {
      return respond(ogHtml({
        title: "Token Scanner — Tegridy Farms",
        description:
          "Paste any Ethereum or Solana token address for a holder-concentration and distribution read: effective holder count, top-holder shares, every exclusion listed, and a timestamp. A descriptive measurement, not a verdict.",
        image, url: `${origin}/scan`, siteName,
      }));
    }
    const id = await tokenIdentity(token);
    const label = id ? `${id.name || id.symbol}${id.symbol && id.name ? ` (${id.symbol})` : ""}` : shortAddr(token);
    return respond(ogHtml({
      // NO verdict in the title — identity only. The read itself lives on the page.
      title: `${label} — token scan`,
      description:
        "Holder concentration and distribution, measured on-chain: effective holder count, top-holder shares, HHI and Nakamoto, with burns and contracts excluded and every exclusion listed. Open the scan for the full method and timestamp.",
      image, url: pageUrl, siteName,
    }));
  }

  // /deployer
  const address = (url.searchParams.get("address") || "").trim();
  if (!EVM_ADDRESS_RE.test(address)) {
    return respond(ogHtml({
      title: "Deployer Graph — Tegridy Farms",
      description:
        "Look up any wallet to see the tokens it deployed directly and where each one stands today. Gaps are stated plainly — factory-launched tokens and launch-time baselines are not covered.",
      image, url: `${origin}/deployer`, siteName,
    }));
  }
  return respond(ogHtml({
    title: `Deployer report — ${shortAddr(address)}`,
    description:
      "The tokens this wallet deployed directly, and each one's current market state. A descriptive, method-disclosed read — not a fraud verdict — with its gaps stated plainly.",
    image, url: pageUrl, siteName,
  }));
}

export default async function middleware(req) {
  const ua = req.headers.get("user-agent") || "";
  if (!UNFURL_BOTS.test(ua)) return; // humans + JS crawlers → SPA

  const url = new URL(req.url);
  const origin = url.origin;

  // Trust-tool share links (the scanner + deployer graph both emit them).
  if (url.pathname === "/scan" || url.pathname === "/deployer") {
    return trustCard(url, origin);
  }

  const segments = url.pathname.split("/").filter(Boolean); // ["nakamigos", slug?, tab?]
  const slug = segments[1] || "";
  const collection = COLLECTIONS[slug];
  const pageUrl = origin + url.pathname + url.search;

  // /nakamigos landing (or unknown slug): site-level card
  if (!collection) {
    return respond(ogHtml({
      title: "Tradermigos — NFT trading floor",
      description: "Browse, trade, and analyze Nakamigos, GNSS Art & Jungle Bay. P2P swaps settled on Seaport, live floors, rarity, and a 1% flat fee that funds the treasury.",
      image: `${origin}/og.png`,
      url: `${origin}/nakamigos`,
    }));
  }

  const absImage = (img) => (img.startsWith("http") ? img : origin + img);
  const floorData = await fetchJson(
    `${origin}/api/alchemy?endpoint=getFloorPrice&contractAddress=${collection.contract}`
  );
  const floor = floorData?.openSea?.floorPrice;
  const floorTxt = Number.isFinite(floor) ? `Floor ${floor.toFixed(4)} ETH · ` : "";

  // Per-NFT card for share links: /nakamigos/<slug>/<tab>?token=<id>
  const tokenId = url.searchParams.get("token");
  if (tokenId && /^\d{1,10}$/.test(tokenId)) {
    const meta = await fetchJson(
      `${origin}/api/alchemy?endpoint=getNFTMetadataBatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: [{ contractAddress: collection.contract, tokenId }] }),
      }
    );
    const nft = meta?.nfts?.[0];
    const name = nft?.name || `${collection.name} #${tokenId}`;
    const img = nft?.image?.cachedUrl || nft?.image?.thumbnailUrl || nft?.image?.pngUrl || absImage(collection.image);
    return respond(ogHtml({
      title: `${name} — Tradermigos`,
      description: `${floorTxt}${collection.name} · Buy, bid, or send a P2P trade offer on Tradermigos.`,
      image: img,
      url: pageUrl,
    }));
  }

  // Collection card
  return respond(ogHtml({
    title: `${collection.name} — Tradermigos`,
    description: `${floorTxt}${collection.supply} items · Live listings, rarity, P2P trades & wallet DMs on Tradermigos.`,
    image: absImage(collection.image),
    url: pageUrl,
  }));
}
