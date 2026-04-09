import { useEffect, useRef, useState, useCallback } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";

const W = 1200, H = 630;
const GOLD = "#c8a850";
const BG_START = "#0a0014";
const BG_END = "#0f1923";

function drawCard(ctx, img, nft, collection) {
  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, BG_START);
  grad.addColorStop(1, BG_END);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Grid pattern overlay
  ctx.strokeStyle = "rgba(200,168,80,0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Left side — NFT image with gold border
  const imgX = 40, imgY = 40, imgSize = H - 80;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(imgX - 3, imgY - 3, imgSize + 6, imgSize + 6);
  if (img) {
    ctx.drawImage(img, imgX, imgY, imgSize, imgSize);
  } else {
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(imgX, imgY, imgSize, imgSize);
  }

  // Right side content area
  const rx = imgX + imgSize + 50;
  const rw = W - rx - 40;

  // Collection name pixel header
  const pixelFont = "'Press Start 2P', monospace";
  ctx.font = `20px ${pixelFont}`;
  ctx.fillStyle = GOLD;
  ctx.fillText(collection.name.toUpperCase(), rx, 80);

  // NFT name
  ctx.font = "bold 36px 'Inter', Arial, sans-serif";
  ctx.fillStyle = "#ffffff";
  const name = nft.name || `${collection.name} #${nft.id}`;
  ctx.fillText(name, rx, 135, rw);

  // Rank badge
  let badgeY = 170;
  if (nft.rank) {
    const rankText = `RANK #${nft.rank}`;
    ctx.font = `bold 16px ${pixelFont}`;
    const tw = ctx.measureText(rankText).width + 28;
    const supply = collection.supply || 10000;
    const goldThreshold = Math.ceil(supply * 0.005);   // top 0.5%
    const blueThreshold = Math.ceil(supply * 0.025);   // top 2.5%
    const badgeColor = nft.rank <= goldThreshold ? GOLD : nft.rank <= blueThreshold ? "#4a7fff" : "#333a48";
    const textColor = nft.rank <= goldThreshold ? "#0a0014" : "#ffffff";
    roundRect(ctx, rx, badgeY - 20, tw, 32, 6, badgeColor);
    ctx.fillStyle = textColor;
    ctx.fillText(rankText, rx + 14, badgeY + 3);
    badgeY += 50;
  }

  if (nft.rarityScore) {
    ctx.font = "14px 'Inter', Arial, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(`Rarity Score: ${nft.rarityScore.toFixed(2)}`, rx, badgeY);
    badgeY += 35;
  }

  // Trait pills
  const traits = (nft.attributes || []).slice(0, 5);
  let pillX = rx, pillY = badgeY + 10;
  ctx.font = "13px 'Inter', Arial, sans-serif";
  traits.forEach((t) => {
    const label = `${t.key || t.trait_type}: ${t.value}`;
    const tw = ctx.measureText(label).width + 24;
    if (pillX + tw > W - 40) { pillX = rx; pillY += 38; }
    roundRect(ctx, pillX, pillY, tw, 28, 14, "rgba(200,168,80,0.12)");
    ctx.strokeStyle = "rgba(200,168,80,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundRectPath(ctx, pillX, pillY, tw, 28, 14);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(label, pillX + 12, pillY + 18);
    pillX += tw + 10;
  });

  // "THE GALLERY" branding
  ctx.font = `11px ${pixelFont}`;
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillText("THE GALLERY", rx, H - 70);

  // Bottom gold bar
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, H - 36, W, 2);
  ctx.font = "13px 'Inter', Arial, sans-serif";
  ctx.fillStyle = "rgba(200,168,80,0.7)";
  ctx.textAlign = "center";
  ctx.fillText(`${collection.slug}.gallery`, W / 2, H - 12);
  ctx.textAlign = "left";
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default function ShareCard({ nft, onClose }) {
  const collection = useActiveCollection();
  const canvasRef = useRef(null);
  const modalRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);

  const render = useCallback(async () => {
    if (!nft) return;
    await document.fonts.ready;
    const canvas = canvasRef.current;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { drawCard(ctx, img, nft, collection); setPreview(canvas.toDataURL("image/png")); setLoading(false); };
    img.onerror = () => { drawCard(ctx, null, nft, collection); setPreview(canvas.toDataURL("image/png")); setLoading(false); };
    img.src = nft.image;
  }, [nft, collection]);

  useEffect(() => { render(); }, [render]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); return; }
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    const closeBtn = modalRef.current?.querySelector('[aria-label="Close modal"]');
    closeBtn?.focus();
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${collection.slug}-${nft.id}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  const handleTwitter = () => {
    const name = nft.name || `${collection.name} #${nft.id}`;
    const rankPart = nft.rank ? ` (Rank #${nft.rank})` : "";
    const text = encodeURIComponent(`Check out my ${name}${rankPart} \u{1F3AE}`);
    window.open(`https://twitter.com/intent/tweet?text=${text}`, "_blank");
  };

  const overlay = {
    position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    background: "rgba(0,0,0,0.85)", backdropFilter: "blur(12px)",
  };
  const panel = {
    background: "rgba(15,25,35,0.9)", border: "1px solid rgba(200,168,80,0.15)",
    borderRadius: 16, padding: 24, maxWidth: 660, width: "90%",
    boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
  };
  const btnBase = {
    padding: "10px 24px", borderRadius: 8, fontWeight: 600, fontSize: 14,
    cursor: "pointer", border: "none", transition: "opacity 0.2s",
  };

  return (
    <div style={overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="Share Card">
      <div ref={modalRef} style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ color: GOLD, fontFamily: "'Press Start 2P', monospace", fontSize: 12 }}>SHARE CARD</span>
          <button onClick={onClose} aria-label="Close modal" style={{ background: "none", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", padding: 4 }}>&times;</button>
        </div>

        <canvas ref={canvasRef} style={{ display: "none" }} />

        {loading ? (
          <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)" }}>
            Generating card...
          </div>
        ) : (
          <img src={preview} alt="Share card preview" style={{ width: "100%", borderRadius: 8, display: "block" }} />
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 16, justifyContent: "center" }}>
          <button onClick={handleDownload} disabled={loading} style={{ ...btnBase, background: GOLD, color: "#0a0014" }}>
            Download PNG
          </button>
          <button onClick={handleTwitter} disabled={loading} style={{ ...btnBase, background: "#1d9bf0", color: "#fff" }}>
            Share on Twitter
          </button>
        </div>
      </div>
    </div>
  );
}
