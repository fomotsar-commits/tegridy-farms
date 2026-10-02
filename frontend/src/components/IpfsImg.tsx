import { useRef, useState, type ImgHTMLAttributes } from 'react';
import { liveIpfsUrl, nextIpfsGatewayUrl } from '../lib/ipfsGateways';
import { useIpfsHangTimer } from '../hooks/useIpfsHangTimer';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> & {
  src: string | null | undefined;
  alt: string;
  /**
   * Nothing left to try: every gateway failed or hung, or a non-IPFS image
   * failed. Hide the image or show a placeholder here.
   */
  onExhausted?: (img: HTMLImageElement) => void;
};

/**
 * A plain `<img>` that may show IPFS content. It starts on a live gateway
 * (ipfs:// and retired-gateway URLs are moved), walks the gateway list on
 * error AND on a hang (useIpfsHangTimer), and calls `onExhausted` when the
 * list runs out. Any other image behaves like a plain `<img>`.
 */
export function IpfsImg({ src, alt, onExhausted, onError, ...rest }: Props) {
  const [from, setFrom] = useState(src);
  const [current, setCurrent] = useState(() => liveIpfsUrl(src));
  if (from !== src) {
    setFrom(src);
    setCurrent(liveIpfsUrl(src));
  }
  const ref = useRef<HTMLImageElement>(null);
  const advance = () => {
    const next = nextIpfsGatewayUrl(current);
    if (next) setCurrent(next);
    else if (ref.current) onExhausted?.(ref.current);
  };
  useIpfsHangTimer(ref, current, { lazy: rest.loading === 'lazy', onHang: advance });
  return (
    <img
      {...rest}
      ref={ref}
      src={current ?? undefined}
      alt={alt}
      onError={(e) => {
        onError?.(e);
        advance();
      }}
    />
  );
}
