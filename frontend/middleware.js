/**
 * Edge middleware: dynamic OpenGraph cards for Tradermigos URLs.
 *
 * The app is a SPA — every route serves the same index.html, so link-unfurl
 * crawlers (which don't run JS) see only the global site card. This
 * middleware intercepts KNOWN UNFURL BOTS on /nakamigos/* and returns a tiny
 * meta-only HTML document: collection cards with live floor price, and
 * per-NFT cards (name + image + floor) for the ?token=<id> share links the
 * detail modal produces.
 *
 * Humans and JS-rendering crawlers (Google/Bing) fall straight through to
 * the SPA — serving them the stub would hurt UX and SEO. Zero serverless
 * functions added: this runs at the edge and reuses the existing cached
 * /api/alchemy proxy for data.
 */

export const config = {
  matcher: "/nakamigos/:path*",
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

function ogHtml({ title, description, image, url }) {
  const t = esc(title);
  const d = esc(description);
  const i = esc(image);
  const u = esc(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t}</title>
<link rel="canonical" href="${u}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tradermigos">
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

export default async function middleware(req) {
  const ua = req.headers.get("user-agent") || "";
  if (!UNFURL_BOTS.test(ua)) return; // humans + JS crawlers → SPA

  const url = new URL(req.url);
  const origin = url.origin;
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
