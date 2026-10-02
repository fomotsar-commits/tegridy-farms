import { useEffect, useRef, type RefObject } from 'react';
import { isIpfsUri, watchIpfsImg } from '../lib/ipfsGateways';

/**
 * The hang timer for an `<img>` showing IPFS content, shared by NftImage and
 * IpfsImg so every IPFS image on the site moves past a hung gateway the same
 * way (see watchIpfsImg in lib/ipfsGateways.ts). Re-arms whenever `src`
 * changes, so each gateway gets its own budget. `onHang` may change every
 * render; the latest one is called.
 */
export function useIpfsHangTimer(
  ref: RefObject<HTMLImageElement | null>,
  src: string | null | undefined,
  { lazy = false, disabled = false, onHang }: { lazy?: boolean; disabled?: boolean; onHang: () => void },
): void {
  const onHangRef = useRef(onHang);
  useEffect(() => {
    onHangRef.current = onHang;
  });
  useEffect(() => {
    const node = ref.current;
    if (disabled || !node || !isIpfsUri(src)) return undefined;
    return watchIpfsImg(node, { lazy, onHang: () => onHangRef.current() });
  }, [ref, src, lazy, disabled]);
}
