import { useMemo, useRef, useCallback } from "react";
import NftImage from "./NftImage";

export default function NftMarquee({ tokens, onPick }) {
  const { row1, row2 } = useMemo(() => {
    const withImages = tokens.filter((t) => t.image || t.id != null);
    return {
      row1: withImages.slice(0, 20),
      row2: withImages.slice(20, 40),
    };
  }, [tokens]);

  if (row1.length < 4) return null;

  return (
    <div className="nft-marquee">
      <MarqueeRow items={row1} onPick={onPick} direction="left" />
      {row2.length >= 4 && (
        <MarqueeRow items={row2} onPick={onPick} direction="right" />
      )}
    </div>
  );
}

function MarqueeRow({ items, onPick, direction }) {
  const trackRef = useRef(null);

  const handlePause = useCallback(() => {
    if (trackRef.current) trackRef.current.style.animationPlayState = "paused";
  }, []);

  const handleResume = useCallback(() => {
    if (trackRef.current) trackRef.current.style.animationPlayState = "running";
  }, []);

  return (
    <div
      className="marquee-row"
      onMouseEnter={handlePause}
      onMouseLeave={handleResume}
      onFocus={handlePause}
      onBlur={handleResume}
    >
      <div
        ref={trackRef}
        className={`marquee-track marquee-${direction}`}
      >
        {items.map((nft) => (
          <MarqueeItem key={`a-${nft.id}`} nft={nft} onPick={onPick} />
        ))}
        {items.map((nft) => (
          <MarqueeItem key={`b-${nft.id}`} nft={nft} onPick={onPick} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}

function MarqueeItem({ nft, onPick, "aria-hidden": ariaHidden, ...rest }) {
  return (
    <div
      className="marquee-item"
      onClick={() => onPick?.(nft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick?.(nft);
        }
      }}
      role="button"
      tabIndex={ariaHidden ? -1 : 0}
      aria-label={nft.name}
      aria-hidden={ariaHidden}
      {...rest}
    >
      <NftImage
        nft={nft}
        style={{ width: 36, height: 36, borderRadius: 4, objectFit: "cover" }}
      />
      <div>
        <div className="marquee-item-name">{nft.name}</div>
        {nft.rank && <div className="marquee-item-rank">#{nft.rank}</div>}
      </div>
    </div>
  );
}
